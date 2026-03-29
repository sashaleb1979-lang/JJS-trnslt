import Database from "better-sqlite3";
import { nowIso } from "../../utils/time";

export class AuditLogRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: {
    guildId: string | null;
    actorType: "user" | "system";
    actorId: string | null;
    action: string;
    subjectType: string;
    subjectId: string | null;
    details: Record<string, unknown> | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (
          guild_id, actor_type, actor_id, action, subject_type, subject_id, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.guildId,
        input.actorType,
        input.actorId,
        input.action,
        input.subjectType,
        input.subjectId,
        input.details ? JSON.stringify(input.details) : null,
        nowIso(),
      );
  }
}
