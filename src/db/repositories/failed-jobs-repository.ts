import Database from "better-sqlite3";
import { FailedJobRow } from "../../domain/types";
import { FailureClass } from "../../domain/enums";
import { createId } from "../../utils/ids";

export class FailedJobsRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: {
    jobId: string;
    rawMessageId: string;
    mappingId: string;
    failureClass: FailureClass;
    failureCode: string;
    failureSummary: string;
    payloadSnapshotJson: string;
    attemptCount: number;
    firstFailedAt: string;
    finalFailedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO failed_jobs (
          failed_job_id, job_id, raw_message_id, mapping_id, failure_class, failure_code,
          failure_summary, payload_snapshot_json, attempt_count, first_failed_at, final_failed_at,
          resolved_at, resolution_note
        ) VALUES (
          @failedJobId, @jobId, @rawMessageId, @mappingId, @failureClass, @failureCode,
          @failureSummary, @payloadSnapshotJson, @attemptCount, @firstFailedAt, @finalFailedAt,
          NULL, NULL
        )`,
      )
      .run({
        failedJobId: createId("fjob"),
        ...input,
      });
  }

  listRecent(limit = 10): FailedJobRow[] {
    return this.db
      .prepare<number, FailedJobRow>("SELECT * FROM failed_jobs ORDER BY final_failed_at DESC LIMIT ?")
      .all(limit);
  }

  markResolvedByRawMessageIds(rawMessageIds: string[], resolutionNote: string): void {
    if (rawMessageIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const update = this.db.transaction((ids: string[]) => {
      const statement = this.db.prepare(
        `UPDATE failed_jobs
         SET resolved_at = ?, resolution_note = ?
         WHERE raw_message_id = ? AND resolved_at IS NULL`,
      );

      for (const rawMessageId of ids) {
        statement.run(now, resolutionNote, rawMessageId);
      }
    });

    update(rawMessageIds);
  }

  countAll(): number {
    const row = this.db.prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM failed_jobs").get();
    return row?.count ?? 0;
  }
}
