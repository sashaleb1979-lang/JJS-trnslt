export const JOB_STATUS = [
  "pending",
  "in_progress",
  "retry_wait",
  "done",
  "failed",
] as const;

export const FAILURE_CLASS = [
  "transient",
  "permanent_config",
  "permanent_publish",
  "permanent_duplicate",
  "validation",
] as const;

export const MAPPING_STATUS = ["active", "degraded", "paused"] as const;
export const GUILD_STATUS = ["active", "degraded", "paused"] as const;
export const GLOSSARY_SYNC_STATUS = ["pending", "active", "failed", "retired"] as const;
export const GLOSSARY_RULE_TYPE = ["fixed", "preserve"] as const;
export const GLOSSARY_RULE_STATUS = ["active", "draft", "archived"] as const;
export const PUBLISH_STATUS = ["published", "deleted", "manual_missing"] as const;
export const RENDER_MODE = ["auto", "embed", "plain"] as const;
export const MEDIA_MODE = ["auto", "mirror", "link_only"] as const;
export const SERVICE_STATUS = ["healthy", "degraded", "unhealthy"] as const;
export const DEPENDENCY_STATUS = ["ok", "degraded", "error"] as const;

export type JobStatus = (typeof JOB_STATUS)[number];
export type FailureClass = (typeof FAILURE_CLASS)[number];
export type MappingStatus = (typeof MAPPING_STATUS)[number];
export type GuildStatus = (typeof GUILD_STATUS)[number];
export type GlossarySyncStatus = (typeof GLOSSARY_SYNC_STATUS)[number];
export type GlossaryRuleType = (typeof GLOSSARY_RULE_TYPE)[number];
export type GlossaryRuleStatus = (typeof GLOSSARY_RULE_STATUS)[number];
export type PublishStatus = (typeof PUBLISH_STATUS)[number];
export type RenderMode = (typeof RENDER_MODE)[number];
export type MediaMode = (typeof MEDIA_MODE)[number];
export type ServiceStatus = (typeof SERVICE_STATUS)[number];
export type DependencyStatus = (typeof DEPENDENCY_STATUS)[number];
