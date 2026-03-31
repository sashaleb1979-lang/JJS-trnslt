import Database from "better-sqlite3";
import { Client } from "discord.js";
import {
  DependencyStatus,
  FailureClass,
  GlossaryRuleStatus,
  GlossaryRuleType,
  GlossarySyncStatus,
  JobStatus,
  MediaMode,
  PublishStatus,
  RenderMode,
  ServiceStatus,
} from "./enums";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  discordToken: string;
  discordApplicationId: string;
  deeplApiKey: string;
  deeplApiBaseUrl: string;
  dataDir: string;
  databasePath: string;
  defaultSourceLanguage: string;
  defaultTargetLanguage: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  adminRoleIds: string[];
  logChannelId?: string;
  maxConcurrentJobs: number;
  maxRetryAttempts: number;
  jobLeaseSeconds: number;
  retryBaseSeconds: number;
  publishOriginalOnExhaustedTransientFailure: boolean;
  healthServerEnabled: boolean;
  metricsEnabled: boolean;
  sourceDuplicateWindowSeconds: number;
  attachmentMirrorMaxBytes: number;
  railwayVolumeMountPath?: string;
  port: number;
  railwayRunUid: number;
  railwayHealthcheckTimeoutSec: number;
  railwayDeploymentDrainingSeconds: number;
  railwayDeploymentOverlapSeconds: number;
  devGuildId?: string;
  mockDeepl: boolean;
  skipStartupDependencyChecks: boolean;
  requirePersistentVolume: boolean;
}

