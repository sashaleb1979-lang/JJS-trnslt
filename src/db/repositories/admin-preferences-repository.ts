import Database from "better-sqlite3";
import { AdminPreferenceRow } from "../../domain/types";
import { nowIso } from "../../utils/time";

export class AdminPreferencesRepository {
  constructor(private readonly db: Database.Database) {}

  get(guildId: string, userId: string): AdminPreferenceRow | null {
    return (
      this.db
        .prepare<string[], AdminPreferenceRow>("SELECT * FROM admin_preferences WHERE guild_id = ? AND user_id = ?")
        .get(guildId, userId) ?? null
    );
  }

  upsert(input: {
    guildId: string;
    userId: string;
    compactStatusView: boolean;
    receiveLogAlerts: boolean;
    timezone: string | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO admin_preferences (
          guild_id, user_id, compact_status_view, receive_log_alerts, timezone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          compact_status_view = excluded.compact_status_view,
          receive_log_alerts = excluded.receive_log_alerts,
          timezone = excluded.timezone,
          updated_at = excluded.updated_at`,
      )
      .run(input.guildId, input.userId, input.compactStatusView ? 1 : 0, input.receiveLogAlerts ? 1 : 0, input.timezone, now, now);
  }
}
