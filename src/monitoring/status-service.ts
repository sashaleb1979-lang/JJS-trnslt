import { Logger } from "pino";
import { AppRepositories, DependencyState, HealthReport } from "../domain/types";
import { MetricsService } from "./metrics";
import { diffSeconds, nowIso } from "../utils/time";

export class StatusService {
  private readonly dependencies = new Map<string, DependencyState>();
  private gatewayState: HealthReport["discordGateway"] = "disconnected";
  private readiness = false;
  private lastFailureSummary: string | null = null;

  constructor(
    private readonly repositories: AppRepositories,
    private readonly metrics: MetricsService,
    private readonly logger: Logger,
  ) {}

  setDependency(name: "db" | "volume" | "deepl", state: DependencyState): void {
    this.dependencies.set(name, state);
  }

  setGatewayState(state: HealthReport["discordGateway"]): void {
    this.gatewayState = state;
  }

  setReadiness(value: boolean): void {
    this.readiness = value;
  }

  setLastFailureSummary(summary: string | null): void {
    this.lastFailureSummary = summary;
  }

  isReady(): boolean {
    return this.readiness;
  }

  buildReport(): HealthReport {
    const backlog = this.repositories.translationJobs.countBacklog();
    const oldestPending = this.repositories.translationJobs.getOldestPending();
    const mappingCounts = this.repositories.channelMappings.countActiveAndPaused();
    const metrics = this.metrics.getSnapshot();
    const recentFailures = this.repositories.failedJobs.listRecent(1);

    const db = this.dependencies.get("db") ?? { status: "degraded", summary: "unknown", updatedAt: nowIso() };
    const volume = this.dependencies.get("volume") ?? { status: "degraded", summary: "unknown", updatedAt: nowIso() };
    const deepl = this.dependencies.get("deepl") ?? { status: "degraded", summary: "unknown", updatedAt: nowIso() };

    const serviceStatus =
      db.status === "error" || volume.status === "error"
        ? "unhealthy"
        : db.status === "degraded" || volume.status === "degraded" || deepl.status === "degraded"
          ? "degraded"
          : "healthy";

    return {
      serviceStatus,
      discordGateway: this.gatewayState,
      db: db.status,
      volume: volume.status,
      deepl: deepl.status,
      queueDepth: backlog,
      oldestPendingAgeSec: oldestPending ? diffSeconds(oldestPending.created_at, nowIso()) : null,
      activeMappings: mappingCounts.activeCount,
      pausedMappings: mappingCounts.pausedCount,
      lastSuccessAt: metrics.lastSuccessfulTranslationAt,
      lastFailureSummary: this.lastFailureSummary ?? recentFailures[0]?.failure_summary ?? null,
      details: {
        ready: this.readiness,
        dependencies: {
          db,
          volume,
          deepl,
        },
        metrics,
      },
    };
  }

  logSummary(): void {
    const report = this.buildReport();
    const blockedJobs = this.repositories.translationJobs.countBlockedByPausedMappings();
    this.logger.info(
      {
        event: "health_report",
        service_status: report.serviceStatus,
        queue_depth: report.queueDepth,
        active_mappings: report.activeMappings,
        paused_mappings: report.pausedMappings,
        jobs_blocked_by_paused_mappings: blockedJobs,
      },
      "Health report snapshot",
    );
    if (blockedJobs > 0) {
      this.logger.warn(
        {
          event: "jobs_blocked_paused_mappings",
          blocked_count: blockedJobs,
        },
        `${blockedJobs} job(s) are blocked because their channel mapping is paused — use /resume or /status verbose=true to diagnose`,
      );
    }
  }
}
