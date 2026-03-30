import { Message, MessageSnapshot } from "discord.js";
import { ChannelMappingRow, PostPayload } from "../domain/types";
import { nowIso } from "../utils/time";
import { extractUrls, normalizeWhitespace } from "../utils/text";
import { buildContentChecksum, buildDedupeKey } from "./checksum";
import { detectSourceLabel } from "./source-label";
import { getFirstSnapshot, hasMessageSnapshots } from "./message-filter";

export class MessageCanonicalizer {
  canonicalize(message: Message, mapping: ChannelMappingRow, followConfidence: "high" | "medium" | "low"): PostPayload {
    const receivedAt = nowIso();
    const canonicalizedAt = nowIso();

    // ------------------------------------------------------------------ //
    // Native Discord forwards (2024+): the actual message content lives   //
    // in the first message snapshot, NOT in message.content / embeds.     //
    // ------------------------------------------------------------------ //
    const isNativeForward = hasMessageSnapshots(message);
    const snapshot: MessageSnapshot | undefined = isNativeForward ? getFirstSnapshot(message) : undefined;

    // Guard: hasMessageSnapshots() said there is a snapshot, but getFirstSnapshot()
    // returned undefined. This can happen when discord.js fails to build the snapshot
    // Collection (e.g. message_reference is absent in the gateway payload even though
    // message_snapshots is present). Fall back gracefully to outer message content.
    const snapshotRetrieved = isNativeForward && snapshot !== undefined;

    // "Effective" content: snapshot text takes priority for native forwards.
    // The outer message.content may carry an optional forwarder comment which
    // we append as a secondary block below.
    const snapshotText = snapshot ? normalizeWhitespace(snapshot.content ?? "") : "";
    const outerContentText = normalizeWhitespace(message.content ?? "");

    // Primary text for the `content` field is the snapshot body (if native
    // forward) or the regular outer content.
    // NOTE: When snapshotRetrieved is true but snapshotText is empty (embed-only
    // original message), primaryContentText is intentionally left as "" — the embeds
    // carry the actual content and the forwarder's outer comment (if any) is appended
    // as a separate "forwarder_comment" block below.  Falling back to outerContentText
    // here would duplicate it since forwarderComment already includes outerContentText.
    // When snapshotRetrieved is false (snapshot expected but missing), we fall back to
    // outerContentText as a best-effort so the message body is not silently dropped.
    const primaryContentText = snapshotRetrieved ? snapshotText : outerContentText;

    // Effective embeds: use snapshot embeds for native forwards; fall back to
    // the message's own embeds for crosspost / follow / shared messages.
    // If the snapshot was expected but not retrieved, also fall back to message embeds.
    const effectiveEmbeds = snapshotRetrieved && snapshot ? snapshot.embeds : message.embeds;

    const embeds = effectiveEmbeds.map((embed, index) => ({
      embed_index: index,
      type: embed.data.type ?? "rich",
      title: embed.title ?? null,
      description: embed.description ?? null,
      fields: (embed.fields ?? []).map((field) => ({
        name: field.name,
        value: field.value,
        inline: field.inline ?? false,
      })),
      footer_text: embed.footer?.text ?? null,
      author_name: embed.author?.name ?? null,
      url: embed.url ?? null,
      image_url: embed.image?.url ?? embed.thumbnail?.url ?? null,
    }));

    // Effective attachments: snapshot attachments for native forwards, else message attachments.
    const effectiveAttachmentCollection = snapshotRetrieved && snapshot ? snapshot.attachments : message.attachments;
    const attachments = effectiveAttachmentCollection.map((attachment) => ({
      attachment_id: attachment.id,
      filename: attachment.name ?? attachment.id,
      content_type: attachment.contentType ?? null,
      size_bytes: attachment.size,
      url: attachment.url,
      proxy_url: attachment.proxyURL ?? null,
      is_image: attachment.contentType?.startsWith("image/") ?? false,
      is_spoiler: attachment.spoiler,
    }));

    const outputChannel = message.guild?.channels.cache.get(mapping.output_channel_id);
    const rawFlags = Array.from(message.flags.toArray(), (flag) => flag.toString());

    // ------------------------------------------------------------------ //
    // Source label: for native forwards we try to resolve the origin      //
    // channel name rather than using the forwarder's username.            //
    // For cross-guild forwards the channel won't be in our guild cache,   //
    // so we also pass the origin guild name as a secondary attribution.   //
    // ------------------------------------------------------------------ //
    const originChannelId = message.reference?.channelId ?? null;
    const originChannelRaw = originChannelId ? message.guild?.channels.cache.get(originChannelId) : undefined;
    const originChannelName = originChannelRaw && "name" in originChannelRaw ? (originChannelRaw.name ?? null) : null;

    // Build the jump URL for the original message if we have full coordinates.
    const originGuildId = message.reference?.guildId ?? null;
    const originMessageId = message.reference?.messageId ?? null;
    const originJumpUrl =
      originGuildId && originChannelId && originMessageId ?
        `https://discord.com/channels/${originGuildId}/${originChannelId}/${originMessageId}`
      : null;

    const sourceLabelResult = detectSourceLabel({
      mapping,
      authorName: message.author.username,
      embedAuthorName: embeds[0]?.author_name ?? null,
      embedFooterText: embeds[0]?.footer_text ?? null,
      isForwardedMessage: isNativeForward,
      originChannelName,
      // originGuildName is not available from the gateway payload for cross-guild
      // forwards; embed author/footer metadata is used as fallback instead.
      originGuildName: null,
    });

    // ------------------------------------------------------------------ //
    // Text blocks and content diagnostics                                 //
    // ------------------------------------------------------------------ //
    // For native forwards, the forwarder comment is the outer content; it is only
    // added as a secondary block if it's non-empty (forwarder added their own note).
    const forwarderComment = snapshotRetrieved && outerContentText ? outerContentText : null;
    const textBlocks = this.extractTextBlocks(primaryContentText, embeds, forwarderComment);

    // Determine the diagnostic content_text_source for logging.
    let contentTextSource: PostPayload["content_text_source"];
    if (isNativeForward) {
      if (!snapshotRetrieved) {
        // Snapshot was expected (hasMessageSnapshots=true) but could not be built.
        // We fell back to outer message content or embeds.
        contentTextSource = outerContentText ? "message_content" : embeds.length > 0 ? "embeds_only" : "empty";
      } else if (snapshotText) {
        contentTextSource = "snapshot";
      } else if (embeds.length > 0) {
        contentTextSource = "embeds_only";
      } else {
        contentTextSource = "empty";
      }
    } else {
      if (outerContentText) {
        contentTextSource = "message_content";
      } else if (embeds.length > 0) {
        contentTextSource = "embeds_only";
      } else {
        contentTextSource = "empty";
      }
    }

    const payload: PostPayload = {
      schema_version: 1,
      mapping_id: mapping.mapping_id,
      guild: {
        guild_id: message.guildId!,
        guild_name: message.guild?.name ?? "Unknown guild",
        locale: message.guild?.preferredLocale ?? null,
      },
      raw_channel: {
        channel_id: message.channelId,
        channel_name: "name" in message.channel ? (message.channel.name ?? "raw-follow") : "raw-follow",
        channel_type: String(message.channel.type),
      },
      output_channel: {
        channel_id: mapping.output_channel_id,
        channel_name: outputChannel && "name" in outputChannel ? (outputChannel.name ?? "translated") : "translated",
        channel_type: outputChannel ? String(outputChannel.type) : "unknown",
      },
      raw_message: {
        message_id: message.id,
        message_type: String(message.type),
        webhook_id: message.webhookId ?? null,
        application_id: message.applicationId ?? null,
        author_id: message.author.id,
        author_name: message.author.username,
        is_webhook: Boolean(message.webhookId),
        flags: rawFlags,
        jump_url: message.url,
        timestamp: message.createdAt.toISOString(),
        edited_timestamp: message.editedAt?.toISOString() ?? null,
      },
      origin_reference: {
        origin_guild_id: originGuildId,
        origin_channel_id: originChannelId,
        origin_message_id: originMessageId,
        origin_jump_url: originJumpUrl,
        reference_type: isNativeForward ? "forwarded" : message.reference ? "follow_crosspost" : null,
      },
      source_markers: {
        has_webhook_id: Boolean(message.webhookId),
        has_message_reference: Boolean(message.reference),
        has_mention_channels: message.mentions.channels.size > 0,
        follow_confidence: followConfidence,
      },
      content: {
        raw_text: snapshotRetrieved ? (snapshot?.content ?? "") : (message.content ?? ""),
        normalized_text: primaryContentText,
        is_empty: !primaryContentText,
      },
      embeds,
      attachments,
      urls: [
        ...extractUrls(primaryContentText).map((url) => ({ url, source: "content" as const, kind: "external_link" as const })),
        ...embeds
          .flatMap((embed) => [embed.url, embed.image_url].filter(Boolean))
          .map((url) => ({ url: url!, source: "embed" as const, kind: "external_link" as const })),
        ...attachments.map((attachment) => ({
          url: attachment.url,
          source: "attachment" as const,
          kind: attachment.is_image ? ("image" as const) : ("attachment" as const),
        })),
      ],
      mentions: {
        user_ids: message.mentions.users.map((user) => user.id),
        role_ids: message.mentions.roles.map((role) => role.id),
        channel_ids: message.mentions.channels.map((channel) => channel.id),
        mention_everyone: message.mentions.everyone,
      },
      text_blocks: textBlocks,
      detected_source_label: sourceLabelResult.label,
      detected_source_label_origin: sourceLabelResult.origin,
      content_text_source: contentTextSource,
      translation: {
        status: "pending",
        source_lang_configured: mapping.source_lang,
        target_lang: mapping.target_lang,
        glossary_required: true,
        glossary_version_id: mapping.active_glossary_version_id,
        attempt: 0,
      },
      checksums: {
        content_checksum: buildContentChecksum(message),
        dedupe_key: "",
      },
      audit: {
        received_at: receivedAt,
        canonicalized_at: canonicalizedAt,
      },
    };

    payload.checksums.dedupe_key = buildDedupeKey(payload);
    return payload;
  }

