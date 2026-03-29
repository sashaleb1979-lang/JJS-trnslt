import Database from "better-sqlite3";
import { GlossaryRuleRow } from "../../domain/types";
import { GlossaryRuleType } from "../../domain/enums";
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

  listByGuild(guildId: string, query?: string): GlossaryRuleRow[] {
    if (query) {
      return this.db
        .prepare<string[], GlossaryRuleRow>(
          `SELECT * FROM glossary_rules
           WHERE guild_id = ? AND (source_term LIKE ? OR target_term LIKE ?)
           ORDER BY updated_at DESC`,
        )
        .all(guildId, `%${query}%`, `%${query}%`);
    }

    return this.db
      .prepare<string, GlossaryRuleRow>("SELECT * FROM glossary_rules WHERE guild_id = ? ORDER BY updated_at DESC")
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
}
