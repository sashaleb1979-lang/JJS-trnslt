import { Logger } from "pino";
import { Client, Message } from "discord.js";
import { AppConfig, AppRepositories } from "../domain/types";
import { diffSeconds, nowIso } from "../utils/time";
import { MessageCanonicalizer } from "../ingest/canonicalizer";
import { MessageFilter } from "../ingest/message-filter";
import { StatusService } from "../monitoring/status-service";

export class GatewayListener {
  private readonly filter = new MessageFilter();
  private readonly canonicalizer = new MessageCanonicalizer();

  constructor(
    private readonly client: Client,
    private readonly repositories: AppRepositories,
    private readonly statusService: StatusService,
    private readonly logger: Logger,
    private readonly config: AppConfig,
  ) {}

  register(): void {
    this.client.on("ready", () => {
      this.statusService.setGatewayState("connected");
      this.logger.info({ event: "discord_ready", user_id: this.client.user?.id }, "Discord client is ready");
    });

    this.client.on("resume", () => {
      this.statusService.setGatewayState("connected");
    });

    this.client.on("shardDisconnect", () => {
      this.statusService.setGatewayState("disconnected");
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessageCreate(message);
    });

    this.client.on("messageDelete", (message) => {
      const output = this.repositories.translatedOutputs.getByPrimaryMessageId(message.id);
      if (output) {
        this.repositories.translatedOutputs.markManualMissingByPrimaryMessageId(message.id);
        this.logger.warn({ event: "translated_message_deleted", primary_message_id: message.id }, "Translated message was deleted manually");
      }
    });
  }

  private async handleMessageCreate(message: Message): Promise<void> {
    if (!message.guildId || message.author.id === this.client.user?.id) {
      return;
    }

    const mapping = this.repositories.channelMappings.getByRawChannelId(message.channelId);
    if (!mapping) {
      return;
    }

    const decision = this.filter.evaluate(message, mapping);
    if (!decision.accepted) {
      this.logger.debug(
        {
          event: "raw_message_rejected",
          raw_message_id: message.id,
          raw_channel_id: message.channelId,
          reason: decision.reason,
        },
        "Message rejected by filter",
      );
      return;
    }

    if (this.repositories.processedRawMessages.exists(message.id)) {
      this.logger.info({ event: "raw_message_duplicate_receive", raw_message_id: message.id }, "Duplicate raw message event ignored");
      return;
    }

    const payload = this.canonicalizer.canonicalize(message, mapping, decision.confidence);

    // Log diagnostic information about the canonicalized message so operators can
    // trace where the text and source label came from.
    const isNativeForward = payload.origin_reference.reference_type === "forwarded";
    const snapshotUsed = isNativeForward && payload.content_text_source === "snapshot";
    const totalCharactersExtracted = payload.text_blocks.reduce((sum, block) => sum + block.source_text.length, 0);
    this.logger.info(
      {
        event: "message_canonicalized",
        raw_message_id: payload.raw_message.message_id,
        accept_reason: decision.reason,
        accepted_as_forwarded: decision.reason === "forwarded_or_shared",
        follow_confidence: decision.confidence,
        reference_type: payload.origin_reference.reference_type,
        is_native_forward: isNativeForward,
        snapshot_used: snapshotUsed,
        extracted_text_source: payload.content_text_source,
        source_label_source: payload.detected_source_label_origin,
        content_is_empty: payload.content.is_empty,
        text_block_count: payload.text_blocks.length,
        total_characters_extracted: totalCharactersExtracted,
        detected_source_label: payload.detected_source_label,
        origin_channel_id: payload.origin_reference.origin_channel_id,
        origin_jump_url: payload.origin_reference.origin_jump_url,
      },
      payload.content.is_empty ?
        "Message canonicalized with empty content — no translatable text blocks found"
      : isNativeForward && !snapshotUsed ?
        "Message canonicalized as native forward but snapshot content was not used — check extracted_text_source"
      : "Message canonicalized",
    );
    const stableDuplicate =
      payload.origin_reference.origin_message_id ?
        this.repositories.processedRawMessages.findStableDuplicate(mapping.mapping_id, payload.checksums.dedupe_key, message.id)
      : null;

    if (stableDuplicate) {
      this.repositories.processedRawMessages.insert({
        rawMessageId: payload.raw_message.message_id,
        mappingId: payload.mapping_id,
        guildId: payload.guild.guild_id,
        rawChannelId: payload.raw_channel.channel_id,
        originMessageId: payload.origin_reference.origin_message_id,
        originChannelId: payload.origin_reference.origin_channel_id,
        originGuildId: payload.origin_reference.origin_guild_id,
        followConfidence: payload.source_markers.follow_confidence,
        payload,
        contentChecksum: payload.checksums.content_checksum,
        dedupeKey: payload.checksums.dedupe_key,
        ingestStatus: "rejected",
        skipReason: "duplicate_origin",
        receivedAt: payload.audit.received_at,
        canonicalizedAt: payload.audit.canonicalized_at,
      });
      this.logger.info(
        {
          event: "duplicate_suppressed",
          raw_message_id: payload.raw_message.message_id,
          duplicate_of: stableDuplicate.raw_message_id,
        },
        "Stable duplicate suppressed",
      );
      return;
    }

    const possibleDuplicate = this.repositories.processedRawMessages.findPossibleDuplicateByChecksum(
      mapping.mapping_id,
      payload.checksums.content_checksum,
      message.id,
      new Date(Date.now() - this.config.sourceDuplicateWindowSeconds * 1000).toISOString(),
    );
    if (possibleDuplicate) {
      this.logger.warn(
        {
          event: "possible_duplicate",
          raw_message_id: payload.raw_message.message_id,
          duplicate_of: possibleDuplicate.raw_message_id,
          seconds_apart: diffSeconds(possibleDuplicate.received_at, nowIso()),
        },
        "Possible duplicate content received",
      );
    }

    this.repositories.processedRawMessages.insert({
      rawMessageId: payload.raw_message.message_id,
      mappingId: payload.mapping_id,
      guildId: payload.guild.guild_id,
      rawChannelId: payload.raw_channel.channel_id,
      originMessageId: payload.origin_reference.origin_message_id,
      originChannelId: payload.origin_reference.origin_channel_id,
      originGuildId: payload.origin_reference.origin_guild_id,
      followConfidence: payload.source_markers.follow_confidence,
      payload,
      contentChecksum: payload.checksums.content_checksum,
      dedupeKey: payload.checksums.dedupe_key,
      ingestStatus: "accepted",
      skipReason: null,
      receivedAt: payload.audit.received_at,
      canonicalizedAt: payload.audit.canonicalized_at,
    });

    this.repositories.translationJobs.enqueue(payload.raw_message.message_id, mapping.mapping_id);
    const jobLogData = {
      event: "job_created",
      raw_message_id: payload.raw_message.message_id,
      mapping_id: mapping.mapping_id,
      accept_reason: decision.reason,
      follow_confidence: decision.confidence,
      mapping_is_paused: mapping.is_paused === 1,
    };
    if (mapping.is_paused === 1) {
      this.logger.warn(
        jobLogData,
        `Translation job created but mapping is PAUSED — job will not be processed until mapping is resumed (pause_reason: ${mapping.pause_reason ?? "unknown"})`,
      );
    } else {
      this.logger.info(jobLogData, "Translation job created");
    }
  }
}