  /**
   * Build the ordered list of translatable text blocks.
   *
   * @param primaryContentText - The main body text (from snapshot or message.content).
   * @param embeds             - Canonicalized embeds (already resolved from snapshot or message).
   * @param forwarderComment   - Optional outer message content when the primary text comes from a
   *                            snapshot (i.e. the forwarder added their own note). Appended as a
   *                            separate block so it is translated but clearly distinguished.
   */
  private extractTextBlocks(
    primaryContentText: string,
    embeds: PostPayload["embeds"],
    forwarderComment: string | null = null,
  ): PostPayload["text_blocks"] {
    const blocks: PostPayload["text_blocks"] = [];

    if (primaryContentText) {
      blocks.push({
        block_id: "content:0",
        block_type: "content_body",
        source_text: primaryContentText,
        preserve_markdown: true,
      });
    }

    for (const embed of embeds) {
      if (embed.title) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:title`,
          block_type: "embed_title",
          source_text: embed.title,
          preserve_markdown: false,
        });
      }
      if (embed.description) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:desc`,
          block_type: "embed_description",
          source_text: embed.description,
          preserve_markdown: true,
        });
      }
      if (embed.author_name) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:author`,
          block_type: "embed_author",
          source_text: embed.author_name,
          preserve_markdown: false,
        });
      }
      if (embed.footer_text) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:footer`,
          block_type: "embed_footer",
          source_text: embed.footer_text,
          preserve_markdown: false,
        });
      }
      embed.fields.forEach((field, index) => {
        if (field.name) {
          blocks.push({
            block_id: `embed:${embed.embed_index}:field:${index}:name`,
            block_type: "embed_field_name",
            source_text: field.name,
            preserve_markdown: false,
          });
        }
        if (field.value) {
          blocks.push({
            block_id: `embed:${embed.embed_index}:field:${index}:value`,
            block_type: "embed_field_value",
            source_text: field.value,
            preserve_markdown: true,
          });
        }
      });
    }

    // Forwarder's optional comment (the text they typed when forwarding the message).
    // Appended last so the translated output leads with the original content.
    if (forwarderComment) {
      blocks.push({
        block_id: "content:forwarder_comment",
        block_type: "content_body",
        source_text: forwarderComment,
        preserve_markdown: true,
      });
    }

    return blocks;
  }
}
