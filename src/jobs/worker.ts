import { Logger } from "pino";
import { AppError, isAppError } from "../domain/errors";
import { AppConfig, AppRepositories, TranslationJobRow } from "../domain/types";
import { StatusService } from "../monitoring/status-service";
import { MetricsService } from "../monitoring/metrics";
import { TranslationOrchestrator } from "../translation/orchestrator";
import { computeNextRetryAt } from "./retry-policy";
import { PollingScheduler } from "./scheduler";

export class JobWorker {
  private readonly scheduler = new PollingScheduler();
  // activeJobs tracks in-flight work to respect maxConcurrentJobs without extra locking.
  private running = false;
  private activeJobs = 0;

  constructor(
    private readonly repositories: AppRepositories,
    private readonly orchestrator: TranslationOrchestrator,
    private readonly statusService: StatusService,
    private readonly metrics: MetricsService,
    private readonly logger: Logger,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduler.start(() => this.tick(), 2_000);
  }

  stop(): void {
    this.running = false;
    this.scheduler.stop();
  }

  recoverExpiredJobs(): number {
    return this.repositories.translationJobs.resetExpiredInProgressJobs();
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }

    const availableSlots = this.config.maxConcurrentJobs - this.activeJobs;
    if (availableSlots <= 0) {
      return;
    }

    const jobs = this.repositories.translationJobs.claimDueJobs(availableSlots, this.config.jobLeaseSeconds);
    if (jobs.length === 0) {
      return;
    }

    await Promise.all(jobs.map((job) => this.handleJob(job)));
  }

  private async handleJob(job: TranslationJobRow): Promise<void> {
    this.activeJobs += 1;

    try {
      const result = await this.orchestrator.process(job);
      this.repositories.translationJobs.markDone(job.job_id);
      if (result.type === "duplicate") {
        this.metrics.increment("duplicatesSuppressedTotal");
      }
      this.statusService.setLastFailureSummary(null);
    } catch (error) {
      await this.handleFailure(job, error);
    } finally {
      this.activeJobs -= 1;
    }
  }

  private async handleFailure(job: TranslationJobRow, error: unknown): Promise<void> {
    const appError =
      isAppError(error) ?
        error
      : new AppError({
          code: "UNHANDLED_JOB_ERROR",
          message: error instanceof Error ? error.message : "Unknown job error",
          retryable: true,
          cause: error,
        });

    this.statusService.setLastFailureSummary(`${appError.code}: ${appError.message}`);

    if (appError.failureClass === "permanent_config") {
      this.repositories.channelMappings.setPaused(job.mapping_id, true, appError.message);
    }

    if (appError.retryable && job.attempt_count < this.config.maxRetryAttempts) {
      const nextAttemptAt = computeNextRetryAt(job.attempt_count, this.config.retryBaseSeconds);
      this.repositories.translationJobs.scheduleRetry(job.job_id, appError.code, appError.message, nextAttemptAt);
      this.metrics.increment("retriesTotal");
      this.logger.warn(
        {
          event: "retry_scheduled",
          job_id: job.job_id,
          raw_message_id: job.raw_message_id,
          mapping_id: job.mapping_id,
          attempt: job.attempt_count,
          error_code: appError.code,
          next_attempt_at: nextAttemptAt,
        },
        "Retry scheduled",
      );
      return;
    }

    if (appError.retryable && this.config.publishOriginalOnExhaustedTransientFailure) {
      try {
        await this.orchestrator.publishOriginalFallback(job, appError.message);
        this.repositories.translationJobs.markDone(job.job_id);
        return;
      } catch (fallbackError) {
        this.logger.error(
          {
            event: "fallback_publish_failed",
            job_id: job.job_id,
            raw_message_id: job.raw_message_id,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
          "Fallback publish failed",
        );
      }
    }

    this.repositories.translationJobs.markFailed(job.job_id, appError.code, appError.message);
    const rawRecord = this.repositories.processedRawMessages.getByRawMessageId(job.raw_message_id);
    this.repositories.failedJobs.record({
      jobId: job.job_id,
      rawMessageId: job.raw_message_id,
      mappingId: job.mapping_id,
      failureClass: appError.failureClass,
      failureCode: appError.code,
      failureSummary: appError.message,
      payloadSnapshotJson: rawRecord?.canonical_payload_json ?? "{}",
      attemptCount: job.attempt_count,
      firstFailedAt: rawRecord?.received_at ?? new Date().toISOString(),
      finalFailedAt: new Date().toISOString(),
    });
    this.metrics.increment("failedJobsTotal");

    this.logger.error(
      {
        event: "failure_recorded",
        job_id: job.job_id,
        raw_message_id: job.raw_message_id,
        mapping_id: job.mapping_id,
        error_code: appError.code,
        error_class: appError.failureClass,
      },
      "Job failed permanently",
    );
  }
}
