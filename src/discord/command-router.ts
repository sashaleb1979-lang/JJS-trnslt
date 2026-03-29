import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GuildMember,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { Logger } from "pino";
import { AppConfig, AppRepositories, ChannelMappingRow } from "../domain/types";
import { AppError } from "../domain/errors";
import { StatusService } from "../monitoring/status-service";
import { GlossaryManager } from "../translation/glossary-manager";
import { DeepLClient } from "../translation/deepl-client";
import { createId } from "../utils/ids";
import { ensureTextChannel, validateSetupPermissions } from "./permission-guard";

export class CommandRouter {
  constructor(
    private readonly client: Client,
    private readonly repositories: AppRepositories,
    private readonly statusService: StatusService,
    private readonly deepl: DeepLClient,
    private readonly glossaryManager: GlossaryManager,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async registerCommands(): Promise<void> {
    const commands = this.buildCommands().map((command) => command.toJSON());
    const rest = new REST({ version: "10" }).setToken(this.config.discordToken);

    if (this.config.devGuildId) {
      await rest.put(Routes.applicationGuildCommands(this.config.discordApplicationId, this.config.devGuildId), {
        body: commands,
      });
      this.logger.info({ event: "slash_commands_registered", scope: "guild", guild_id: this.config.devGuildId }, "Guild commands registered");
      return;
    }

    await rest.put(Routes.applicationCommands(this.config.discordApplicationId), { body: commands });
    this.logger.info({ event: "slash_commands_registered", scope: "global" }, "Global commands registered");
  }

  async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Эта команда доступна только внутри сервера.", ephemeral: true });
      return;
    }

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(interaction.user.id);
      if (!this.hasAdminAccess(member)) {
        await interaction.reply({ content: "Недостаточно прав для использования этой команды.", ephemeral: true });
        return;
      }

