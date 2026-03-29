import path from "node:path";
import { z } from "zod";
import { AppConfig } from "../domain/types";
import { DEFAULTS } from "./defaults";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DEEPL_API_KEY: z.string().min(1),
  DEEPL_API_BASE_URL: z.string().url().default(DEFAULTS.deeplApiBaseUrl),
  DATA_DIR: z.string().optional(),
  DATABASE_PATH: z.string().optional(),
  DEFAULT_SOURCE_LANGUAGE: z.string().min(2).default(DEFAULTS.defaultSourceLanguage),
  DEFAULT_TARGET_LANGUAGE: z.string().min(2).default(DEFAULTS.defaultTargetLanguage),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default(DEFAULTS.logLevel),
  ADMIN_ROLE_IDS: z.string().optional(),
  LOG_CHANNEL_ID: z.string().regex(/^\d+$/).optional().or(z.literal("")),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(4).default(DEFAULTS.maxConcurrentJobs),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(DEFAULTS.maxRetryAttempts),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(30).default(DEFAULTS.jobLeaseSeconds),
  RETRY_BASE_SECONDS: z.coerce.number().int().min(10).default(DEFAULTS.retryBaseSeconds),
  PUBLISH_ORIGINAL_ON_EXHAUSTED_TRANSIENT_FAILURE: z.coerce.boolean().default(
    DEFAULTS.publishOriginalOnExhaustedTransientFailure,
  ),
  HEALTH_SERVER_ENABLED: z.coerce.boolean().default(DEFAULTS.healthServerEnabled),
  METRICS_ENABLED: z.coerce.boolean().default(DEFAULTS.metricsEnabled),
  SOURCE_DUPLICATE_WINDOW_SECONDS: z.coerce.number().int().min(0).default(DEFAULTS.sourceDuplicateWindowSeconds),
  ATTACHMENT_MIRROR_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULTS.attachmentMirrorMaxBytes),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULTS.port),
  RAILWAY_RUN_UID: z.coerce.number().int().nonnegative().default(DEFAULTS.railwayRunUid),
  RAILWAY_HEALTHCHECK_TIMEOUT_SEC: z.coerce.number().int().positive().default(DEFAULTS.railwayHealthcheckTimeoutSec),
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS: z.coerce.number().int().nonnegative().default(
    DEFAULTS.railwayDeploymentDrainingSeconds,
  ),
  RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: z.coerce.number().int().nonnegative().default(
    DEFAULTS.railwayDeploymentOverlapSeconds,
  ),
  DEV_GUILD_ID: z.string().regex(/^\d+$/).optional().or(z.literal("")),
  MOCK_DEEPL: z.coerce.boolean().default(DEFAULTS.mockDeepl),
  SKIP_STARTUP_DEPENDENCY_CHECKS: z.coerce.boolean().default(DEFAULTS.skipStartupDependencyChecks),
  REQUIRE_PERSISTENT_VOLUME: z.coerce.boolean().default(DEFAULTS.requirePersistentVolume),
});

export function validateAndBuildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(env);
  const railwayVolumeMountPath = parsed.RAILWAY_VOLUME_MOUNT_PATH?.trim() || undefined;
  const dataDir = parsed.DATA_DIR?.trim() || (railwayVolumeMountPath ? path.join(railwayVolumeMountPath, "app") : path.resolve("data"));
  const databasePath = parsed.DATABASE_PATH?.trim() || path.join(dataDir, "bot.sqlite");

  return {
    nodeEnv: parsed.NODE_ENV,
    discordToken: parsed.DISCORD_TOKEN,
    discordApplicationId: parsed.DISCORD_APPLICATION_ID,
    deeplApiKey: parsed.DEEPL_API_KEY,
    deeplApiBaseUrl: parsed.DEEPL_API_BASE_URL.replace(/\/+$/, ""),
    dataDir,
    databasePath,
    defaultSourceLanguage: parsed.DEFAULT_SOURCE_LANGUAGE.toUpperCase(),
    defaultTargetLanguage: parsed.DEFAULT_TARGET_LANGUAGE.toUpperCase(),
    logLevel: parsed.LOG_LEVEL,
    adminRoleIds: parsed.ADMIN_ROLE_IDS
      ? parsed.ADMIN_ROLE_IDS.split(",").map((value) => value.trim()).filter(Boolean)
      : [],
    logChannelId: parsed.LOG_CHANNEL_ID?.trim() || undefined,
    maxConcurrentJobs: parsed.MAX_CONCURRENT_JOBS,
    maxRetryAttempts: parsed.MAX_RETRY_ATTEMPTS,
    jobLeaseSeconds: parsed.JOB_LEASE_SECONDS,
    retryBaseSeconds: parsed.RETRY_BASE_SECONDS,
    publishOriginalOnExhaustedTransientFailure: parsed.PUBLISH_ORIGINAL_ON_EXHAUSTED_TRANSIENT_FAILURE,
    healthServerEnabled: parsed.HEALTH_SERVER_ENABLED,
    metricsEnabled: parsed.METRICS_ENABLED,
    sourceDuplicateWindowSeconds: parsed.SOURCE_DUPLICATE_WINDOW_SECONDS,
    attachmentMirrorMaxBytes: parsed.ATTACHMENT_MIRROR_MAX_BYTES,
    railwayVolumeMountPath,
    port: parsed.PORT,
    railwayRunUid: parsed.RAILWAY_RUN_UID,
    railwayHealthcheckTimeoutSec: parsed.RAILWAY_HEALTHCHECK_TIMEOUT_SEC,
    railwayDeploymentDrainingSeconds: parsed.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
    railwayDeploymentOverlapSeconds: parsed.RAILWAY_DEPLOYMENT_OVERLAP_SECONDS,
    devGuildId: parsed.DEV_GUILD_ID?.trim() || undefined,
    mockDeepl: parsed.MOCK_DEEPL,
    skipStartupDependencyChecks: parsed.SKIP_STARTUP_DEPENDENCY_CHECKS,
    requirePersistentVolume: parsed.REQUIRE_PERSISTENT_VOLUME,
  };
}
