import { Logger } from "pino";
import { AppError, isAppError } from "../domain/errors";
import {
  AppConfig,
  AppRepositories,
  ChannelMappingRow,
  PostPayload,
  PublishPlan,
  TranslationJobRow,
  TranslationPublicationStatus,
  TranslationResult,
} from "../domain/types";
import { MetricsService } from "../monitoring/metrics";
import { AttachmentHandler } from "../publish/attachment-handler";
import { DiscordPublisher } from "../publish/discord-publisher";
import { PublishRenderer } from "../publish/renderer";
import {
  hasMeaningfulText,
  hashSafeSummary,
  isSuspiciousAggregateUntranslatedText,
  isSuspiciousUntranslatedText,
} from "../utils/text";
import { nowIso } from "../utils/time";
import { createId } from "../utils/ids";
import { DeepLClient } from "./deepl-client";
import { GlossaryManager } from "./glossary-manager";
import { TranslationResponseValidator } from "./response-validator";
import { TranslationSegmenter } from "./segmenter";

// Error codes from GlossaryManager that indicate no usable glossary is available.
// When any of these are thrown, translation continues without a glossary.
const GLOSSARY_UNAVAILABLE_CODES = new Set(["GLOSSARY_NOT_CONFIGURED", "GLOSSARY_NOT_READY", "GLOSSARY_PAIR_UNSUPPORTED"]);
// Validation fallback is intentionally scoped to a single block to avoid failing the whole message.
const BLOCK_VALIDATION_FALLBACK_CODES = new Set(["TRANSLATION_TOKEN_MISMATCH", "TRANSLATION_NUMERIC_MISMATCH"]);

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
    let translationStatus: TranslationPublicationStatus = "skipped";

    if (meaningfulText.length > 0) {
      const translationResult = await this.translatePayload(payload, mapping);
      translatedBlocks = translationResult.translatedBlocks;
      billedCharacters = translationResult.billedCharacters;
      translationStatus = this.resolvePublicationStatus(meaningfulText.length, translationResult.validationFallbackBlockCount);
      this.metrics.increment("translationSuccessTotal");
      this.metrics.addBilledCharacters(billedCharacters);
      this.metrics.setLastSuccessfulTranslationAt(nowIso());

      this.logger.info(
        {
          event: "translation_status_resolved",
          raw_message_id: payload.raw_message.message_id,
          mapping_id: payload.mapping_id,
          translation_status: translationStatus,
          meaningful_block_count: meaningfulText.length,
          validation_fallback_block_count: translationResult.validationFallbackBlockCount,
          untranslated_meaningful_block_count: translationResult.untranslatedMeaningfulBlockCount,
          aggregate_untranslated: translationResult.aggregateUntranslated,
        },
        `Translation status resolved: ${translationStatus} (meaningful=${meaningfulText.length}, validation_fallback=${translationResult.validationFallbackBlockCount}, suspicious_blocks=${translationResult.untranslatedMeaningfulBlockCount}, aggregate_untranslated=${translationResult.aggregateUntranslated})`,
      );

      if (translationStatus !== "translated") {
        this.logger.warn(
          {
            event: "translation_not_fully_restored",
            raw_message_id: payload.raw_message.message_id,
            mapping_id: payload.mapping_id,
            translation_status: translationStatus,
            meaningful_block_count: meaningfulText.length,
            validation_fallback_block_count: translationResult.validationFallbackBlockCount,
          },
          "Translation completed with original text still present in published output",
        );
      }
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
      translationStatus,
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
      translationStatus: "fallback_original",
    });

    return this.publishAndPersist(job, mapping, payload, plan, 0, `Fallback publish after translation failure: ${reason}`);
  }

  private async translatePayload(payload: PostPayload, mapping: ChannelMappingRow): Promise<TranslationResult> {
    const meaningfulBlockCount = payload.text_blocks.filter((block) => hasMeaningfulText(block.source_text)).length;
    // Glossary is optional — attempt to get one but fall back to glossary-free
    // translation if none is configured or not yet ready. This ensures messages
    // are always translated rather than blocked by a missing glossary.
    let glossaryId: string | undefined;
    let glossaryVersionId: string | undefined;

    try {
      const glossaryVersion = await this.glossaryManager.ensureUsableGlossary(mapping);
      glossaryId = glossaryVersion.deepl_glossary_id ?? undefined;
      glossaryVersionId = glossaryVersion.glossary_version_id;
    } catch (error) {
      if (isAppError(error) && GLOSSARY_UNAVAILABLE_CODES.has(error.code)) {
        this.logger.info(
          {
            event: "glossary_unavailable_translating_without",
            mapping_id: mapping.mapping_id,
            raw_message_id: payload.raw_message.message_id,
            error_code: error.code,
          },
          "Glossary not available; translating without glossary",
        );
      } else {
        throw error;
      }
    }

    try {
      const initialResult = await this.executeTranslation(payload, mapping, glossaryId, glossaryVersionId, mapping.source_lang);
      if (!this.shouldRetrySuspiciousNoop(initialResult, meaningfulBlockCount)) {
        return initialResult;
      }

      this.logger.warn(
        {
          event: "translation_noop_detected_retrying_autodetect",
          mapping_id: mapping.mapping_id,
          raw_message_id: payload.raw_message.message_id,
          glossary_id: glossaryId ?? null,
          source_lang: mapping.source_lang,
          target_lang: mapping.target_lang,
          untranslated_meaningful_block_count: initialResult.untranslatedMeaningfulBlockCount,
          meaningful_block_count: meaningfulBlockCount,
          aggregate_untranslated: initialResult.aggregateUntranslated,
        },
        `DeepL returned untranslated content; retrying without glossary and with source language autodetect (source=${mapping.source_lang}, target=${mapping.target_lang}, suspicious_blocks=${initialResult.untranslatedMeaningfulBlockCount}, aggregate_untranslated=${initialResult.aggregateUntranslated})`,
      );

      const retryResult = await this.executeTranslation(payload, mapping, undefined, undefined, undefined);
      if (!this.shouldRetrySuspiciousNoop(retryResult, meaningfulBlockCount)) {
        return retryResult;
      }

      this.logger.error(
        {
          event: "translation_noop_detected_publishing_original",
          mapping_id: mapping.mapping_id,
          raw_message_id: payload.raw_message.message_id,
          source_lang: mapping.source_lang,
          target_lang: mapping.target_lang,
          meaningful_block_count: meaningfulBlockCount,
        },
        "DeepL returned effectively untranslated content even after retry; publishing original with error footer",
      );

      return {
        translatedBlocks: new Map(),
        usedGlossaryId: null,
        usedGlossaryVersionId: null,
        billedCharacters: initialResult.billedCharacters + retryResult.billedCharacters,
        detectedSourceLanguage: retryResult.detectedSourceLanguage ?? initialResult.detectedSourceLanguage,
        validationFallbackBlockCount: meaningfulBlockCount,
        untranslatedMeaningfulBlockCount: meaningfulBlockCount,
        aggregateUntranslated: true,
      };
    } catch (error) {
      if (glossaryId && isGlossaryTranslationFailure(error)) {
        this.logger.warn(
          {
            event: "glossary_translate_failed_retrying_without",
            mapping_id: mapping.mapping_id,
            raw_message_id: payload.raw_message.message_id,
            glossary_id: glossaryId,
            error_code: error.code,
            error_message: error.message,
            error_details: error.details,
          },
          "Translation failed because glossary is unavailable; retrying without glossary",
        );
        return await this.executeTranslation(payload, mapping, undefined, undefined, mapping.source_lang);
      }
      throw error;
    }
  }

  private async executeTranslation(
    payload: PostPayload,
    mapping: ChannelMappingRow,
    glossaryId: string | undefined,
    glossaryVersionId: string | undefined,
    sourceLang: string | undefined,
  ): Promise<TranslationResult> {
    const plans = this.segmenter.buildPlans({
      textBlocks: payload.text_blocks,
      sourceLang,
      targetLang: mapping.target_lang,
      glossaryId,
      glossaryVersionId,
      context: this.buildTranslationContext(payload),
    });

    if (plans.length === 0) {
      return {
        translatedBlocks: new Map(),
        usedGlossaryId: glossaryId ?? null,
        usedGlossaryVersionId: glossaryVersionId ?? null,
        billedCharacters: 0,
        detectedSourceLanguage: null,
        validationFallbackBlockCount: 0,
        untranslatedMeaningfulBlockCount: 0,
        aggregateUntranslated: false,
      };
    }

    const translatedBlocks = new Map<string, string>();
    let billedCharacters = 0;
    let detectedSourceLanguage: string | null = null;
    const validationFallbackBlocks = new Set<string>();

    for (const plan of plans) {
      this.logger.info(
        {
          event: "translation_started",
          mapping_id: payload.mapping_id,
          raw_message_id: payload.raw_message.message_id,
          batch_items: plan.items.length,
          source_lang: plan.sourceLang ?? "auto",
          target_lang: plan.targetLang,
          glossary_id: plan.glossaryId ?? null,
        },
        `Starting DeepL translation batch (items=${plan.items.length}, source=${plan.sourceLang ?? "auto"}, target=${plan.targetLang}, glossary=${plan.glossaryId ? "yes" : "no"})`,
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
        const restored = this.validateTranslatedBlock(item, translation.text, payload, mapping, glossaryId);
        if (restored.usedOriginalText) {
          validationFallbackBlocks.add(this.resolveBaseBlockId(item.blockId));
        }
        this.storeTranslatedBlock(translatedBlocks, item.blockId, restored.text);
        billedCharacters += translation.billed_characters ?? item.originalText.length;
        detectedSourceLanguage = detectedSourceLanguage ?? translation.detected_source_language ?? null;
      });
    }

    const meaningfulBlocks = payload.text_blocks
      .filter((block) => hasMeaningfulText(block.source_text))
      .filter((block) => !validationFallbackBlocks.has(block.block_id));

    const untranslatedMeaningfulBlockCount = meaningfulBlocks
      .filter((block) => {
        const translated = translatedBlocks.get(block.block_id);
        if (!translated) {
          return false;
        }

        return isSuspiciousUntranslatedText({
          originalText: block.source_text,
          translatedText: translated,
          targetLang: mapping.target_lang,
        });
      })
      .length;

    const aggregateUntranslated = meaningfulBlocks.length > 0 && isSuspiciousAggregateUntranslatedText({
      originalTexts: meaningfulBlocks.map((block) => block.source_text),
      translatedTexts: meaningfulBlocks.map((block) => translatedBlocks.get(block.block_id) ?? "").filter(Boolean),
      targetLang: mapping.target_lang,
    });

    if (untranslatedMeaningfulBlockCount > 0 || aggregateUntranslated) {
      this.logger.warn(
        {
          event: "translation_noop_blocks_detected",
          mapping_id: mapping.mapping_id,
          raw_message_id: payload.raw_message.message_id,
          glossary_id: glossaryId ?? null,
          source_lang: sourceLang ?? "auto",
          target_lang: mapping.target_lang,
          untranslated_meaningful_block_count: untranslatedMeaningfulBlockCount,
          aggregate_untranslated: aggregateUntranslated,
          original_preview: hashSafeSummary(meaningfulBlocks.map((block) => block.source_text).join("\n\n"), 220),
          translated_preview: hashSafeSummary(meaningfulBlocks.map((block) => translatedBlocks.get(block.block_id) ?? "").join("\n\n"), 220),
        },
        `Some translated blocks are effectively unchanged after DeepL response (aggregate_untranslated=${aggregateUntranslated}, suspicious_blocks=${untranslatedMeaningfulBlockCount})`,
      );
    }

    return {
      translatedBlocks,
      usedGlossaryId: glossaryId ?? null,
      usedGlossaryVersionId: glossaryVersionId ?? null,
      billedCharacters,
      detectedSourceLanguage,
      validationFallbackBlockCount: validationFallbackBlocks.size,
      untranslatedMeaningfulBlockCount,
      aggregateUntranslated,
    };
  }

  private shouldRetrySuspiciousNoop(result: TranslationResult, meaningfulBlockCount: number): boolean {
    return meaningfulBlockCount > 0 && (result.aggregateUntranslated || result.untranslatedMeaningfulBlockCount >= meaningfulBlockCount);
  }

  private validateTranslatedBlock(
    item: { blockId: string; originalText: string; tokenMap: Map<string, string> },
    translatedText: string,
    payload: PostPayload,
    mapping: ChannelMappingRow,
    glossaryId: string | undefined,
  ): { text: string; usedOriginalText: boolean } {
    try {
      return {
        text: this.validator.validateAndRestore({
          originalText: item.originalText,
          translatedText,
          tokenMap: item.tokenMap,
        }),
        usedOriginalText: false,
      };
    } catch (error) {
      if (isAppError(error) && BLOCK_VALIDATION_FALLBACK_CODES.has(error.code)) {
        this.logger.warn(
          {
            event: "translation_block_validation_fallback",
            mapping_id: mapping.mapping_id,
            raw_message_id: payload.raw_message.message_id,
            block_id: item.blockId,
            has_glossary: Boolean(glossaryId),
            error_code: error.code,
            error_message: error.message,
            error_details: error.details,
          },
          "Translation block failed validation; using original block text",
        );
        return {
          text: item.originalText,
          usedOriginalText: true,
        };
      }

      throw error;
    }
  }

  private resolvePublicationStatus(
    meaningfulBlockCount: number,
    validationFallbackBlockCount: number,
  ): TranslationPublicationStatus {
    if (meaningfulBlockCount === 0) {
      return "skipped";
    }

    if (validationFallbackBlockCount === 0) {
      return "translated";
    }

    if (validationFallbackBlockCount >= meaningfulBlockCount) {
      return "fallback_original";
    }

    return "partial_original";
  }

  private resolveBaseBlockId(blockId: string): string {
    const match = blockId.match(/^(.*):part:\d+$/);
    return match?.[1] ?? blockId;
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
    const baseId = this.resolveBaseBlockId(blockId);
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

function isGlossaryTranslationFailure(error: unknown): error is AppError {
  if (!isAppError(error) || error.code !== "DEEPL_TRANSLATE_FAILED") {
    return false;
  }

  const status = typeof error.details?.status === "number" ? error.details.status : undefined;
  const body = typeof error.details?.body === "string" ? error.details.body.toLowerCase() : "";

  if (status !== 400 && status !== 404) {
    return false;
  }

  return body.includes("glossary");
}
