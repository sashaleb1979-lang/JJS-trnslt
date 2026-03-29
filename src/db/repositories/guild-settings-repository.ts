import Database from "better-sqlite3";
import { GuildSettingsRow } from "../../domain/types";
import { nowIso } from "../../utils/time";

export class GuildSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getByGuildId(guildId: string): GuildSettingsRow | null {
    return (
      this.db.prepare<string, GuildSettingsRow>("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) ?? null
    );
  }

  upsert(input: {
    guildId: string;
    defaultSourceLang: string;
    defaultTargetLang: string;
    adminRoleIdsJson: string | null;
    logChannelId: string | null;
    publishOriginalOnFailure: boolean;
    status: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO guild_settings (
          guild_id, default_source_lang, default_target_lang, admin_role_ids_json, log_channel_id,
          publish_original_on_failure, status, created_at, updated_at
        ) VALUES (
          @guildId, @defaultSourceLang, @defaultTargetLang, @adminRoleIdsJson, @logChannelId,
          @publishOriginalOnFailure, @status, @createdAt, @updatedAt
        )
        ON CONFLICT(guild_id) DO UPDATE SET
          default_source_lang = excluded.default_source_lang,
          default_target_lang = excluded.default_target_lang,
          admin_role_ids_json = excluded.admin_role_ids_json,
          log_channel_id = excluded.log_channel_id,
          publish_original_on_failure = excluded.publish_original_on_failure,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run({
        guildId: input.guildId,
        defaultSourceLang: input.defaultSourceLang,
        defaultTargetLang: input.defaultTargetLang,
        adminRoleIdsJson: input.adminRoleIdsJson,
        logChannelId: input.logChannelId,
        publishOriginalOnFailure: input.publishOriginalOnFailure ? 1 : 0,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      });
  }
}
