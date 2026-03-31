import Database from "better-sqlite3";
import { TranslationJobRow } from "../../domain/types";
import { createId } from "../../utils/ids";
import { addSeconds, nowIso } from "../../utils/time";

export class TranslationJobsRepository {
  constructor(private readonly db: Database.Database) {}

  getByRawMessageId(rawMessageId: string): TranslationJobRow | null {
    return (
      this.db
        .prepare<string, TranslationJobRow>("SELECT * FROM translation_jobs WHERE raw_message_id = ?")
        .get(rawMessageId) ?? null
    );
  }

  getByJobId(jobId: string): TranslationJobRow | null {
    return this.db.prepare<string, TranslationJobRow>("SELECT * FROM translation_jobs WHERE job_id = ?").get(jobId) ?? null;
  }

  enqueue(rawMessageId: string, mappingId: string, priority = 100): TranslationJobRow {
    const existing = this.getByRawMessageId(rawMessageId);
    if (existing) {
      return existing;
    }

    const jobId = createId("job");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO translation_jobs (
          job_id, raw_message_id, mapping_id, status, attempt_count, next_attempt_at,
          lease_token, lease_expires_at, priority, last_error_code, last_error_message,
          started_at, finished_at, created_at, updated_at
        ) VALUES (
          @jobId, @rawMessageId, @mappingId, 'pending', 0, @nextAttemptAt,
          NULL, NULL, @priority, NULL, NULL, NULL, NULL, @createdAt, @updatedAt
        )`,
      )
      .run({
        jobId,
        rawMessageId,
        mappingId,
        priority,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });

    return this.getByJobId(jobId)!;
  }

  claimDueJobs(limit: number, leaseSeconds: number): TranslationJobRow[] {
    const now = nowIso();
    const candidates = this.db
      .prepare<unknown[], TranslationJobRow>(
        `SELECT j.*
         FROM translation_jobs j
         INNER JOIN channel_mappings m ON m.mapping_id = j.mapping_id
         WHERE (j.status = 'pending' OR j.status = 'retry_wait')
           AND j.next_attempt_at <= ?
           AND m.is_paused = 0
         ORDER BY j.priority ASC, j.created_at ASC
         LIMIT ?`,
      )
      .all(now, limit);

    const claimed: TranslationJobRow[] = [];
    for (const candidate of candidates) {
      const result = this.db
        .prepare(
          `UPDATE translation_jobs
           SET status = 'in_progress',
               attempt_count = attempt_count + 1,
               lease_token = ?,
               lease_expires_at = ?,
               started_at = ?,
               updated_at = ?
           WHERE job_id = ? AND status IN ('pending', 'retry_wait')`,
        )
        .run(createId("lease"), addSeconds(now, leaseSeconds), now, now, candidate.job_id);

      if (result.changes > 0) {
        const claimedJob = this.getByJobId(candidate.job_id);
        if (claimedJob) {
          claimed.push(claimedJob);
        }
      }
    }

    return claimed;
  }

  markDone(jobId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE translation_jobs
         SET status = 'done', lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(now, now, jobId);
  }

  markFailed(jobId: string, errorCode: string, errorMessage: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE translation_jobs
         SET status = 'failed', last_error_code = ?, last_error_message = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(errorCode, errorMessage, now, now, jobId);
  }

  scheduleRetry(jobId: string, errorCode: string, errorMessage: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE translation_jobs
         SET status = 'retry_wait', last_error_code = ?, last_error_message = ?, next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(errorCode, errorMessage, nextAttemptAt, nowIso(), jobId);
  }

  requeueByRawMessageId(rawMessageId: string): void {
    this.db
      .prepare(
        `UPDATE translation_jobs
         SET status = 'pending', next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = NULL, updated_at = ?
         WHERE raw_message_id = ?`,
      )
      .run(nowIso(), nowIso(), rawMessageId);
  }

  requeueFailedByMappingId(mappingId: string, limit = 25): string[] {
    const failed = this.db
      .prepare<[string, number], { raw_message_id: string }>(
        `SELECT raw_message_id
         FROM translation_jobs
         WHERE mapping_id = ? AND status = 'failed'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(mappingId, limit);

    if (failed.length === 0) {
      return [];
    }

    const now = nowIso();
    const requeue = this.db.transaction((rawMessageIds: string[]) => {
      const statement = this.db.prepare(
        `UPDATE translation_jobs
         SET status = 'pending',
             next_attempt_at = ?,
             lease_token = NULL,
             lease_expires_at = NULL,
             finished_at = NULL,
             updated_at = ?
         WHERE raw_message_id = ?`,
      );

      for (const rawMessageId of rawMessageIds) {
        statement.run(now, now, rawMessageId);
      }
    });

    const rawMessageIds = failed.map((entry) => entry.raw_message_id);
    requeue(rawMessageIds);
    return rawMessageIds;
  }

  resetExpiredInProgressJobs(): number {
    const result = this.db
      .prepare(
        `UPDATE translation_jobs
         SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(nowIso(), nowIso());

    return result.changes;
  }

  countBacklog(): number {
    const row = this.db
      .prepare<unknown[], { count: number }>(
        "SELECT COUNT(*) AS count FROM translation_jobs WHERE status IN ('pending', 'retry_wait', 'in_progress')",
      )
      .get();
    return row?.count ?? 0;
  }

  listRecentByMappingId(mappingId: string, limit = 5): TranslationJobRow[] {
    return this.db
      .prepare<[string, number], TranslationJobRow>(
        "SELECT * FROM translation_jobs WHERE mapping_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(mappingId, limit);
  }

  countByMappingAndStatus(mappingId: string, status: string): number {
    const row = this.db
      .prepare<[string, string], { count: number }>(
        "SELECT COUNT(*) AS count FROM translation_jobs WHERE mapping_id = ? AND status = ?",
      )
      .get(mappingId, status);
    return row?.count ?? 0;
  }

  countBlockedByPausedMappings(): number {
    const row = this.db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM translation_jobs j
         INNER JOIN channel_mappings m ON m.mapping_id = j.mapping_id
         WHERE j.status IN ('pending', 'retry_wait') AND m.is_paused = 1`,
      )
      .get();
    return row?.count ?? 0;
  }

  getOldestPending(): TranslationJobRow | null {
    return (
      this.db
        .prepare<[], TranslationJobRow>(
          `SELECT * FROM translation_jobs
           WHERE status IN ('pending', 'retry_wait', 'in_progress')
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get() ?? null
    );
  }
}
