import Database from "better-sqlite3";
import { GlossaryRuleRow } from "../../domain/types";
import { GlossaryRuleType } from "../../domain/enums";
import { BulkImportEntry } from "../../translation/glossary-bulk-importer";
import { createId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

export class GlossaryRulesRepository {
  constructor(private readonly db: Database.Database) {}

  listActiveByPair(guildId: string, sourceLang: string, targetLang: string): GlossaryRuleRow[] {
    return this.db
      .prepare<string[], GlossaryRuleRow>(
        `SELECT * FROM glossary_rules
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND status = 'active'
         ORDER BY source_term COLLATE NOCASE ASC`,
      )
      .all(guildId, sourceLang, targetLang);
  }

  listByGuild(guildId: string, query?: string, includeArchived = false): GlossaryRuleRow[] {
    if (query) {
      const sql = includeArchived
        ? `SELECT * FROM glossary_rules
           WHERE guild_id = ? AND (source_term LIKE ? OR target_term LIKE ?)
           ORDER BY updated_at DESC`
        : `SELECT * FROM glossary_rules
           WHERE guild_id = ? AND status = 'active' AND (source_term LIKE ? OR target_term LIKE ?)
           ORDER BY updated_at DESC`;

      return this.db.prepare<string[], GlossaryRuleRow>(sql).all(guildId, `%${query}%`, `%${query}%`);
    }

    const sql = includeArchived
      ? "SELECT * FROM glossary_rules WHERE guild_id = ? ORDER BY updated_at DESC"
      : "SELECT * FROM glossary_rules WHERE guild_id = ? AND status = 'active' ORDER BY updated_at DESC";

    return this.db
      .prepare<string, GlossaryRuleRow>(sql)
      .all(guildId);
  }

  getActiveRule(guildId: string, sourceLang: string, targetLang: string, sourceTerm: string): GlossaryRuleRow | null {
    return (
      this.db
        .prepare<string[], GlossaryRuleRow>(
          `SELECT * FROM glossary_rules
           WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND source_term = ? AND status = 'active'
           LIMIT 1`,
        )
        .get(guildId, sourceLang, targetLang, sourceTerm) ?? null
    );
  }

  addRule(input: {
    guildId: string;
    sourceLang: string;
    targetLang: string;
    ruleType: GlossaryRuleType;
    sourceTerm: string;
    targetTerm: string | null;
    notes: string | null;
    userId: string;
  }): GlossaryRuleRow {
    const now = nowIso();
    const ruleId = createId("glr");
    this.db
      .prepare(
        `INSERT INTO glossary_rules (
          rule_id, guild_id, source_lang, target_lang, rule_type, source_term, target_term,
          status, notes, created_by_user_id, updated_by_user_id, created_at, updated_at
        ) VALUES (
          @ruleId, @guildId, @sourceLang, @targetLang, @ruleType, @sourceTerm, @targetTerm,
          'active', @notes, @userId, @userId, @createdAt, @updatedAt
        )`,
      )
      .run({
        ruleId,
        guildId: input.guildId,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        ruleType: input.ruleType,
        sourceTerm: input.sourceTerm,
        targetTerm: input.targetTerm,
        notes: input.notes,
        userId: input.userId,
        createdAt: now,
        updatedAt: now,
      });

    return this.db.prepare<string, GlossaryRuleRow>("SELECT * FROM glossary_rules WHERE rule_id = ?").get(ruleId)!;
  }

  archiveRule(guildId: string, sourceLang: string, targetLang: string, sourceTerm: string, userId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE glossary_rules
         SET status = 'archived', updated_by_user_id = ?, updated_at = ?
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND source_term = ? AND status = 'active'`,
      )
      .run(userId, nowIso(), guildId, sourceLang, targetLang, sourceTerm);

    return result.changes > 0;
  }

  /**
   * Apply a batch of entries to the glossary in a single DB transaction.
   *
   * - Exact duplicates (same source_term, mode, target_term) are skipped.
   * - If replaceExisting=false, conflicting rules are also skipped.
   * - If replaceExisting=true, conflicting rules are archived and replaced.
   */
  bulkUpsertRules(input: {
    guildId: string;
    sourceLang: string;
    targetLang: string;
    entries: BulkImportEntry[];
    replaceExisting: boolean;
    userId: string;
  }): { added: number; updated: number; unchanged: number; conflictsSkipped: number } {
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let conflictsSkipped = 0;

    const tx = this.db.transaction(() => {
      for (const entry of input.entries) {
        const existing = this.getActiveRule(input.guildId, input.sourceLang, input.targetLang, entry.sourceTerm);

        if (existing) {
          const isExactDuplicate = existing.rule_type === entry.mode && existing.target_term === entry.targetTerm;
          if (isExactDuplicate) {
            unchanged++;
            continue;
          }
          if (!input.replaceExisting) {
            conflictsSkipped++;
            continue;
          }
          this.deleteRule(input.guildId, input.sourceLang, input.targetLang, entry.sourceTerm);
          this.addRule({
            guildId: input.guildId,
            sourceLang: input.sourceLang,
            targetLang: input.targetLang,
            ruleType: entry.mode,
            sourceTerm: entry.sourceTerm,
            targetTerm: entry.targetTerm,
            notes: null,
            userId: input.userId,
          });
          updated++;
        } else {
          this.addRule({
            guildId: input.guildId,
            sourceLang: input.sourceLang,
            targetLang: input.targetLang,
            ruleType: entry.mode,
            sourceTerm: entry.sourceTerm,
            targetTerm: entry.targetTerm,
            notes: null,
            userId: input.userId,
          });
          added++;
        }
      }
    });

    tx();
    return { added, updated, unchanged, conflictsSkipped };
  }

  deleteRule(guildId: string, sourceLang: string, targetLang: string, sourceTerm: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM glossary_rules
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND source_term = ?`,
      )
      .run(guildId, sourceLang, targetLang, sourceTerm);

    return result.changes > 0;
  }

  deleteAllByPair(guildId: string, sourceLang: string, targetLang: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM glossary_rules
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ?`,
      )
      .run(guildId, sourceLang, targetLang);
    return result.changes;
  }

  deleteAllByGuild(guildId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM glossary_rules
         WHERE guild_id = ?`,
      )
      .run(guildId);
    return result.changes;
  }

  archiveAllByPair(guildId: string, sourceLang: string, targetLang: string, userId: string): number {
    const result = this.db
      .prepare(
        `UPDATE glossary_rules
         SET status = 'archived', updated_by_user_id = ?, updated_at = ?
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ? AND status = 'active'`,
      )
      .run(userId, nowIso(), guildId, sourceLang, targetLang);
    return result.changes;
  }

  archiveAllByGuild(guildId: string, userId: string): number {
    const result = this.db
      .prepare(
        `UPDATE glossary_rules
         SET status = 'archived', updated_by_user_id = ?, updated_at = ?
         WHERE guild_id = ? AND status = 'active'`,
      )
      .run(userId, nowIso(), guildId);
    return result.changes;
  }
}
