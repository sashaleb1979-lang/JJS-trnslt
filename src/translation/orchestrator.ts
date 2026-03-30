import { Logger } from "pino";
import { AppError } from "../domain/errors";
import { AppConfig, AppRepositories, ChannelMappingRow, PostPayload, PublishPlan, TranslationJobRow, TranslationResult } from "../domain/types";
import { MetricsService } from "../monitoring/metrics";
import { AttachmentHandler } from "../publish/attachment-handler";
import { DiscordPublisher } from "../publish/discord-publisher";
import { PublishRenderer } from "../publish/renderer";
import { hasMeaningfulText, hashSafeSummary } from "../utils/text";
import { nowIso } from "../utils/time";
import { createId } from "../utils/ids";
import { DeepLClient } from "./deepl-client";
import { GlossaryManager } from "./glossary-manager";
import { TranslationResponseValidator } from "./response-validator";
import { TranslationSegmenter } from "./segmenter";

export interface OrchestrationResult {
  type: "published" | "duplicate" | "skipped";
  outputMessageIds?: string[];
  billedCharacters?: number;
  summary: string;
}

export class TranslationOrchestrator {
  private readonly segmenter = new TranslationSegmenter();
  private readonly validator = new TranslationResponseValidator();

  constructor(
    private readonly repositories: AppRepositories,
    private readonly deepl: DeepLClient,
    private readonly glossaryManager: GlossaryManager,
    private readonly renderer: PublishRenderer,
    private readonly publisher: DiscordPublisher,
    private readonly attachmentHandler: AttachmentHandler,
    private readonly metrics: MetricsService,
    private readonly logger: Logger,
    private readonly config: AppConfig,
  ) {}

  async process(job: TranslationJobRow): Promise<OrchestrationResult> {
    const rawRecord = this.repositories.processedRawMessages.getByRawMessageId(job.raw_message_id);
    if (!rawRecord) {
      throw new AppError({
        code: "RAW_RECORD_MISSING",
        message: "Raw message record is missing",
        failureClass: "permanent_config",
      });
    }

    const mapping = this.repositories.channelMappings.getByMappingId(job.mapping_id);
    if (!mapping) {
      throw new AppError({
        code: "MAPPING_MISSING",
        message: "Channel mapping is missing",
        failureClass: "permanent_config",
      });
    }

    const existingOutput = this.repositories.translatedOutputs.getByRawMessageId(job.raw_message_id);
    if (existingOutput) {
      return {
        type: "duplicate",
        outputMessageIds: JSON.parse(existingOutput.all_message_ids_json) as string[],
        summary: "Output already exists",
      };
    }

    const payload = JSON.parse(rawRecord.canonical_payload_json) as PostPayload;
    const media = await this.attachmentHandler.prepare(payload.attachments, mapping.media_mode);
    const meaningfulText = payload.text_blocks.filter((block) => hasMeaningfulText(block.source_text));

    let translatedBlocks = new Map<string, string>();
    let billedCharacters = 0;

    if (meaningfulText.length > 0) {
      const translationResult = await this.translatePayload(payload, mapping);
      translatedBlocks = translationResult.translatedBlocks;
      billedCharacters = translationResult.billedCharacters;
      this.metrics.increment("translationSuccessTotal");
      this.metrics.addBilledCharacters(billedCharacters);
      this.metrics.setLastSuccessfulTranslationAt(nowIso());
    } else {
      // No meaningful text blocks – translation skipped. Log this prominently for
      // forwarded messages so operators can trace extraction failures.
      const isForwarded = payload.origin_reference.reference_type === "forwarded" ||
        payload.origin_reference.reference_type === "follow_crosspost";
      const skipLogData = {
        event: "translation_skipped_no_meaningful_text",
        raw_message_id: payload.raw_message.message_id,
        mapping_id: payload.mapping_id,
        is_forwarded: isForwarded,
        text_block_count: payload.text_blocks.length,
        extracted_text_source: payload.content_text_source,
      };
      const skipMessage =
        isForwarded ?
          "Translation skipped — forwarded message has no meaningful text blocks; check extracted_text_source"
        : "Translation skipped — no meaningful text blocks found";
      if (isForwarded) {
        this.logger.warn(skipLogData, skipMessage);
      } else {
        this.logger.info(skipLogData, skipMessage);
      }
    }

    const plan = this.renderer.buildPlan({
      payload,
      mapping,
      translatedBlocks,
      media,
      fallbackOriginal: false,
    });

    return this.publishAndPersist(job, mapping, payload, plan, billedCharacters);
  }

