import { createHash } from "node:crypto";
import { AppError } from "../domain/errors";
import { ChannelMappingRow, GlossaryPreviewResult, GlossaryRuleRow, GlossaryVersionRow } from "../domain/types";
import { buildGlossaryEntriesFromRules } from "../utils/text";
import { nowIso } from "../utils/time";
import { DeepLClient } from "./deepl-client";
import { AppRepositories } from "../domain/types";

export class GlossaryManager {
  // Cache supported pairs to avoid repeated DeepL capability lookups.
  private supportedPairsCache: Set<string> | null = null;

  constructor(
    private readonly repositories: AppRepositories,
    private readonly deepl: DeepLClient,
  ) {}

  async validateLanguagePair(sourceLang: string, targetLang: string): Promise<void> {
    const key = `${sourceLang.toUpperCase()}->${targetLang.toUpperCase()}`;
    if (!this.supportedPairsCache) {
      const pairs = await this.deepl.getSupportedGlossaryPairs();
      this.supportedPairsCache = new Set(
        pairs.map((pair) => `${pair.source_lang.toUpperCase()}->${pair.target_lang.toUpperCase()}`),
      );
    }

    if (!this.supportedPairsCache.has(key)) {
      throw new AppError({
        code: "GLOSSARY_PAIR_UNSUPPORTED",
        message: `Glossary pair ${key} is not supported by DeepL`,
        failureClass: "permanent_config",
      });
    }
  }

  async ensureUsableGlossary(mapping: ChannelMappingRow): Promise<GlossaryVersionRow> {
    await this.validateLanguagePair(mapping.source_lang, mapping.target_lang);
    const versionId = mapping.active_glossary_version_id;
    if (!versionId) {
      throw new AppError({
        code: "GLOSSARY_NOT_CONFIGURED",
        message: "No active glossary version is configured for this mapping",
        failureClass: "permanent_config",
      });
    }

    const version = this.repositories.glossaryVersions.getById(versionId);
    if (!version || !version.deepl_glossary_id || version.sync_status !== "active" || version.deepl_ready !== 1) {
      throw new AppError({
        code: "GLOSSARY_NOT_READY",
        message: "Configured glossary version is not active in DeepL",
        failureClass: "permanent_config",
      });
    }

    return version;
  }

  async syncRulesForPair(input: {
    guildId: string;
    sourceLang: string;
    targetLang: string;
  }): Promise<GlossaryVersionRow> {
    await this.validateLanguagePair(input.sourceLang, input.targetLang);
    const rules = this.repositories.glossaryRules.listActiveByPair(input.guildId, input.sourceLang, input.targetLang);

    if (rules.length === 0) {
      throw new AppError({
        code: "GLOSSARY_EMPTY",
        message: "At least one active glossary rule is required",
        failureClass: "validation",
      });
    }

    const entriesTsv = buildGlossaryEntriesFromRules(
      rules.map((rule) => ({
        sourceTerm: rule.source_term,
        targetTerm: rule.target_term,
        ruleType: rule.rule_type,
      })),
    );
    const checksum = this.hash(entriesTsv);
    const active = this.repositories.glossaryVersions.getActiveByPair(input.guildId, input.sourceLang, input.targetLang);
    if (active?.entries_checksum === checksum && active.deepl_glossary_id) {
      return active;
    }

    const pending = this.repositories.glossaryVersions.createPending({
      guildId: input.guildId,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      compiledEntriesTsv: entriesTsv,
      entriesChecksum: checksum,
      entryCount: rules.length,
    });

    try {
      const created = await this.deepl.createGlossary({
        name: `guild-${input.guildId}-${input.sourceLang}-${input.targetLang}-${pending.version_no}`,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        entriesTsv,
      });
      this.repositories.glossaryVersions.activate(pending.glossary_version_id, created.glossaryId);
      return this.repositories.glossaryVersions.getById(pending.glossary_version_id)!;
    } catch (error) {
      this.repositories.glossaryVersions.markFailed(
        pending.glossary_version_id,
        error instanceof Error ? error.message : "Unknown DeepL glossary sync error",
      );
      throw error;
    }
  }

  preview(text: string, rules: GlossaryRuleRow[], activeGlossaryVersionId: string | null): GlossaryPreviewResult {
    const matchedRules = rules.filter((rule) => new RegExp(`\\b${escapeRegExp(rule.source_term)}\\b`, "i").test(text));
    let previewText = text;

    for (const rule of matchedRules) {
      if (rule.rule_type === "preserve") {
        continue;
      }
      previewText = previewText.replace(new RegExp(`\\b${escapeRegExp(rule.source_term)}\\b`, "gi"), rule.target_term ?? rule.source_term);
    }

    return {
      glossaryVersionId: activeGlossaryVersionId,
      matchedRules,
      previewText,
    };
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