      switch (interaction.commandName) {
        case "setup":
          await this.handleSetup(interaction, member);
          break;
        case "status":
          await this.handleStatus(interaction);
          break;
        case "pause":
          await this.handlePause(interaction);
          break;
        case "resume":
          await this.handleResume(interaction);
          break;
        case "retranslate":
          await this.handleRetranslate(interaction);
          break;
        case "glossary":
          await this.handleGlossary(interaction);
          break;
        default:
          await interaction.reply({ content: "Неизвестная команда.", ephemeral: true });
      }
    } catch (error) {
      this.logger.error(
        {
          event: "admin_command_failed",
          command: interaction.commandName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Admin command failed",
      );
      const message = error instanceof AppError ? error.message : "Команда завершилась ошибкой.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({ content: message, ephemeral: true });
      }
    }
  }

  private buildCommands() {
    const glossary = new SlashCommandBuilder()
      .setName("glossary")
      .setDescription("Управление терминологией DeepL glossary")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Добавить правило в glossary")
          .addStringOption((option) => option.setName("source_term").setDescription("Исходный термин").setRequired(true))
          .addStringOption((option) =>
            option.setName("mode").setDescription("Тип правила").setRequired(true).addChoices(
              { name: "fixed", value: "fixed" },
              { name: "preserve", value: "preserve" },
            ),
          )
          .addStringOption((option) => option.setName("target_term").setDescription("Перевод термина"))
          .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника"))
          .addStringOption((option) => option.setName("target_lang").setDescription("Язык перевода")),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Удалить правило из glossary")
          .addStringOption((option) => option.setName("source_term").setDescription("Исходный термин").setRequired(true))
          .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника"))
          .addStringOption((option) => option.setName("target_lang").setDescription("Язык перевода")),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("Показать glossary правила")
          .addStringOption((option) => option.setName("query").setDescription("Фильтр по строке")),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("preview")
          .setDescription("Показать preview glossary логики")
          .addStringOption((option) => option.setName("text").setDescription("Текст для preview").setRequired(true))
          .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника"))
          .addStringOption((option) => option.setName("target_lang").setDescription("Язык перевода")),
      );

    return [
      new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Создать или обновить mapping raw channel -> output channel")
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Скрытый raw follow channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("output_channel")
            .setDescription("Публичный translated channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника, например EN"))
        .addStringOption((option) => option.setName("target_lang").setDescription("Язык назначения, например RU"))
        .addStringOption((option) => option.setName("source_label").setDescription("Человекочитаемая подпись источника"))
        .addChannelOption((option) =>
          option
            .setName("log_channel")
            .setDescription("Скрытый канал логов бота")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addBooleanOption((option) => option.setName("dry_run").setDescription("Только проверка без записи в БД")),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Показать статус сервиса")
        .addBooleanOption((option) => option.setName("verbose").setDescription("Расширенный статус"))
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Конкретный raw channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Поставить mapping на паузу")
        .addBooleanOption((option) => option.setName("all").setDescription("Пауза для всех mappings сервера"))
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Raw channel для конкретного mapping")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Снять паузу с mapping")
        .addBooleanOption((option) => option.setName("all").setDescription("Resume для всех mappings сервера"))
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Raw channel для конкретного mapping")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      new SlashCommandBuilder()
        .setName("retranslate")
        .setDescription("Переотправить перевод для уже сохраненного raw сообщения")
        .addStringOption((option) => option.setName("message_id").setDescription("ID raw или translated сообщения"))
        .addBooleanOption((option) => option.setName("latest").setDescription("Перевести последнее сообщение для mapping"))
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Raw channel для latest режима")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      glossary,
    ];
  }

  private async handleSetup(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", true));
    const outputChannel = ensureTextChannel(interaction.options.getChannel("output_channel", true));
    const logChannel = ensureTextChannel(interaction.options.getChannel("log_channel", false));
    const sourceLang = (interaction.options.getString("source_lang") ?? this.config.defaultSourceLanguage).toUpperCase();
    const targetLang = (interaction.options.getString("target_lang") ?? this.config.defaultTargetLanguage).toUpperCase();
    const sourceLabel = interaction.options.getString("source_label");
    const dryRun = interaction.options.getBoolean("dry_run") ?? false;

    if (!rawChannel || !outputChannel) {
      throw new AppError({ code: "INVALID_CHANNEL_TYPE", message: "Нужны текстовые каналы.", failureClass: "validation" });
    }
    if (rawChannel.id === outputChannel.id) {
      throw new AppError({ code: "RAW_EQUALS_OUTPUT", message: "raw и output не могут совпадать.", failureClass: "validation" });
    }

    const issues = validateSetupPermissions({
      botMember: member.guild.members.me ?? member.guild.members.cache.get(this.client.user!.id)!,
      rawChannel,
      outputChannel,
    });

    await this.deepl.validateAuth();
    await this.glossaryManager.validateLanguagePair(sourceLang, targetLang);
    if (issues.length > 0) {
      throw new AppError({ code: "SETUP_VALIDATION_FAILED", message: issues.join("\n"), failureClass: "validation" });
    }

    const activeGlossary = this.repositories.glossaryVersions.getActiveByPair(interaction.guildId!, sourceLang, targetLang);
    const pauseReason = activeGlossary ? null : "Нет активного glossary. Добавьте правило через /glossary add и затем выполните /resume.";
    const existing = this.repositories.channelMappings.getByRawChannelId(rawChannel.id);
    const mappingId = existing?.mapping_id ?? createId("map");

    const summaryLines = [
      `Guild: ${interaction.guild!.name}`,
      `Raw: #${rawChannel.name}`,
      `Output: #${outputChannel.name}`,
      `Pair: ${sourceLang} -> ${targetLang}`,
      activeGlossary ? `Glossary: active ${activeGlossary.glossary_version_id}` : "Glossary: пока нет активной версии, mapping будет paused",
      `Log channel: ${logChannel ? `#${logChannel.name}` : this.config.logChannelId ? `ENV ${this.config.logChannelId}` : "not set"}`,
    ];

    if (dryRun) {
      await interaction.reply({ content: `Dry-run OK:\n${summaryLines.join("\n")}`, ephemeral: true });
      return;
    }

    this.repositories.guildSettings.upsert({
      guildId: interaction.guildId!,
      defaultSourceLang: sourceLang,
      defaultTargetLang: targetLang,
      adminRoleIdsJson: JSON.stringify(this.config.adminRoleIds),
      logChannelId: logChannel?.id ?? this.config.logChannelId ?? null,
      publishOriginalOnFailure: this.config.publishOriginalOnExhaustedTransientFailure,
      status: activeGlossary ? "active" : "degraded",
    });
    this.repositories.channelMappings.upsert({
      mappingId,
      guildId: interaction.guildId!,
      rawChannelId: rawChannel.id,
      outputChannelId: outputChannel.id,
      sourceLang,
      targetLang,
      sourceLabelOverride: sourceLabel,
      activeGlossaryVersionId: activeGlossary?.glossary_version_id ?? null,
      renderMode: "auto",
      mediaMode: "auto",
      isPaused: !activeGlossary,
      pauseReason,
    });
    this.repositories.auditLog.insert({
      guildId: interaction.guildId!,
      actorType: "user",
      actorId: interaction.user.id,
      action: "setup_mapping",
      subjectType: "mapping",
      subjectId: mappingId,
      details: {
        rawChannelId: rawChannel.id,
        outputChannelId: outputChannel.id,
        sourceLang,
        targetLang,
        sourceLabel,
      },
    });

    await interaction.reply({
      content: `Mapping сохранен.\n${summaryLines.join("\n")}${pauseReason ? `\n\nПричина паузы: ${pauseReason}` : ""}`,
      ephemeral: true,
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const verbose = interaction.options.getBoolean("verbose") ?? false;
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", false));
    const report = this.statusService.buildReport();
    const mappings = rawChannel
      ? [this.resolveSingleMapping(interaction.guildId!, rawChannel.id)]
      : this.repositories.channelMappings.listByGuildId(interaction.guildId!);

    const mappingLines = mappings
      .filter(Boolean)
      .map((mapping) => {
        const latest = this.repositories.processedRawMessages.getLatestForMapping(mapping!.mapping_id);
        return `- raw <#${mapping!.raw_channel_id}> -> output <#${mapping!.output_channel_id}> | paused=${mapping!.is_paused === 1} | glossary=${mapping!.active_glossary_version_id ?? "none"} | latest=${latest?.raw_message_id ?? "none"}`;
      });

    const lines = [
      `Service: ${report.serviceStatus}`,
      `Discord: ${report.discordGateway}`,
      `DB: ${report.db}`,
      `Volume: ${report.volume}`,
      `DeepL: ${report.deepl}`,
      `Queue depth: ${report.queueDepth}`,
      `Active mappings: ${report.activeMappings}`,
      `Paused mappings: ${report.pausedMappings}`,
      `Last success: ${report.lastSuccessAt ?? "never"}`,
      `Last failure: ${report.lastFailureSummary ?? "none"}`,
      "",
      "Mappings:",
      ...(mappingLines.length > 0 ? mappingLines : ["- none"]),
    ];

    if (verbose) {
      const recentFailures = this.repositories.failedJobs.listRecent(5);
      lines.push("", "Recent failures:");
      lines.push(...(recentFailures.length > 0 ? recentFailures.map((failure) => `- ${failure.failure_code}: ${failure.failure_summary}`) : ["- none"]));
    }

    await interaction.reply({ content: lines.join("\n").slice(0, 1_950), ephemeral: true });
  }

  private async handlePause(interaction: ChatInputCommandInteraction): Promise<void> {
    const mappings = this.resolveMappingsForControl(interaction);
    mappings.forEach((mapping) => this.repositories.channelMappings.setPaused(mapping.mapping_id, true, "Paused by admin"));
    await interaction.reply({
      content: `Пауза включена для ${mappings.length} mapping(s).`,
      ephemeral: true,
    });
  }

  private async handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    const mappings = this.resolveMappingsForControl(interaction);
    for (const mapping of mappings) {
      if (!mapping.active_glossary_version_id) {
        throw new AppError({
          code: "RESUME_BLOCKED_NO_GLOSSARY",
          message: `Нельзя снять паузу с mapping ${mapping.mapping_id}: нет активного glossary.`,
          failureClass: "validation",
        });
      }
      await this.glossaryManager.validateLanguagePair(mapping.source_lang, mapping.target_lang);
      this.repositories.channelMappings.setPaused(mapping.mapping_id, false, null);
    }
    await interaction.reply({ content: `Resume выполнен для ${mappings.length} mapping(s).`, ephemeral: true });
  }

  private async handleRetranslate(interaction: ChatInputCommandInteraction): Promise<void> {
    const messageId = interaction.options.getString("message_id");
    const latest = interaction.options.getBoolean("latest") ?? false;
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", false));

    let rawMessageId: string | null = null;
    if (messageId) {
      const raw = this.repositories.processedRawMessages.getByRawMessageId(messageId);
      if (raw) {
        rawMessageId = raw.raw_message_id;
      } else {
        const output = this.repositories.translatedOutputs.getByPrimaryMessageId(messageId);
        rawMessageId = output?.raw_message_id ?? null;
      }
    } else if (latest) {
      const mapping = rawChannel
        ? this.resolveSingleMapping(interaction.guildId!, rawChannel.id)
        : this.getSingleGuildMapping(interaction.guildId!);
      const latestRaw = this.repositories.processedRawMessages.getLatestForMapping(mapping.mapping_id);
      rawMessageId = latestRaw?.raw_message_id ?? null;
    }

    if (!rawMessageId) {
      throw new AppError({
        code: "RETRANSLATE_TARGET_NOT_FOUND",
        message: "Не удалось определить raw сообщение для retranslate.",
        failureClass: "validation",
      });
    }

    const output = this.repositories.translatedOutputs.getByRawMessageId(rawMessageId);
    if (output) {
      await this.tryDeletePublishedMessages(output.output_channel_id, JSON.parse(output.all_message_ids_json) as string[]);
      this.repositories.translatedOutputs.deleteByRawMessageId(rawMessageId);
    }

    const existingJob = this.repositories.translationJobs.getByRawMessageId(rawMessageId);
    if (existingJob) {
      this.repositories.translationJobs.requeueByRawMessageId(rawMessageId);
    } else {
      const raw = this.repositories.processedRawMessages.getByRawMessageId(rawMessageId);
      if (!raw) {
        throw new AppError({
          code: "RAW_RECORD_MISSING",
          message: "Raw payload не найден в БД.",
          failureClass: "validation",
        });
      }
      this.repositories.translationJobs.enqueue(rawMessageId, raw.mapping_id);
    }

    await interaction.reply({ content: `Retranslate запланирован для raw message ${rawMessageId}.`, ephemeral: true });
  }

  private async handleGlossary(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const guildSettings = this.repositories.guildSettings.getByGuildId(guildId);
    const sourceLang = (interaction.options.getString("source_lang") ?? guildSettings?.default_source_lang ?? this.config.defaultSourceLanguage).toUpperCase();
    const targetLang = (interaction.options.getString("target_lang") ?? guildSettings?.default_target_lang ?? this.config.defaultTargetLanguage).toUpperCase();

    switch (subcommand) {
      case "add": {
        const sourceTerm = interaction.options.getString("source_term", true).trim();
        const mode = interaction.options.getString("mode", true) as "fixed" | "preserve";
        const targetTerm = interaction.options.getString("target_term");
        if (mode === "fixed" && !targetTerm?.trim()) {
          throw new AppError({ code: "GLOSSARY_TARGET_REQUIRED", message: "Для mode=fixed нужен target_term.", failureClass: "validation" });
        }
        if (this.repositories.glossaryRules.getActiveRule(guildId, sourceLang, targetLang, sourceTerm)) {
          throw new AppError({ code: "GLOSSARY_RULE_EXISTS", message: "Такое active glossary правило уже существует.", failureClass: "validation" });
        }

        this.repositories.glossaryRules.addRule({
          guildId,
          sourceLang,
          targetLang,
          ruleType: mode,
          sourceTerm,
          targetTerm: mode === "preserve" ? null : targetTerm!.trim(),
          notes: null,
          userId: interaction.user.id,
        });
        const synced = await this.glossaryManager.syncRulesForPair({ guildId, sourceLang, targetLang });
        this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, synced.glossary_version_id);
        await interaction.reply({
          content: `Glossary правило добавлено. Активна версия ${synced.glossary_version_id} (${sourceLang} -> ${targetLang}).`,
          ephemeral: true,
        });
        break;
      }

      case "remove": {
        const sourceTerm = interaction.options.getString("source_term", true).trim();
        const removed = this.repositories.glossaryRules.archiveRule(guildId, sourceLang, targetLang, sourceTerm, interaction.user.id);
        if (!removed) {
          throw new AppError({ code: "GLOSSARY_RULE_NOT_FOUND", message: "Active glossary правило не найдено.", failureClass: "validation" });
        }

        const activeRules = this.repositories.glossaryRules.listActiveByPair(guildId, sourceLang, targetLang);
        if (activeRules.length === 0) {
          this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, null);
          await interaction.reply({
            content: "Правило удалено. В паре больше нет активных glossary правил, mappings останутся без активного glossary до следующего /glossary add.",
            ephemeral: true,
          });
          return;
        }

        const synced = await this.glossaryManager.syncRulesForPair({ guildId, sourceLang, targetLang });
        this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, synced.glossary_version_id);
        await interaction.reply({
          content: `Правило удалено. Активирована версия ${synced.glossary_version_id}.`,
          ephemeral: true,
        });
        break;
      }

      case "list": {
        const query = interaction.options.getString("query") ?? undefined;
        const rules = this.repositories.glossaryRules.listByGuild(guildId, query).slice(0, 20);
        const lines = rules.map((rule) => `- [${rule.status}] ${rule.source_lang}->${rule.target_lang} ${rule.source_term} => ${rule.rule_type === "preserve" ? "(preserve)" : (rule.target_term ?? "")}`);
        await interaction.reply({
          content: lines.length > 0 ? lines.join("\n").slice(0, 1_950) : "Glossary правил пока нет.",
          ephemeral: true,
        });
        break;
      }

      case "preview": {
        const text = interaction.options.getString("text", true);
        const rules = this.repositories.glossaryRules.listActiveByPair(guildId, sourceLang, targetLang);
        const activeGlossaryVersionId = this.repositories.glossaryVersions.getActiveByPair(guildId, sourceLang, targetLang)?.glossary_version_id ?? null;
        const preview = this.glossaryManager.preview(text, rules, activeGlossaryVersionId);
        const matched = preview.matchedRules.length > 0 ? preview.matchedRules.map((rule) => `- ${rule.source_term}`).join("\n") : "- none";
        await interaction.reply({
          content: [
            `Active version: ${preview.glossaryVersionId ?? "none"}`,
            "Matched rules:",
            matched,
            "",
            "Preview:",
            preview.previewText,
          ].join("\n").slice(0, 1_950),
          ephemeral: true,
        });
        break;
      }
    }
  }

  private hasAdminAccess(member: GuildMember): boolean {
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      this.config.adminRoleIds.some((roleId) => member.roles.cache.has(roleId))
    );
  }

  private resolveSingleMapping(guildId: string, rawChannelId: string): ChannelMappingRow {
    const mapping = this.repositories.channelMappings.getByRawChannelId(rawChannelId);
    if (!mapping || mapping.guild_id !== guildId) {
      throw new AppError({ code: "MAPPING_NOT_FOUND", message: "Mapping для raw channel не найден.", failureClass: "validation" });
    }
    return mapping;
  }

  private getSingleGuildMapping(guildId: string): ChannelMappingRow {
    const mappings = this.repositories.channelMappings.listByGuildId(guildId);
    if (mappings.length !== 1) {
      throw new AppError({
        code: "MAPPING_SELECTION_REQUIRED",
        message: "У сервера несколько mappings. Укажите raw_channel явно.",
        failureClass: "validation",
      });
    }
    return mappings[0];
  }

  private resolveMappingsForControl(interaction: ChatInputCommandInteraction): ChannelMappingRow[] {
    const all = interaction.options.getBoolean("all") ?? false;
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", false));
    if (all) {
      const mappings = this.repositories.channelMappings.listByGuildId(interaction.guildId!);
      if (mappings.length === 0) {
        throw new AppError({ code: "NO_MAPPINGS", message: "Для этого сервера нет mappings.", failureClass: "validation" });
      }
      return mappings;
    }
    if (rawChannel) {
      return [this.resolveSingleMapping(interaction.guildId!, rawChannel.id)];
    }
    return [this.getSingleGuildMapping(interaction.guildId!)];
  }

  private async tryDeletePublishedMessages(channelId: string, messageIds: string[]): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("messages" in channel)) {
        return;
      }
      for (const messageId of messageIds) {
        try {
          const message = await channel.messages.fetch(messageId);
          if (message.deletable) {
            await message.delete();
          }
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }
}