  async publishOriginalFallback(job: TranslationJobRow, reason: string): Promise<OrchestrationResult> {
    const rawRecord = this.repositories.processedRawMessages.getByRawMessageId(job.raw_message_id);
    if (!rawRecord) {
      throw new AppError({
        code: "RAW_RECORD_MISSING",
        message: "Raw message record is missing",
        failureClass: "permanent_config",
      });
    }

    const mapping = this.repositories.channelMappings.getByMappingId(job.mapping_id);
    if (!mapping) {
      throw new AppError({
        code: "MAPPING_MISSING",
        message: "Channel mapping is missing",
        failureClass: "permanent_config",
      });
    }

    const payload = JSON.parse(rawRecord.canonical_payload_json) as PostPayload;
    // Use source_text as "translation" so the renderer can display the original content.
    const translatedBlocks = new Map<string, string>(payload.text_blocks.map((block) => [block.block_id, block.source_text]));
    const media = await this.attachmentHandler.prepare(payload.attachments, mapping.media_mode);

    this.logger.warn(
      {
        event: "fallback_original_publish",
        raw_message_id: payload.raw_message.message_id,
        mapping_id: payload.mapping_id,
        fallback_reason: reason,
        text_block_count: payload.text_blocks.length,
        extracted_text_source: payload.content_text_source,
        reference_type: payload.origin_reference.reference_type,
      },
      "Publishing original (untranslated) content as fallback after translation failure",
    );

    const plan = this.renderer.buildPlan({
      payload,
      mapping,
      translatedBlocks,
      media,
      fallbackOriginal: true,
    });

    return this.publishAndPersist(job, mapping, payload, plan, 0, `Fallback publish after translation failure: ${reason}`);
  }

  private async translatePayload(payload: PostPayload, mapping: ChannelMappingRow): Promise<TranslationResult> {
    const glossaryVersion = await this.glossaryManager.ensureUsableGlossary(mapping);
    const plans = this.segmenter.buildPlans({
      textBlocks: payload.text_blocks,
      sourceLang: mapping.source_lang,
      targetLang: mapping.target_lang,
      glossaryId: glossaryVersion.deepl_glossary_id!,
      glossaryVersionId: glossaryVersion.glossary_version_id,
      context: this.buildTranslationContext(payload),
    });

    if (plans.length === 0) {
      return {
        translatedBlocks: new Map(),
        usedGlossaryId: glossaryVersion.deepl_glossary_id!,
        usedGlossaryVersionId: glossaryVersion.glossary_version_id,
        billedCharacters: 0,
        detectedSourceLanguage: null,
      };
    }

    const translatedBlocks = new Map<string, string>();
    let billedCharacters = 0;
    let detectedSourceLanguage: string | null = null;

    for (const plan of plans) {
      this.logger.info(
        {
          event: "translation_started",
          mapping_id: payload.mapping_id,
          raw_message_id: payload.raw_message.message_id,
          batch_items: plan.items.length,
        },
        "Starting DeepL translation batch",
      );

      const response = await this.deepl.translate(plan);
      if (response.translations.length !== plan.items.length) {
        throw new AppError({
          code: "DEEPL_RESULT_COUNT_MISMATCH",
          message: "DeepL returned fewer translation items than requested",
          retryable: true,
        });
      }

      response.translations.forEach((translation, index) => {
        const item = plan.items[index];
        const restored = this.validator.validateAndRestore({
          originalText: item.originalText,
          translatedText: translation.text,
          tokenMap: item.tokenMap,
        });
        this.storeTranslatedBlock(translatedBlocks, item.blockId, restored);
        billedCharacters += translation.billed_characters ?? item.originalText.length;
        detectedSourceLanguage = detectedSourceLanguage ?? translation.detected_source_language ?? null;
      });
    }

    return {
      translatedBlocks,
      usedGlossaryId: glossaryVersion.deepl_glossary_id!,
      usedGlossaryVersionId: glossaryVersion.glossary_version_id,
      billedCharacters,
      detectedSourceLanguage,
    };
  }

  private async publishAndPersist(
    job: TranslationJobRow,
    mapping: ChannelMappingRow,
    payload: PostPayload,
    plan: PublishPlan,
    billedCharacters: number,
    overrideSummary?: string,
  ): Promise<OrchestrationResult> {
    const publishResult = await this.publisher.publish(mapping.output_channel_id, plan);
    this.repositories.translatedOutputs.insertOrReplace({
      outputId: createId("out"),
      rawMessageId: job.raw_message_id,
      mappingId: job.mapping_id,
      outputChannelId: mapping.output_channel_id,
      primaryMessageId: publishResult.primaryMessageId,
      allMessageIds: publishResult.allMessageIds,
      renderModeUsed: publishResult.mode,
      publishedStatus: "published",
      publishedPayload: plan,
    });

    this.metrics.increment("publishSuccessTotal");
    this.metrics.increment("jobsProcessedTotal");

    this.logger.info(
      {
        event: "publish_completed",
        mapping_id: mapping.mapping_id,
        raw_message_id: payload.raw_message.message_id,
        output_message_id: publishResult.primaryMessageId,
        output_count: publishResult.allMessageIds.length,
        billed_characters: billedCharacters,
      },
      "Publish completed",
    );

    return {
      type: "published",
      outputMessageIds: publishResult.allMessageIds,
      billedCharacters,
      summary: overrideSummary ?? `Published ${publishResult.allMessageIds.length} message(s)`,
    };
  }

  private storeTranslatedBlock(map: Map<string, string>, blockId: string, translatedText: string): void {
    const match = blockId.match(/^(.*):part:\d+$/);
    const baseId = match?.[1] ?? blockId;
    const existing = map.get(baseId);
    map.set(baseId, existing ? `${existing}\n\n${translatedText}` : translatedText);
  }

  private buildTranslationContext(payload: PostPayload): string {
    const parts = [
      `Source label: ${payload.detected_source_label}`,
      payload.embeds[0]?.title ? `Embed title: ${payload.embeds[0].title}` : "",
      payload.content.normalized_text ? hashSafeSummary(payload.content.normalized_text, 300) : "",
    ].filter(Boolean);
    return parts.join("\n");
  }
}
