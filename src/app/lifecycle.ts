import fs from "node:fs";
import { Client } from "discord.js";
import { loadConfig } from "../config/env";
import { openDatabase, ensureDataDirectories } from "../db/connection";
import { GuildSettingsRepository } from "../db/repositories/guild-settings-repository";
import { ChannelMappingsRepository } from "../db/repositories/channel-mappings-repository";
import { ProcessedRawMessagesRepository } from "../db/repositories/processed-raw-messages-repository";
import { TranslatedOutputsRepository } from "../db/repositories/translated-outputs-repository";
import { GlossaryRulesRepository } from "../db/repositories/glossary-rules-repository";
import { GlossaryVersionsRepository } from "../db/repositories/glossary-versions-repository";
import { TranslationJobsRepository } from "../db/repositories/translation-jobs-repository";
import { FailedJobsRepository } from "../db/repositories/failed-jobs-repository";
import { AuditLogRepository } from "../db/repositories/audit-log-repository";
import { AdminPreferencesRepository } from "../db/repositories/admin-preferences-repository";
import { createDiscordClient } from "../discord/client";
import { CommandRouter } from "../discord/command-router";
import { GatewayListener } from "../discord/gateway-listener";
import { AppRepositories } from "../domain/types";
import { JobWorker } from "../jobs/worker";
import { HealthServer } from "../monitoring/health-server";
import { createLogger } from "../monitoring/logger";
import { MetricsService } from "../monitoring/metrics";
import { StatusService } from "../monitoring/status-service";
import { AttachmentHandler } from "../publish/attachment-handler";
import { DiscordPublisher } from "../publish/discord-publisher";
import { PublishRenderer } from "../publish/renderer";
import { DeepLClient } from "../translation/deepl-client";
import { GlossaryManager } from "../translation/glossary-manager";
import { TranslationOrchestrator } from "../translation/orchestrator";

export class BotApplication {
  private readonly config = loadConfig();
  private readonly logger = createLogger(this.config);
  private readonly db = openDatabase(this.config);
  private readonly repositories: AppRepositories = {
    guildSettings: new GuildSettingsRepository(this.db),
    channelMappings: new ChannelMappingsRepository(this.db),
    processedRawMessages: new ProcessedRawMessagesRepository(this.db),
    translatedOutputs: new TranslatedOutputsRepository(this.db),
    glossaryRules: new GlossaryRulesRepository(this.db),
    glossaryVersions: new GlossaryVersionsRepository(this.db),
    translationJobs: new TranslationJobsRepository(this.db),
    failedJobs: new FailedJobsRepository(this.db),
    auditLog: new AuditLogRepository(this.db),
    adminPreferences: new AdminPreferencesRepository(this.db),
  };
  private readonly metrics = new MetricsService();
  private readonly statusService = new StatusService(this.repositories, this.metrics, this.logger);
  private readonly client: Client = createDiscordClient();
  private readonly deepl = new DeepLClient(this.config);
  private readonly glossaryManager = new GlossaryManager(this.repositories, this.deepl);
  private readonly attachmentHandler = new AttachmentHandler(this.config, this.logger);
  private readonly renderer = new PublishRenderer();
  private readonly publisher = new DiscordPublisher(this.client, this.logger);
  private readonly orchestrator = new TranslationOrchestrator(
    this.repositories,
    this.deepl,
    this.glossaryManager,
    this.renderer,
    this.publisher,
    this.attachmentHandler,
    this.metrics,
    this.logger,
    this.config,
  );
  private readonly worker = new JobWorker(
    this.repositories,
    this.orchestrator,
    this.statusService,
    this.metrics,
    this.logger,
    this.config,
  );
  private readonly healthServer = new HealthServer(this.config.port, this.statusService, this.logger);
  private readonly commandRouter = new CommandRouter(
    this.client,
    this.repositories,
    this.statusService,
    this.deepl,
    this.glossaryManager,
    this.config,
    this.logger,
  );
  private readonly gatewayListener = new GatewayListener(
    this.client,
    this.repositories,
    this.statusService,
    this.logger,
    this.config,
  );
  private statusTimer: NodeJS.Timeout | null = null;
  private started = false;

  async start(): Promise<void> {
    this.validatePersistentVolume();
    ensureDataDirectories(this.config);
    this.statusService.setDependency("volume", { status: "ok", summary: "volume writable", updatedAt: new Date().toISOString() });
    this.statusService.setDependency("db", { status: "ok", summary: "database opened", updatedAt: new Date().toISOString() });
    this.statusService.setDependency("deepl", { status: "degraded", summary: "not checked yet", updatedAt: new Date().toISOString() });
    this.statusService.setGatewayState("disconnected");
    this.statusService.setReadiness(false);

    this.logger.info(
      {
        event: "startup",
        node_env: this.config.nodeEnv,
        database_path: this.config.databasePath,
        railway_volume_mount_path: this.config.railwayVolumeMountPath ?? null,
        mock_deepl: this.config.mockDeepl,
      },
      "Starting application",
    );

    if (this.config.mockDeepl) {
      this.logger.warn(
        { event: "mock_deepl_enabled" },
        "⚠️  MOCK_DEEPL is ON — DeepL API will NOT be called. Translations will be fake. Set MOCK_DEEPL=false or remove it to use real DeepL.",
      );
    }

    this.gatewayListener.register();
    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.commandRouter.handleInteraction(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("glossary_import|")) {
        void this.commandRouter.handleGlossaryImportModal(interaction);
      }
    });

    if (this.config.healthServerEnabled) {
      this.healthServer.start();
    }

    if (!this.config.skipStartupDependencyChecks) {
      try {
        await this.deepl.validateAuth();
        this.statusService.setDependency("deepl", { status: "ok", summary: "auth validated", updatedAt: new Date().toISOString() });
      } catch (error) {
        this.statusService.setDependency("deepl", {
          status: "degraded",
          summary: error instanceof Error ? error.message : "DeepL validation failed",
          updatedAt: new Date().toISOString(),
        });
        this.logger.warn(
          {
            event: "dependency_validation_failed",
            dependency: "deepl",
            error: error instanceof Error ? error.message : String(error),
          },
          "DeepL validation failed during startup",
        );
      }
    }

    await this.client.login(this.config.discordToken);
    await this.commandRouter.registerCommands();
    const recovered = this.worker.recoverExpiredJobs();
    this.logger.info({ event: "job_recovery_completed", recovered }, "Recovered stale jobs");

    this.worker.start();
    this.statusService.setReadiness(true);
    this.statusTimer = setInterval(() => this.statusService.logSummary(), 60_000);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.statusService.setReadiness(false);
    this.worker.stop();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    try {
      await this.healthServer.stop();
    } catch {
      // Ignore server shutdown errors during teardown.
    }

    this.client.destroy();
    this.db.close();
    this.started = false;
  }

  private validatePersistentVolume(): void {
    if (this.config.requirePersistentVolume && !this.config.railwayVolumeMountPath) {
      throw new Error("REQUIRE_PERSISTENT_VOLUME=true, but RAILWAY_VOLUME_MOUNT_PATH is not set.");
    }

    if (this.config.railwayVolumeMountPath && !fs.existsSync(this.config.railwayVolumeMountPath)) {
      throw new Error(`Railway volume mount path does not exist: ${this.config.railwayVolumeMountPath}`);
    }
  }
}
