import Database from "better-sqlite3";
import { ChannelMappingRow } from "../../domain/types";
import { nowIso } from "../../utils/time";

export class ChannelMappingsRepository {
  constructor(private readonly db: Database.Database) {}

  getByRawChannelId(rawChannelId: string): ChannelMappingRow | null {
    return (
      this.db
        .prepare<string, ChannelMappingRow>("SELECT * FROM channel_mappings WHERE raw_channel_id = ?")
        .get(rawChannelId) ?? null
    );
  }

  getByMappingId(mappingId: string): ChannelMappingRow | null {
    return this.db.prepare<string, ChannelMappingRow>("SELECT * FROM channel_mappings WHERE mapping_id = ?").get(mappingId) ?? null;
  }

  listByGuildId(guildId: string): ChannelMappingRow[] {
    return this.db
      .prepare<string, ChannelMappingRow>("SELECT * FROM channel_mappings WHERE guild_id = ? ORDER BY created_at ASC")
      .all(guildId);
  }

  listAll(): ChannelMappingRow[] {
    return this.db.prepare<[], ChannelMappingRow>("SELECT * FROM channel_mappings ORDER BY created_at ASC").all();
  }

  upsert(input: {
    mappingId: string;
    guildId: string;
    rawChannelId: string;
    outputChannelId: string;
    sourceLang: string;
    targetLang: string;
    sourceLabelOverride: string | null;
    activeGlossaryVersionId: string | null;
    renderMode: ChannelMappingRow["render_mode"];
    mediaMode: ChannelMappingRow["media_mode"];
    isPaused: boolean;
    pauseReason: string | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO channel_mappings (
          mapping_id, guild_id, raw_channel_id, output_channel_id, source_lang, target_lang,
          source_label_override, active_glossary_version_id, render_mode, media_mode, is_paused,
          pause_reason, created_at, updated_at
        ) VALUES (
          @mappingId, @guildId, @rawChannelId, @outputChannelId, @sourceLang, @targetLang,
          @sourceLabelOverride, @activeGlossaryVersionId, @renderMode, @mediaMode, @isPaused,
          @pauseReason, @createdAt, @updatedAt
        )
        ON CONFLICT(mapping_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          raw_channel_id = excluded.raw_channel_id,
          output_channel_id = excluded.output_channel_id,
          source_lang = excluded.source_lang,
          target_lang = excluded.target_lang,
          source_label_override = excluded.source_label_override,
          active_glossary_version_id = excluded.active_glossary_version_id,
          render_mode = excluded.render_mode,
          media_mode = excluded.media_mode,
          is_paused = excluded.is_paused,
          pause_reason = excluded.pause_reason,
          updated_at = excluded.updated_at`,
      )
      .run({
        ...input,
        isPaused: input.isPaused ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
  }

  setPaused(mappingId: string, isPaused: boolean, pauseReason: string | null): void {
    this.db
      .prepare("UPDATE channel_mappings SET is_paused = ?, pause_reason = ?, updated_at = ? WHERE mapping_id = ?")
      .run(isPaused ? 1 : 0, pauseReason, nowIso(), mappingId);
  }

  updateActiveGlossary(mappingId: string, glossaryVersionId: string | null): void {
    this.db
      .prepare("UPDATE channel_mappings SET active_glossary_version_id = ?, updated_at = ? WHERE mapping_id = ?")
      .run(glossaryVersionId, nowIso(), mappingId);
  }

  updateActiveGlossaryForPair(guildId: string, sourceLang: string, targetLang: string, glossaryVersionId: string | null): void {
    this.db
      .prepare(
        `UPDATE channel_mappings
         SET active_glossary_version_id = ?, updated_at = ?
         WHERE guild_id = ? AND source_lang = ? AND target_lang = ?`,
      )
      .run(glossaryVersionId, nowIso(), guildId, sourceLang, targetLang);
  }

  countActiveAndPaused(): { activeCount: number; pausedCount: number } {
    const active = this.db
      .prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM channel_mappings WHERE is_paused = 0")
      .get();
    const paused = this.db
      .prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM channel_mappings WHERE is_paused = 1")
      .get();
    return { activeCount: active?.count ?? 0, pausedCount: paused?.count ?? 0 };
  }
}