export interface GuildSettingsRow {
  guild_id: string;
  default_source_lang: string;
  default_target_lang: string;
  admin_role_ids_json: string | null;
  log_channel_id: string | null;
  publish_original_on_failure: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelMappingRow {
  mapping_id: string;
  guild_id: string;
  raw_channel_id: string;
  output_channel_id: string;
  source_lang: string;
  target_lang: string;
  source_label_override: string | null;
  active_glossary_version_id: string | null;
  render_mode: RenderMode;
  media_mode: MediaMode;
  is_paused: number;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProcessedRawMessageRow {
  raw_message_id: string;
  mapping_id: string;
  guild_id: string;
  raw_channel_id: string;
  origin_message_id: string | null;
  origin_channel_id: string | null;
  origin_guild_id: string | null;
  follow_confidence: string;
  canonical_payload_json: string;
  content_checksum: string;
  dedupe_key: string;
  ingest_status: string;
  skip_reason: string | null;
  received_at: string;
  canonicalized_at: string;
}

export interface TranslatedOutputRow {
  output_id: string;
  raw_message_id: string;
  mapping_id: string;
  output_channel_id: string;
  primary_message_id: string;
  all_message_ids_json: string;
  render_mode_used: string;
  published_status: PublishStatus;
  published_payload_json: string;
  published_at: string;
  updated_at: string;
}

export interface GlossaryRuleRow {
  rule_id: string;
  guild_id: string;
  source_lang: string;
  target_lang: string;
  rule_type: GlossaryRuleType;
  source_term: string;
  target_term: string | null;
  status: GlossaryRuleStatus;
  notes: string | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface GlossaryVersionRow {
  glossary_version_id: string;
  guild_id: string;
  source_lang: string;
  target_lang: string;
  version_no: number;
  compiled_entries_tsv: string;
  entries_checksum: string;
  deepl_glossary_id: string | null;
  deepl_ready: number;
  sync_status: GlossarySyncStatus;
  entry_count: number;
  created_at: string;
  activated_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
}

export interface TranslationJobRow {
  job_id: string;
  raw_message_id: string;
  mapping_id: string;
  status: JobStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  priority: number;
  last_error_code: string | null;
  last_error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FailedJobRow {
  failed_job_id: string;
  job_id: string;
  raw_message_id: string;
  mapping_id: string;
  failure_class: FailureClass;
  failure_code: string;
  failure_summary: string;
  payload_snapshot_json: string;
  attempt_count: number;
  first_failed_at: string;
  final_failed_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface AuditLogRow {
  audit_id: number;
  guild_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  details_json: string | null;
  created_at: string;
}

export interface AdminPreferenceRow {
  guild_id: string;
  user_id: string;
  compact_status_view: number;
  receive_log_alerts: number;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalGuildMetadata {
  guild_id: string;
  guild_name: string;
  locale: string | null;
}

export interface CanonicalChannelMetadata {
  channel_id: string;
  channel_name: string;
  channel_type: string;
}

export interface CanonicalRawMessageMetadata {
  message_id: string;
  message_type: string;
  webhook_id: string | null;
  application_id: string | null;
  author_id: string;
  author_name: string;
  is_webhook: boolean;
  flags: string[];
  jump_url: string;
  timestamp: string;
  edited_timestamp: string | null;
}

export interface CanonicalOriginReference {
  origin_guild_id: string | null;
  origin_channel_id: string | null;
  origin_message_id: string | null;
  origin_jump_url: string | null;
  reference_type: string | null;
}

export interface CanonicalSourceMarkers {
  has_webhook_id: boolean;
  has_message_reference: boolean;
  has_mention_channels: boolean;
  follow_confidence: "high" | "medium" | "low";
}

export interface CanonicalContent {
  raw_text: string;
  normalized_text: string;
  is_empty: boolean;
}

export interface CanonicalEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface CanonicalEmbed {
  embed_index: number;
  type: string;
  title: string | null;
  description: string | null;
  fields: CanonicalEmbedField[];
  footer_text: string | null;
  author_name: string | null;
  url: string | null;
  image_url: string | null;
}

export interface CanonicalAttachment {
  attachment_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  url: string;
  proxy_url: string | null;
  is_image: boolean;
  is_spoiler: boolean;
}

export interface CanonicalUrl {
  url: string;
  source: "content" | "embed" | "attachment";
  kind: "external_link" | "image" | "attachment";
}

export interface CanonicalMentions {
  user_ids: string[];
  role_ids: string[];
  channel_ids: string[];
  mention_everyone: boolean;
}

export interface CanonicalTextBlock {
  block_id: string;
  block_type: string;
  source_text: string;
  preserve_markdown: boolean;
}

export interface PostPayload {
  schema_version: number;
  mapping_id: string;
  guild: CanonicalGuildMetadata;
  raw_channel: CanonicalChannelMetadata;
  output_channel: CanonicalChannelMetadata;
  raw_message: CanonicalRawMessageMetadata;
  origin_reference: CanonicalOriginReference;
  source_markers: CanonicalSourceMarkers;
  content: CanonicalContent;
  embeds: CanonicalEmbed[];
  attachments: CanonicalAttachment[];
  urls: CanonicalUrl[];
  mentions: CanonicalMentions;
  text_blocks: CanonicalTextBlock[];
  detected_source_label: string;
  /** Diagnostic: which field was used to determine the source label (for logging). */
  detected_source_label_origin?: string;
  /** Diagnostic: where the primary translatable text was extracted from (for logging). */
  content_text_source?: "snapshot" | "message_content" | "embeds_only" | "empty";
  translation: {
    status: string;
    source_lang_configured: string;
    target_lang: string;
    glossary_required: boolean;
    glossary_version_id: string | null;
    attempt: number;
  };
  checksums: {
    content_checksum: string;
    dedupe_key: string;
  };
  audit: {
    received_at: string;
    canonicalized_at: string;
  };
}

export interface TranslationBatchItem {
  blockId: string;
  originalText: string;
  text: string;
  tokenMap: Map<string, string>;
  protectedTokens: string[];
}

export interface TranslationRequestPlan {
  items: TranslationBatchItem[];
  context: string;
  sourceLang?: string;
  targetLang: string;
  glossaryId?: string;
  glossaryVersionId?: string;
}

export interface TranslationResult {
  translatedBlocks: Map<string, string>;
  usedGlossaryId: string | null;
  usedGlossaryVersionId: string | null;
  billedCharacters: number;
  detectedSourceLanguage: string | null;
  validationFallbackBlockCount: number;
  untranslatedMeaningfulBlockCount: number;
  aggregateUntranslated: boolean;
}

export type TranslationPublicationStatus = "translated" | "skipped" | "partial_original" | "fallback_original";

export interface DeepLTranslateResponse {
  translations: Array<{
    detected_source_language?: string;
    text: string;
    billed_characters?: number;
  }>;
}

export interface DeepLSupportedGlossaryPair {
  source_lang: string;
  target_lang: string;
}

export interface PublishPlanMessage {
  content?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    footer?: string;
    url?: string;
    imageUrl?: string;
  }>;
  files?: Array<{
    name: string;
    data?: Buffer;
    url?: string;
    contentType?: string | null;
  }>;
  replyToAnchor?: boolean;
}

export interface PublishPlan {
  mode: "embed" | "header_chain" | "plain";
  messages: PublishPlanMessage[];
}

export interface PublishResult {
  primaryMessageId: string;
  allMessageIds: string[];
  mode: PublishPlan["mode"];
}

export interface GlossaryPreviewResult {
  glossaryVersionId: string | null;
  matchedRules: GlossaryRuleRow[];
  previewText: string;
}

export interface HealthReport {
  serviceStatus: ServiceStatus;
  discordGateway: "connected" | "reconnecting" | "disconnected";
  db: DependencyStatus;
  volume: DependencyStatus;
  deepl: DependencyStatus;
  queueDepth: number;
  oldestPendingAgeSec: number | null;
  activeMappings: number;
  pausedMappings: number;
  lastSuccessAt: string | null;
  lastFailureSummary: string | null;
  details: Record<string, unknown>;
}

export interface DependencyState {
  status: DependencyStatus;
  summary: string;
  updatedAt: string;
}

export interface RuntimeMetricsSnapshot {
  jobsProcessedTotal: number;
  translationSuccessTotal: number;
  publishSuccessTotal: number;
  retriesTotal: number;
  failedJobsTotal: number;
  duplicatesSuppressedTotal: number;
  mediaMirrorFailuresTotal: number;
  cumulativeBilledCharacters: number;
  lastSuccessfulTranslationAt: string | null;
}

export interface AppRepositories {
  guildSettings: import("../db/repositories/guild-settings-repository").GuildSettingsRepository;
  channelMappings: import("../db/repositories/channel-mappings-repository").ChannelMappingsRepository;
  processedRawMessages: import("../db/repositories/processed-raw-messages-repository").ProcessedRawMessagesRepository;
  translatedOutputs: import("../db/repositories/translated-outputs-repository").TranslatedOutputsRepository;
  glossaryRules: import("../db/repositories/glossary-rules-repository").GlossaryRulesRepository;
  glossaryVersions: import("../db/repositories/glossary-versions-repository").GlossaryVersionsRepository;
  translationJobs: import("../db/repositories/translation-jobs-repository").TranslationJobsRepository;
  failedJobs: import("../db/repositories/failed-jobs-repository").FailedJobsRepository;
  auditLog: import("../db/repositories/audit-log-repository").AuditLogRepository;
  adminPreferences: import("../db/repositories/admin-preferences-repository").AdminPreferencesRepository;
}

export interface AppServices {
  db: Database.Database;
  discord: Client;
  config: AppConfig;
  logger: import("pino").Logger;
  repositories: AppRepositories;
  health: import("../monitoring/status-service").StatusService;
  metrics: import("../monitoring/metrics").MetricsService;
  deepl: import("../translation/deepl-client").DeepLClient;
  glossaryManager: import("../translation/glossary-manager").GlossaryManager;
  renderer: import("../publish/renderer").PublishRenderer;
  publisher: import("../publish/discord-publisher").DiscordPublisher;
  orchestrator: import("../translation/orchestrator").TranslationOrchestrator;
  worker: import("../jobs/worker").JobWorker;
}
