import Database from "better-sqlite3";
import { GlossaryVersionRow } from "../../domain/types";
import { createId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

export class GlossaryVersionsRepository {
  constructor(private readonly db: Database.Database) {}

  getActiveByPair(guildId: string, sourceLang: string, targetLang: string): GlossaryVersionRow | null {
    return (
      this.db
        .prepare<string[], GlossaryVersionRow>(
          `SELECT * FROM glossary_versions
           WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND sync_status = 'active'
           ORDER BY version_no DESC LIMIT 1`,
        )
        .get(guildId, sourceLang, targetLang) ?? null
    );
  }

  getById(glossaryVersionId: string): GlossaryVersionRow | null {
    return (
      this.db
        .prepare<string, GlossaryVersionRow>("SELECT * FROM glossary_versions WHERE glossary_version_id = ?")
        .get(glossaryVersionId) ?? null
    );
  }

  getNextVersionNo(guildId: string, sourceLang: string, targetLang: string): number {
    const row = this.db
      .prepare<string[], { maxVersion: number | null }>(
        "SELECT MAX(version_no) AS maxVersion FROM glossary_versions WHERE guild_id = ? AND source_lang = ? AND target_lang = ?",
      )
      .get(guildId, sourceLang, targetLang);
    return (row?.maxVersion ?? 0) + 1;
  }

  createPending(input: {
    guildId: string;
    sourceLang: string;
    targetLang: string;
    compiledEntriesTsv: string;
    entriesChecksum: string;
    entryCount: number;
  }): GlossaryVersionRow {
    const glossaryVersionId = createId("glv");
    const versionNo = this.getNextVersionNo(input.guildId, input.sourceLang, input.targetLang);
    const now = nowIso();

    this.db
      .prepare(
        `INSERT INTO glossary_versions (
          glossary_version_id, guild_id, source_lang, target_lang, version_no, compiled_entries_tsv,
          entries_checksum, deepl_glossary_id, deepl_ready, sync_status, entry_count, created_at,
          activated_at, failed_at, failure_reason
        ) VALUES (
          @glossaryVersionId, @guildId, @sourceLang, @targetLang, @versionNo, @compiledEntriesTsv,
          @entriesChecksum, NULL, 0, 'pending', @entryCount, @createdAt, NULL, NULL, NULL
        )`,
      )
      .run({
        glossaryVersionId,
        guildId: input.guildId,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        versionNo,
        compiledEntriesTsv: input.compiledEntriesTsv,
        entriesChecksum: input.entriesChecksum,
        entryCount: input.entryCount,
        createdAt: now,
      });

    return this.getById(glossaryVersionId)!;
  }

  markFailed(glossaryVersionId: string, failureReason: string): void {
    this.db
      .prepare(
        "UPDATE glossary_versions SET sync_status = 'failed', failed_at = ?, failure_reason = ?, deepl_ready = 0 WHERE glossary_version_id = ?",
      )
      .run(nowIso(), failureReason, glossaryVersionId);
  }

  activate(glossaryVersionId: string, deeplGlossaryId: string): void {
    const version = this.getById(glossaryVersionId);
    if (!version) {
      return;
    }

    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE glossary_versions
           SET sync_status = 'retired'
           WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND sync_status = 'active'`,
        )
        .run(version.guild_id, version.source_lang, version.target_lang);

      this.db
        .prepare(
          `UPDATE glossary_versions
           SET sync_status = 'active', deepl_glossary_id = ?, deepl_ready = 1, activated_at = ?, failure_reason = NULL, failed_at = NULL
           WHERE glossary_version_id = ?`,
        )
        .run(deeplGlossaryId, now, glossaryVersionId);
    });

    tx();
  }
}
