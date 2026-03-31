import {
  ActionRowBuilder,
  Attachment,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GuildMember,
  MessageComponentInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Logger } from "pino";
import { MEDIA_MODE, MediaMode, RENDER_MODE, RenderMode } from "../domain/enums";
import { AppConfig, AppRepositories, ChannelMappingRow } from "../domain/types";
import { AppError } from "../domain/errors";
import { StatusService } from "../monitoring/status-service";
import { GlossaryManager } from "../translation/glossary-manager";
import { DeepLClient } from "../translation/deepl-client";
import { parseBulkGlossaryPayload, formatParseErrors } from "../translation/glossary-bulk-importer";
import { createId } from "../utils/ids";
import { ensureTextChannel, SupportedSetupChannel, validateSetupPermissions } from "./permission-guard";

type PanelView = "main" | "setup";

interface PanelSession {
  userId: string;
  guildId: string;
  selectedMappingId: string | null;
  view: PanelView;
  setupRawChannelId: string | null;
  setupOutputChannelId: string | null;
  setupLogChannelId: string | null;
  createdAt: number;
  updatedAt: number;
}

const PANEL_PREFIX = "panel";
const PANEL_SESSION_TTL_MS = 30 * 60 * 1000;

export class CommandRouter {
  private readonly panelSessions = new Map<string, PanelSession>();

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
      await interaction.reply({ content: "Эта команда доступна только внутри сервера.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(interaction.user.id);
      if (!this.hasAdminAccess(member)) {
        await interaction.reply({ content: "Недостаточно прав для использования этой команды.", flags: MessageFlags.Ephemeral });
        return;
      }

      switch (interaction.commandName) {
        case "panel":
          await this.handlePanel(interaction);
          break;
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
          await interaction.reply({ content: "Неизвестная команда.", flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      this.logger.error(
        {
          event: "admin_command_failed",
          command: interaction.commandName,
          error_code: appError?.code,
          error_details: appError?.details,
          error: error instanceof Error ? error.message : String(error),
        },
        `Admin command failed (command=${interaction.commandName}, code=${appError?.code ?? "unknown"}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const message = appError ? this.formatAppErrorForDiscord(appError) : "Команда завершилась ошибкой.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    }
  }

  async handleComponentInteraction(
    interaction: ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Эта команда доступна только внутри сервера.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!this.hasAdminAccess(member)) {
      await interaction.reply({ content: "Недостаточно прав для использования этой команды.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const [prefix, action, sessionId] = interaction.customId.split(":");
      if (prefix !== PANEL_PREFIX || !action || !sessionId) {
        return;
      }

      const session = this.getPanelSession(sessionId, interaction.user.id, interaction.guildId!);
      switch (action) {
        case "mapping":
          await this.handlePanelMappingSelect(interaction as StringSelectMenuInteraction, session);
          break;
        case "refresh":
          await this.refreshPanel(interaction, session);
          break;
        case "pause-toggle":
          await this.handlePanelPauseToggle(interaction as ButtonInteraction, session);
          break;
        case "retranslate-latest":
          await this.handlePanelRetranslateLatest(interaction as ButtonInteraction, session);
          break;
        case "restart-backlog":
          await this.handlePanelRestartBacklog(interaction as ButtonInteraction, session);
          break;
        case "setup-open":
          await this.handlePanelSetupOpen(interaction as ButtonInteraction, session);
          break;
        case "setup-raw":
          await this.handlePanelSetupChannelSelect(interaction as ChannelSelectMenuInteraction, session, "raw");
          break;
        case "setup-output":
          await this.handlePanelSetupChannelSelect(interaction as ChannelSelectMenuInteraction, session, "output");
          break;
        case "setup-log":
          await this.handlePanelSetupChannelSelect(interaction as ChannelSelectMenuInteraction, session, "log");
          break;
        case "setup-clear-log":
          session.setupLogChannelId = null;
          session.updatedAt = Date.now();
          await this.refreshPanel(interaction, session, "Лог-канал очищен для следующего сохранения.");
          break;
        case "setup-modal":
          await this.showPanelSetupModal(interaction as ButtonInteraction, session);
          break;
        case "setup-back":
          session.view = "main";
          session.updatedAt = Date.now();
          await this.refreshPanel(interaction, session);
          break;
        case "glossary-import":
          await this.showPanelGlossaryImportModal(interaction as ButtonInteraction, session);
          break;
        case "glossary-list":
          await this.handlePanelGlossaryList(interaction as ButtonInteraction, session);
          break;
        case "glossary-clear-pair":
          await this.handlePanelGlossaryClearPair(interaction as ButtonInteraction, session);
          break;
        case "glossary-clear-all":
          await this.handlePanelGlossaryClearAll(interaction as ButtonInteraction, session);
          break;
        default:
          await interaction.reply({ content: "Неизвестное действие панели.", flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      this.logger.error(
        {
          event: "panel_component_failed",
          custom_id: interaction.customId,
          error_code: appError?.code,
          error_details: appError?.details,
          error: error instanceof Error ? error.message : String(error),
        },
        `Panel interaction failed (custom_id=${interaction.customId}, code=${appError?.code ?? "unknown"}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const message = appError ? this.formatAppErrorForDiscord(appError) : "Панель завершилась ошибкой.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    }
  }

  async handleModalInteraction(interaction: ModalSubmitInteraction): Promise<void> {
    try {
      if (interaction.customId.startsWith("glossary_import|")) {
        await this.handleGlossaryImportModal(interaction);
        return;
      }

      if (interaction.customId.startsWith(`${PANEL_PREFIX}:setup-modal:`)) {
        await this.handlePanelSetupModal(interaction);
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      this.logger.error(
        {
          event: "modal_interaction_failed",
          custom_id: interaction.customId,
          error_code: appError?.code,
          error: error instanceof Error ? error.message : String(error),
        },
        `Modal interaction failed (custom_id=${interaction.customId}, code=${appError?.code ?? "unknown"}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const message = appError?.message ?? "Форма завершилась ошибкой.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
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
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("import")
          .setDescription("Массовый импорт glossary из текстового блока (открывает форму ввода)")
          .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника (по умолчанию из настроек)"))
          .addStringOption((option) => option.setName("target_lang").setDescription("Язык перевода (по умолчанию из настроек)"))
          .addAttachmentOption((option) => option.setName("file").setDescription("TXT/MD файл с glossary payload; если не указан, откроется форма ввода"))
          .addBooleanOption((option) => option.setName("dry_run").setDescription("Только проверка, без записи в БД"))
          .addBooleanOption((option) => option.setName("replace_existing").setDescription("Заменять существующие правила при конфликте (по умолчанию false)")),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Очистить glossary: для конкретной пары или полностью для сервера")
          .addBooleanOption((option) => option.setName("all").setDescription("Очистить ВСЕ glossary правила сервера (все пары)"))
          .addStringOption((option) => option.setName("source_lang").setDescription("Язык источника (для очистки конкретной пары)"))
          .addStringOption((option) => option.setName("target_lang").setDescription("Язык перевода (для очистки конкретной пары)")),
      );

    return [
      new SlashCommandBuilder()
        .setName("panel")
        .setDescription("Открыть единую панель управления ботом"),
      new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Создать или обновить связку raw-канала и выходного канала")
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
        .setDescription("Поставить связку каналов на паузу")
        .addBooleanOption((option) => option.setName("all").setDescription("Пауза для всех mappings сервера"))
        .addChannelOption((option) =>
          option
            .setName("raw_channel")
            .setDescription("Raw channel для конкретного mapping")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
      new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Снять паузу со связки каналов")
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

  private async handlePanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const mappings = this.repositories.channelMappings.listByGuildId(interaction.guildId!);
    const sessionId = this.createPanelSession({
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      selectedMappingId: mappings[0]?.mapping_id ?? null,
    });

    await interaction.reply({
      ...this.buildPanelMessage(this.getPanelSession(sessionId, interaction.user.id, interaction.guildId!)),
      flags: MessageFlags.Ephemeral,
    });
  }

  private createPanelSession(input: { userId: string; guildId: string; selectedMappingId: string | null }): string {
    this.cleanupPanelSessions();
    const sessionId = createId("panel");
    const now = Date.now();
    this.panelSessions.set(sessionId, {
      userId: input.userId,
      guildId: input.guildId,
      selectedMappingId: input.selectedMappingId,
      view: "main",
      setupRawChannelId: null,
      setupOutputChannelId: null,
      setupLogChannelId: null,
      createdAt: now,
      updatedAt: now,
    });
    return sessionId;
  }

  private cleanupPanelSessions(): void {
    const threshold = Date.now() - PANEL_SESSION_TTL_MS;
    for (const [sessionId, session] of this.panelSessions) {
      if (session.updatedAt < threshold) {
        this.panelSessions.delete(sessionId);
      }
    }
  }

  private getPanelSession(sessionId: string, userId: string, guildId: string): PanelSession {
    this.cleanupPanelSessions();
    const session = this.panelSessions.get(sessionId);
    if (!session || session.userId !== userId || session.guildId !== guildId) {
      throw new AppError({
        code: "PANEL_SESSION_EXPIRED",
        message: "Панель устарела. Запустите /panel ещё раз.",
        failureClass: "validation",
      });
    }

    session.updatedAt = Date.now();
    return session;
  }

  private buildPanelMessage(session: PanelSession, banner?: string) {
    const mappings = this.repositories.channelMappings.listByGuildId(session.guildId);
    const selectedMapping = this.resolvePanelSelectedMapping(session, mappings);
    const guildSettings = this.repositories.guildSettings.getByGuildId(session.guildId);
    const report = this.statusService.buildReport();
    const statusLine = [
      `Сервис: ${report.serviceStatus}`,
      `Discord: ${report.discordGateway}`,
      `DeepL: ${report.deepl}`,
      `Очередь: ${report.queueDepth}`,
      `Активных mappings: ${report.activeMappings}`,
      `На паузе: ${report.pausedMappings}`,
    ].join(" | ");

    const lines = [banner, "Панель управления переводчиком", statusLine, ""];
    if (session.view === "setup") {
      const selected = selectedMapping;
      lines.push(selected ? `Редактирование связки: <#${selected.raw_channel_id}> -> <#${selected.output_channel_id}>` : "Создание новой связки каналов");
      lines.push(`Raw канал: ${session.setupRawChannelId ? `<#${session.setupRawChannelId}>` : "не выбран"}`);
      lines.push(`Output канал: ${session.setupOutputChannelId ? `<#${session.setupOutputChannelId}>` : "не выбран"}`);
      lines.push(`Log канал: ${session.setupLogChannelId ? `<#${session.setupLogChannelId}>` : "не задан"}`);
      lines.push(`Пара по умолчанию: ${(selected?.source_lang ?? guildSettings?.default_source_lang ?? this.config.defaultSourceLanguage).toUpperCase()} -> ${(selected?.target_lang ?? guildSettings?.default_target_lang ?? this.config.defaultTargetLanguage).toUpperCase()}`);
      lines.push("Дальше нажмите «Сохранить детали», чтобы ввести языки, подпись источника и режимы публикации.");
    } else if (selectedMapping) {
      const pending = this.repositories.translationJobs.countByMappingAndStatus(selectedMapping.mapping_id, "pending");
      const retry = this.repositories.translationJobs.countByMappingAndStatus(selectedMapping.mapping_id, "retry_wait");
      const failed = this.repositories.translationJobs.countByMappingAndStatus(selectedMapping.mapping_id, "failed");
      const latest = this.repositories.processedRawMessages.getLatestForMapping(selectedMapping.mapping_id);
      lines.push(`Выбранная связка: <#${selectedMapping.raw_channel_id}> -> <#${selectedMapping.output_channel_id}>`);
      lines.push(`Языки: ${selectedMapping.source_lang} -> ${selectedMapping.target_lang}`);
      lines.push(`Рендер: ${selectedMapping.render_mode} | Медиа: ${selectedMapping.media_mode}`);
      lines.push(`Glossary: ${selectedMapping.active_glossary_version_id ?? "none"}`);
      lines.push(`Статус: ${selectedMapping.is_paused === 1 ? `пауза (${selectedMapping.pause_reason ?? "без причины"})` : "активен"}`);
      lines.push(`Очередь связки: pending=${pending} retry=${retry} failed=${failed}`);
      lines.push(`Последний raw: ${latest?.raw_message_id ?? "none"}`);
      lines.push("Быстрые действия ниже: пауза, перезапуск хвоста, retranslate последнего сообщения и glossary.");
    } else {
      lines.push("Для этого сервера ещё нет связки каналов. Нажмите «Настроить связку», чтобы создать первую.");
    }

    return {
      content: lines.filter(Boolean).join("\n").slice(0, 1_900),
      components: session.view === "setup" ? this.buildSetupPanelComponents(session) : this.buildMainPanelComponents(session),
    };
  }

  private buildMainPanelComponents(session: PanelSession) {
    const mappings = this.repositories.channelMappings.listByGuildId(session.guildId);
    const selectedMapping = this.resolvePanelSelectedMapping(session, mappings);
    const mappingMenu = new StringSelectMenuBuilder()
      .setCustomId(`${PANEL_PREFIX}:mapping:${this.findPanelSessionId(session)}`)
      .setPlaceholder(mappings.length > 0 ? "Выберите mapping" : "Нет mappings")
      .setDisabled(mappings.length === 0)
      .addOptions(
        (mappings.length > 0 ? mappings : [{ mapping_id: "none", raw_channel_id: "0", output_channel_id: "0", source_lang: "", target_lang: "", is_paused: 0 } as ChannelMappingRow]).map((mapping) => ({
          label: mapping.mapping_id === "none" ? "Нет mappings" : `${mapping.source_lang} -> ${mapping.target_lang}`,
          value: mapping.mapping_id,
          description: mapping.mapping_id === "none" ? "Сначала создайте mapping" : `<#${mapping.raw_channel_id}> -> <#${mapping.output_channel_id}>${mapping.is_paused === 1 ? " • paused" : ""}`,
          default: mapping.mapping_id === session.selectedMappingId,
        })),
      );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PANEL_PREFIX}:refresh:${this.findPanelSessionId(session)}`).setLabel("Обновить").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:pause-toggle:${this.findPanelSessionId(session)}`)
        .setLabel(selectedMapping?.is_paused === 1 ? "Resume" : "Пауза")
        .setStyle(selectedMapping?.is_paused === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:retranslate-latest:${this.findPanelSessionId(session)}`)
        .setLabel("Retranslate latest")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:restart-backlog:${this.findPanelSessionId(session)}`)
        .setLabel("Перезапуск хвоста")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:setup-open:${this.findPanelSessionId(session)}`)
        .setLabel("Настроить связку")
        .setStyle(ButtonStyle.Success),
    );

    const glossaryButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:glossary-import:${this.findPanelSessionId(session)}`)
        .setLabel("Импорт glossary")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:glossary-list:${this.findPanelSessionId(session)}`)
        .setLabel("Список glossary")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:glossary-clear-pair:${this.findPanelSessionId(session)}`)
        .setLabel("Очистить glossary пары")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!selectedMapping),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:glossary-clear-all:${this.findPanelSessionId(session)}`)
        .setLabel("Очистить весь glossary")
        .setStyle(ButtonStyle.Danger),
    );

    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(mappingMenu), buttons, glossaryButtons];
  }

  private buildSetupPanelComponents(session: PanelSession) {
    const sessionId = this.findPanelSessionId(session);
    const rawSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${PANEL_PREFIX}:setup-raw:${sessionId}`)
      .setPlaceholder(session.setupRawChannelId ? `Raw: ${session.setupRawChannelId}` : "Выберите raw-канал")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);
    const outputSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${PANEL_PREFIX}:setup-output:${sessionId}`)
      .setPlaceholder(session.setupOutputChannelId ? `Output: ${session.setupOutputChannelId}` : "Выберите output-канал")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);
    const logSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${PANEL_PREFIX}:setup-log:${sessionId}`)
      .setPlaceholder(session.setupLogChannelId ? `Log: ${session.setupLogChannelId}` : "Опционально: log-канал")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:setup-modal:${sessionId}`)
        .setLabel("Сохранить детали")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:setup-clear-log:${sessionId}`)
        .setLabel("Очистить log")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:setup-back:${sessionId}`)
        .setLabel("Назад")
        .setStyle(ButtonStyle.Secondary),
    );

    return [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(rawSelect),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(outputSelect),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(logSelect),
      buttons,
    ];
  }

  private findPanelSessionId(session: PanelSession): string {
    for (const [sessionId, stored] of this.panelSessions) {
      if (stored === session) {
        return sessionId;
      }
    }

    throw new AppError({ code: "PANEL_SESSION_NOT_FOUND", message: "Панель устарела. Запустите /panel ещё раз.", failureClass: "validation" });
  }

  private resolvePanelSelectedMapping(session: PanelSession, mappings: ChannelMappingRow[]): ChannelMappingRow | null {
    if (session.selectedMappingId) {
      const selected = mappings.find((mapping) => mapping.mapping_id === session.selectedMappingId);
      if (selected) {
        return selected;
      }
    }

    session.selectedMappingId = mappings[0]?.mapping_id ?? null;
    return mappings[0] ?? null;
  }

  private async refreshPanel(interaction: ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction, session: PanelSession, banner?: string): Promise<void> {
    await interaction.update(this.buildPanelMessage(session, banner));
  }

  private async refreshDeferredPanel(interaction: ButtonInteraction, session: PanelSession, banner?: string): Promise<void> {
    await interaction.editReply(this.buildPanelMessage(session, banner));
  }

  private async handlePanelMappingSelect(interaction: StringSelectMenuInteraction, session: PanelSession): Promise<void> {
    session.selectedMappingId = interaction.values[0] === "none" ? null : interaction.values[0];
    session.view = "main";
    await this.refreshPanel(interaction, session);
  }

  private async handlePanelPauseToggle(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferUpdate();
    const mapping = this.requireSelectedMapping(session);
    if (mapping.is_paused === 1) {
      await this.glossaryManager.validateLanguagePair(mapping.source_lang, mapping.target_lang);
      this.repositories.channelMappings.setPaused(mapping.mapping_id, false, null);
      await this.refreshDeferredPanel(interaction, session, "Связка снята с паузы.");
      return;
    }

    this.repositories.channelMappings.setPaused(mapping.mapping_id, true, "Paused from /panel");
    await this.refreshDeferredPanel(interaction, session, "Связка поставлена на паузу.");
  }

  private async handlePanelRetranslateLatest(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferUpdate();
    const mapping = this.requireSelectedMapping(session);
    const latestRaw = this.repositories.processedRawMessages.getLatestForMapping(mapping.mapping_id);
    if (!latestRaw) {
      throw new AppError({ code: "LATEST_RAW_NOT_FOUND", message: "Для этой связки ещё нет raw сообщений.", failureClass: "validation" });
    }

    await this.scheduleRetranslate(latestRaw.raw_message_id);
    await this.refreshDeferredPanel(interaction, session, `Повторный перевод запланирован для ${latestRaw.raw_message_id}.`);
  }

  private async handlePanelRestartBacklog(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferUpdate();
    const mapping = this.requireSelectedMapping(session);
    if (mapping.is_paused === 1) {
      await this.glossaryManager.validateLanguagePair(mapping.source_lang, mapping.target_lang);
      this.repositories.channelMappings.setPaused(mapping.mapping_id, false, null);
    }

    const rawMessageIds = this.repositories.translationJobs.requeueFailedByMappingId(mapping.mapping_id, 50);
    this.repositories.failedJobs.markResolvedByRawMessageIds(rawMessageIds, "Requeued from /panel");
    await this.refreshDeferredPanel(
      interaction,
      session,
      rawMessageIds.length > 0
        ? `Хвост перезапущен: requeue ${rawMessageIds.length} failed job(s).`
        : "Хвост проверен: failed jobs не найдено, pending/retry будут обработаны автоматически.",
    );
  }

  private async handlePanelSetupOpen(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    const mapping = session.selectedMappingId ? this.repositories.channelMappings.getByMappingId(session.selectedMappingId) : null;
    const guildSettings = this.repositories.guildSettings.getByGuildId(session.guildId);
    session.view = "setup";
    session.setupRawChannelId = mapping?.raw_channel_id ?? null;
    session.setupOutputChannelId = mapping?.output_channel_id ?? null;
    session.setupLogChannelId = guildSettings?.log_channel_id ?? null;
    await this.refreshPanel(interaction, session);
  }

  private async handlePanelSetupChannelSelect(
    interaction: ChannelSelectMenuInteraction,
    session: PanelSession,
    field: "raw" | "output" | "log",
  ): Promise<void> {
    const selectedChannelId = interaction.values[0] ?? null;
    if (field === "raw") {
      session.setupRawChannelId = selectedChannelId;
    } else if (field === "output") {
      session.setupOutputChannelId = selectedChannelId;
    } else {
      session.setupLogChannelId = selectedChannelId;
    }
    session.updatedAt = Date.now();
    await this.refreshPanel(interaction, session);
  }

  private async showPanelSetupModal(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    const mapping = session.selectedMappingId ? this.repositories.channelMappings.getByMappingId(session.selectedMappingId) : null;
    const guildSettings = this.repositories.guildSettings.getByGuildId(session.guildId);
    const modal = new ModalBuilder().setCustomId(`${PANEL_PREFIX}:setup-modal:${this.findPanelSessionId(session)}`).setTitle("Настройка mapping");
    const sourceLangInput = new TextInputBuilder()
      .setCustomId("source_lang")
      .setLabel("Язык источника")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((mapping?.source_lang ?? guildSettings?.default_source_lang ?? this.config.defaultSourceLanguage).toUpperCase());
    const targetLangInput = new TextInputBuilder()
      .setCustomId("target_lang")
      .setLabel("Язык перевода")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((mapping?.target_lang ?? guildSettings?.default_target_lang ?? this.config.defaultTargetLanguage).toUpperCase());
    const sourceLabelInput = new TextInputBuilder()
      .setCustomId("source_label")
      .setLabel("Подпись источника")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(mapping?.source_label_override ?? "");
    const renderModeInput = new TextInputBuilder()
      .setCustomId("render_mode")
      .setLabel("Render mode: auto | embed | plain")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(mapping?.render_mode ?? "auto");
    const mediaModeInput = new TextInputBuilder()
      .setCustomId("media_mode")
      .setLabel("Media mode: auto | mirror | link_only")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(mapping?.media_mode ?? "auto");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(sourceLangInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(targetLangInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(sourceLabelInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(renderModeInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(mediaModeInput),
    );

    await interaction.showModal(modal);
  }

  private async handlePanelSetupModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Эта команда доступна только внутри сервера.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!this.hasAdminAccess(member)) {
      await interaction.reply({ content: "Недостаточно прав для использования этой команды.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, , sessionId] = interaction.customId.split(":");
    const session = this.getPanelSession(sessionId, interaction.user.id, interaction.guildId!);
    if (!session.setupRawChannelId || !session.setupOutputChannelId) {
      throw new AppError({
        code: "PANEL_SETUP_CHANNELS_REQUIRED",
        message: "Сначала выберите raw и output каналы в панели.",
        failureClass: "validation",
      });
    }

    const rawChannel = ensureTextChannel(await this.client.channels.fetch(session.setupRawChannelId));
    const outputChannel = ensureTextChannel(await this.client.channels.fetch(session.setupOutputChannelId));
    const logChannel = session.setupLogChannelId ? ensureTextChannel(await this.client.channels.fetch(session.setupLogChannelId)) : null;
    const renderMode = this.parseRenderMode(interaction.fields.getTextInputValue("render_mode"));
    const mediaMode = this.parseMediaMode(interaction.fields.getTextInputValue("media_mode"));

    const result = await this.saveMapping({
      guildId: interaction.guildId!,
      guildName: interaction.guild.name,
      actorId: interaction.user.id,
      member,
      rawChannel,
      outputChannel,
      logChannel,
      sourceLang: interaction.fields.getTextInputValue("source_lang").trim().toUpperCase(),
      targetLang: interaction.fields.getTextInputValue("target_lang").trim().toUpperCase(),
      sourceLabel: interaction.fields.getTextInputValue("source_label").trim() || null,
      renderMode,
      mediaMode,
      dryRun: false,
      existingMappingId: session.selectedMappingId,
    });

    session.selectedMappingId = result.mappingId;
    session.view = "main";
    session.updatedAt = Date.now();
    await interaction.editReply({
      ...this.buildPanelMessage(session, `Связка сохранена. ${result.summaryLines.join(" | ")}`),
    });
  }

  private async showPanelGlossaryImportModal(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    const mapping = this.requireSelectedMapping(session);
    const customId = `glossary_import|${mapping.source_lang}|${mapping.target_lang}|false|true`;
    const modal = new ModalBuilder().setCustomId(customId).setTitle("Массовый импорт Glossary");
    const payloadInput = new TextInputBuilder()
      .setCustomId("payload")
      .setLabel("Вставьте glossary payload")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Можно без секций:\nragdoll = опрокид\ncombo extender = продление комбо\nGojo")
      .setRequired(true)
      .setMaxLength(4000);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(payloadInput));
    await interaction.showModal(modal);
  }

  private async handlePanelGlossaryList(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const mapping = this.requireSelectedMapping(session);
    const lines = this.formatGlossaryLines(session.guildId, mapping.source_lang, mapping.target_lang);
    await interaction.editReply({ content: lines.join("\n").slice(0, 1_950) });
  }

  private async handlePanelGlossaryClearPair(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferUpdate();
    const mapping = this.requireSelectedMapping(session);
    const deleted = this.repositories.glossaryRules.deleteAllByPair(session.guildId, mapping.source_lang, mapping.target_lang);
    if (deleted > 0) {
      this.repositories.channelMappings.updateActiveGlossaryForPair(session.guildId, mapping.source_lang, mapping.target_lang, null);
    }
    await this.refreshDeferredPanel(
      interaction, session,
      deleted > 0
        ? `Glossary ${mapping.source_lang} -> ${mapping.target_lang} очищен: удалено ${deleted} правил(о).`
        : `Активных glossary правил для ${mapping.source_lang} -> ${mapping.target_lang} не найдено.`,
    );
  }

  private async handlePanelGlossaryClearAll(interaction: ButtonInteraction, session: PanelSession): Promise<void> {
    await interaction.deferUpdate();
    const deleted = this.repositories.glossaryRules.deleteAllByGuild(session.guildId);
    if (deleted > 0) {
      const allMappings = this.repositories.channelMappings.listByGuildId(session.guildId);
      for (const m of allMappings) {
        this.repositories.channelMappings.updateActiveGlossaryForPair(session.guildId, m.source_lang, m.target_lang, null);
      }
    }
    await this.refreshDeferredPanel(
      interaction, session,
      deleted > 0
        ? `Весь glossary сервера очищен: удалено ${deleted} правил(о).`
        : "Активных glossary правил на сервере не найдено.",
    );
  }

  private requireSelectedMapping(session: PanelSession): ChannelMappingRow {
    const mapping = session.selectedMappingId ? this.repositories.channelMappings.getByMappingId(session.selectedMappingId) : null;
    if (!mapping) {
      throw new AppError({ code: "PANEL_MAPPING_REQUIRED", message: "Сначала выберите связку каналов в панели.", failureClass: "validation" });
    }
    return mapping;
  }

  private parseRenderMode(value: string): RenderMode {
    const normalized = value.trim().toLowerCase() as RenderMode;
    if (!RENDER_MODE.includes(normalized)) {
      throw new AppError({ code: "INVALID_RENDER_MODE", message: `render_mode должен быть одним из: ${RENDER_MODE.join(", ")}.`, failureClass: "validation" });
    }
    return normalized;
  }

  private parseMediaMode(value: string): MediaMode {
    const normalized = value.trim().toLowerCase() as MediaMode;
    if (!MEDIA_MODE.includes(normalized)) {
      throw new AppError({ code: "INVALID_MEDIA_MODE", message: `media_mode должен быть одним из: ${MEDIA_MODE.join(", ")}.`, failureClass: "validation" });
    }
    return normalized;
  }

  private formatGlossaryLines(guildId: string, sourceLang: string, targetLang: string): string[] {
    const rules = this.repositories.glossaryRules.listActiveByPair(guildId, sourceLang, targetLang).slice(0, 20);
    if (rules.length === 0) {
      return [`Glossary ${sourceLang} -> ${targetLang}: правил пока нет.`];
    }

    return [
      `Glossary ${sourceLang} -> ${targetLang}:`,
      ...rules.map((rule) => `- ${rule.source_term} => ${rule.rule_type === "preserve" ? "(preserve)" : (rule.target_term ?? "")}`),
    ];
  }

  private async scheduleRetranslate(rawMessageId: string): Promise<void> {
    const output = this.repositories.translatedOutputs.getByRawMessageId(rawMessageId);
    if (output) {
      await this.tryDeletePublishedMessages(output.output_channel_id, JSON.parse(output.all_message_ids_json) as string[]);
      this.repositories.translatedOutputs.deleteByRawMessageId(rawMessageId);
    }

    const existingJob = this.repositories.translationJobs.getByRawMessageId(rawMessageId);
    if (existingJob) {
      this.repositories.translationJobs.requeueByRawMessageId(rawMessageId);
      return;
    }

    const raw = this.repositories.processedRawMessages.getByRawMessageId(rawMessageId);
    if (!raw) {
      throw new AppError({ code: "RAW_RECORD_MISSING", message: "Raw payload не найден в БД.", failureClass: "validation" });
    }

    this.repositories.translationJobs.enqueue(rawMessageId, raw.mapping_id);
  }

  private async saveMapping(input: {
    guildId: string;
    guildName: string;
    actorId: string;
    member: GuildMember;
    rawChannel: SupportedSetupChannel | null;
    outputChannel: SupportedSetupChannel | null;
    logChannel: SupportedSetupChannel | null;
    sourceLang: string;
    targetLang: string;
    sourceLabel: string | null;
    renderMode: RenderMode;
    mediaMode: MediaMode;
    dryRun: boolean;
    existingMappingId: string | null;
  }): Promise<{ mappingId: string; summaryLines: string[] }> {
    if (!input.rawChannel || !input.outputChannel) {
      throw new AppError({ code: "INVALID_CHANNEL_TYPE", message: "Нужны текстовые каналы.", failureClass: "validation" });
    }
    if (input.rawChannel.id === input.outputChannel.id) {
      throw new AppError({ code: "RAW_EQUALS_OUTPUT", message: "raw и output не могут совпадать.", failureClass: "validation" });
    }

    const issues = validateSetupPermissions({
      botMember: input.member.guild.members.me ?? input.member.guild.members.cache.get(this.client.user!.id)!,
      rawChannel: input.rawChannel,
      outputChannel: input.outputChannel,
    });

    await this.deepl.validateAuth();
    await this.glossaryManager.validateLanguagePair(input.sourceLang, input.targetLang);
    if (issues.length > 0) {
      throw new AppError({ code: "SETUP_VALIDATION_FAILED", message: issues.join("\n"), failureClass: "validation" });
    }

    const activeGlossary = this.repositories.glossaryVersions.getActiveByPair(input.guildId, input.sourceLang, input.targetLang);
    const existing = (input.existingMappingId ? this.repositories.channelMappings.getByMappingId(input.existingMappingId) : null)
      ?? this.repositories.channelMappings.getByRawChannelId(input.rawChannel.id);
    const mappingId = existing?.mapping_id ?? createId("map");

    const summaryLines = [
      `Guild: ${input.guildName}`,
      `Raw: #${input.rawChannel.name}`,
      `Output: #${input.outputChannel.name}`,
      `Pair: ${input.sourceLang} -> ${input.targetLang}`,
      `Render/media: ${input.renderMode} / ${input.mediaMode}`,
      activeGlossary ? `Glossary: active ${activeGlossary.glossary_version_id}` : "Glossary: нет активной версии",
      `Log channel: ${input.logChannel ? `#${input.logChannel.name}` : this.config.logChannelId ? `ENV ${this.config.logChannelId}` : "not set"}`,
    ];

    if (input.dryRun) {
      return { mappingId, summaryLines };
    }

    this.repositories.guildSettings.upsert({
      guildId: input.guildId,
      defaultSourceLang: input.sourceLang,
      defaultTargetLang: input.targetLang,
      adminRoleIdsJson: JSON.stringify(this.config.adminRoleIds),
      logChannelId: input.logChannel?.id ?? null,
      publishOriginalOnFailure: this.config.publishOriginalOnExhaustedTransientFailure,
      status: "active",
    });
    this.repositories.channelMappings.upsert({
      mappingId,
      guildId: input.guildId,
      rawChannelId: input.rawChannel.id,
      outputChannelId: input.outputChannel.id,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      sourceLabelOverride: input.sourceLabel,
      activeGlossaryVersionId: activeGlossary?.glossary_version_id ?? null,
      renderMode: input.renderMode,
      mediaMode: input.mediaMode,
      isPaused: false,
      pauseReason: null,
    });
    this.repositories.auditLog.insert({
      guildId: input.guildId,
      actorType: "user",
      actorId: input.actorId,
      action: "setup_mapping",
      subjectType: "mapping",
      subjectId: mappingId,
      details: {
        rawChannelId: input.rawChannel.id,
        outputChannelId: input.outputChannel.id,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        sourceLabel: input.sourceLabel,
        renderMode: input.renderMode,
        mediaMode: input.mediaMode,
      },
    });

    return { mappingId, summaryLines };
  }

  private async handleSetup(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", true));
    const outputChannel = ensureTextChannel(interaction.options.getChannel("output_channel", true));
    const logChannel = ensureTextChannel(interaction.options.getChannel("log_channel", false));
    const sourceLang = (interaction.options.getString("source_lang") ?? this.config.defaultSourceLanguage).toUpperCase();
    const targetLang = (interaction.options.getString("target_lang") ?? this.config.defaultTargetLanguage).toUpperCase();
    const sourceLabel = interaction.options.getString("source_label");
    const dryRun = interaction.options.getBoolean("dry_run") ?? false;

    const result = await this.saveMapping({
      guildId: interaction.guildId!,
      guildName: interaction.guild!.name,
      actorId: interaction.user.id,
      member,
      rawChannel,
      outputChannel,
      logChannel,
      sourceLang,
      targetLang,
      sourceLabel,
      renderMode: "auto",
      mediaMode: "auto",
      dryRun,
      existingMappingId: null,
    });

    await interaction.reply({
      content: `${dryRun ? "Dry-run OK" : "Связка сохранена."}\n${result.summaryLines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const verbose = interaction.options.getBoolean("verbose") ?? false;
    const rawChannel = ensureTextChannel(interaction.options.getChannel("raw_channel", false));
    const report = this.statusService.buildReport();
    const mappings = rawChannel
      ? [this.resolveSingleMapping(interaction.guildId!, rawChannel.id)]
      : this.repositories.channelMappings.listByGuildId(interaction.guildId!);
    const MAX_ERROR_MESSAGE_LENGTH = 60;
    const MAX_FAILURE_SUMMARY_LENGTH = 80;

    const mappingLines = mappings
      .filter(Boolean)
      .flatMap((mapping) => {
        const m = mapping!;
        const latest = this.repositories.processedRawMessages.getLatestForMapping(m.mapping_id);
        const recentJobs = this.repositories.translationJobs.listRecentByMappingId(m.mapping_id, 3);
        const pendingCount = this.repositories.translationJobs.countByMappingAndStatus(m.mapping_id, "pending");
        const retryCount = this.repositories.translationJobs.countByMappingAndStatus(m.mapping_id, "retry_wait");
        const failedCount = this.repositories.translationJobs.countByMappingAndStatus(m.mapping_id, "failed");

        const header = `- raw <#${m.raw_channel_id}> → output <#${m.output_channel_id}> | paused=${m.is_paused === 1} | glossary=${m.active_glossary_version_id ?? "none"}`;
        const jobSummary = `  jobs: pending=${pendingCount} retry=${retryCount} failed=${failedCount} | latest_raw=${latest?.raw_message_id ?? "none"}`;

        const diagLines: string[] = [header, jobSummary];

        if (verbose && recentJobs.length > 0) {
          diagLines.push("  recent jobs:");
          for (const job of recentJobs) {
            const errPart = job.last_error_code ? ` err=${job.last_error_code}: ${(job.last_error_message ?? "").slice(0, MAX_ERROR_MESSAGE_LENGTH)}` : "";
            diagLines.push(`    [${job.status}] attempt=${job.attempt_count} updated=${job.updated_at}${errPart}`);
          }
        } else if (verbose && latest && recentJobs.length === 0) {
          diagLines.push("  recent jobs: none (raw messages received but no jobs created — check gateway logs)");
        }

        if (m.is_paused === 1 && m.pause_reason) {
          diagLines.push(`  pause reason: ${m.pause_reason}`);
        }

        return diagLines;
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
      lines.push(...(recentFailures.length > 0 ? recentFailures.map((failure) => `- [${failure.failure_code}] ${failure.failure_summary.slice(0, MAX_FAILURE_SUMMARY_LENGTH)} (attempt=${failure.attempt_count})`) : ["- none"]));
    }

    await interaction.reply({ content: lines.join("\n").slice(0, 1_950), flags: MessageFlags.Ephemeral });
  }

  private async handlePause(interaction: ChatInputCommandInteraction): Promise<void> {
    const mappings = this.resolveMappingsForControl(interaction);
    mappings.forEach((mapping) => this.repositories.channelMappings.setPaused(mapping.mapping_id, true, "Paused by admin"));
    await interaction.reply({
      content: `Пауза включена для ${mappings.length} mapping(s).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    const mappings = this.resolveMappingsForControl(interaction);
    for (const mapping of mappings) {
      await this.glossaryManager.validateLanguagePair(mapping.source_lang, mapping.target_lang);
      this.repositories.channelMappings.setPaused(mapping.mapping_id, false, null);
    }
    await interaction.reply({ content: `Resume выполнен для ${mappings.length} mapping(s).`, flags: MessageFlags.Ephemeral });
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

    await this.scheduleRetranslate(rawMessageId);

    await interaction.reply({ content: `Повторный перевод запланирован для raw message ${rawMessageId}.`, flags: MessageFlags.Ephemeral });
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
        let syncedVersionId: string | null = null;
        let localOnly = false;
        try {
          const synced = await this.glossaryManager.syncRulesForPair({ guildId, sourceLang, targetLang });
          this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, synced.glossary_version_id);
          syncedVersionId = synced.glossary_version_id;
        } catch (error) {
          if (error instanceof AppError && error.code === "DEEPL_GLOSSARY_CREATE_FAILED") {
            this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, null);
            localOnly = true;
          } else {
            throw error;
          }
        }
        await interaction.reply({
          content: localOnly
            ? `Glossary правило добавлено. DeepL glossary не активирован, но правило сохранено локально и будет применяться при переводе (${sourceLang} -> ${targetLang}).`
            : `Glossary правило добавлено. Активна версия ${syncedVersionId} (${sourceLang} -> ${targetLang}).`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case "remove": {
        const sourceTerm = interaction.options.getString("source_term", true).trim();
        const removed = this.repositories.glossaryRules.deleteRule(guildId, sourceLang, targetLang, sourceTerm);
        if (!removed) {
          throw new AppError({ code: "GLOSSARY_RULE_NOT_FOUND", message: "Active glossary правило не найдено.", failureClass: "validation" });
        }

        const activeRules = this.repositories.glossaryRules.listActiveByPair(guildId, sourceLang, targetLang);
        if (activeRules.length === 0) {
          this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, null);
          await interaction.reply({
            content: "Правило удалено. В паре больше нет активных glossary правил, mappings останутся без активного glossary до следующего /glossary add.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        let syncedVersionId: string | null = null;
        let localOnly = false;
        try {
          const synced = await this.glossaryManager.syncRulesForPair({ guildId, sourceLang, targetLang });
          this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, synced.glossary_version_id);
          syncedVersionId = synced.glossary_version_id;
        } catch (error) {
          if (error instanceof AppError && error.code === "DEEPL_GLOSSARY_CREATE_FAILED") {
            this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, null);
            localOnly = true;
          } else {
            throw error;
          }
        }
        await interaction.reply({
          content: localOnly
            ? "Правило удалено. DeepL glossary не активирован, оставшиеся правила будут применяться локально при переводе."
            : `Правило удалено. Активирована версия ${syncedVersionId}.`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case "list": {
        const query = interaction.options.getString("query") ?? undefined;
        const rules = this.repositories.glossaryRules.listByGuild(guildId, query, false).slice(0, 50);
        const lines = rules.map((rule) => `- [${rule.status}] ${rule.source_lang}->${rule.target_lang} ${rule.source_term} => ${rule.rule_type === "preserve" ? "(preserve)" : (rule.target_term ?? "")}`);
        await interaction.reply({
          content: lines.length > 0 ? lines.join("\n").slice(0, 1_950) : "Glossary правил пока нет.",
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case "import": {
        const attachment = interaction.options.getAttachment("file");
        const dryRun = interaction.options.getBoolean("dry_run") ?? false;
        const replaceExisting = interaction.options.getBoolean("replace_existing") ?? true;
        if (attachment) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const payload = await this.downloadGlossaryAttachment(attachment);
          const result = await this.runGlossaryImport({
            guildId,
            actorUserId: interaction.user.id,
            sourceLang,
            targetLang,
            payload,
            dryRun,
            replaceExisting,
          });
          await interaction.editReply({ content: this.formatGlossaryImportResult(result) });
          break;
        }

        // Encode parameters in the modal customId so they survive until submit
        // Use | as delimiter (cannot appear in language codes like EN, RU)
        const customId = `glossary_import|${sourceLang}|${targetLang}|${dryRun}|${replaceExisting}`;
        const modal = new ModalBuilder().setCustomId(customId).setTitle("Массовый импорт Glossary");
        const payloadInput = new TextInputBuilder()
          .setCustomId("payload")
          .setLabel("Вставьте glossary payload")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Можно без секций:\nragdoll = опрокид\ncombo extender = продление комбо\nGojo")
          .setRequired(true)
          .setMaxLength(4000);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(payloadInput));
        await interaction.showModal(modal);
        break;
      }

      case "clear": {
        const clearAll = interaction.options.getBoolean("all") ?? false;
        if (clearAll) {
          const deleted = this.repositories.glossaryRules.deleteAllByGuild(guildId);
          if (deleted === 0) {
            await interaction.reply({ content: "Активных glossary правил на сервере не найдено.", flags: MessageFlags.Ephemeral });
            return;
          }
          const allMappings = this.repositories.channelMappings.listByGuildId(guildId);
          for (const m of allMappings) {
            this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, m.source_lang, m.target_lang, null);
          }
          await interaction.reply({
            content: `Glossary полностью очищен: удалено ${deleted} правил(о). Active glossary версия сброшена для всех связок каналов.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const deleted = this.repositories.glossaryRules.deleteAllByPair(guildId, sourceLang, targetLang);
          if (deleted === 0) {
            await interaction.reply({ content: `Активных glossary правил для ${sourceLang} -> ${targetLang} не найдено.`, flags: MessageFlags.Ephemeral });
            return;
          }
          this.repositories.channelMappings.updateActiveGlossaryForPair(guildId, sourceLang, targetLang, null);
          await interaction.reply({
            content: `Glossary ${sourceLang} -> ${targetLang} очищен: удалено ${deleted} правил(о). Active glossary версия сброшена.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }
    }
  }

  async handleGlossaryImportModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Эта команда доступна только внутри сервера.", flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    if (!this.hasAdminAccess(member)) {
      await interaction.reply({ content: "Недостаточно прав для использования этой команды.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const parts = interaction.customId.split("|");
      const sourceLang = (parts[1] || this.config.defaultSourceLanguage).toUpperCase();
      const targetLang = (parts[2] || this.config.defaultTargetLanguage).toUpperCase();
      const dryRun = parts[3] === "true";
      const replaceExisting = parts[4] === "true";
      const result = await this.runGlossaryImport({
        guildId: interaction.guildId!,
        actorUserId: interaction.user.id,
        sourceLang,
        targetLang,
        payload: interaction.fields.getTextInputValue("payload"),
        dryRun,
        replaceExisting,
      });
      await interaction.editReply({ content: this.formatGlossaryImportResult(result) });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      this.logger.error(
        {
          event: "glossary_import_failed",
          error_code: appError?.code,
          error_details: appError?.details,
          error: error instanceof Error ? error.message : String(error),
        },
        `Glossary bulk import failed (code=${appError?.code ?? "unknown"}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const message = appError ? this.formatAppErrorForDiscord(appError) : "Импорт завершился ошибкой. Проверьте логи.";
      await interaction.editReply({ content: message });
    }
  }

  private async downloadGlossaryAttachment(attachment: Attachment): Promise<string> {
    if (attachment.size > 5 * 1024 * 1024) {
      throw new AppError({
        code: "GLOSSARY_ATTACHMENT_TOO_LARGE",
        message: "Файл glossary слишком большой. Используйте файл до 5 MB.",
        failureClass: "validation",
      });
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new AppError({
        code: "GLOSSARY_ATTACHMENT_DOWNLOAD_FAILED",
        message: `Не удалось скачать файл glossary (${response.status}).`,
        failureClass: "validation",
      });
    }

    return await response.text();
  }

  private async runGlossaryImport(input: {
    guildId: string;
    actorUserId: string;
    sourceLang: string;
    targetLang: string;
    payload: string;
    dryRun: boolean;
    replaceExisting: boolean;
  }): Promise<{
    sourceLang: string;
    targetLang: string;
    parsed: number;
    added: number;
    updated: number;
    unchanged: number;
    conflictsSkipped: number;
    errors: number;
    parseWarnings: string;
    activeVersionId: string | null;
    dryRun: boolean;
    localOnly: boolean;
    syncWarning: string | null;
  }> {
    this.logger.info(
      {
        event: "glossary_import_started",
        guild_id: input.guildId,
        source_lang: input.sourceLang,
        target_lang: input.targetLang,
        dry_run: input.dryRun,
        replace_existing: input.replaceExisting,
      },
      `Glossary import started (${input.sourceLang}->${input.targetLang}, dry_run=${input.dryRun}, replace_existing=${input.replaceExisting})`,
    );

    const { entries, errors: parseErrors } = parseBulkGlossaryPayload(input.payload);
    if (parseErrors.length > 0 && entries.length === 0) {
      throw new AppError({
        code: "GLOSSARY_IMPORT_PARSE_FAILED",
        message: `Ошибки парсинга payload (${parseErrors.length}):\n${formatParseErrors(parseErrors)}`,
        failureClass: "validation",
      });
    }

    if (entries.length === 0) {
      throw new AppError({
        code: "GLOSSARY_IMPORT_EMPTY",
        message: "Payload не содержит ни одной валидной записи. Проверьте формат.",
        failureClass: "validation",
      });
    }

    const guildSettings = this.repositories.guildSettings.getByGuildId(input.guildId);
    if (!guildSettings) {
      throw new AppError({
        code: "GUILD_NOT_INITIALIZED",
        message: "Сервер не инициализирован. Сначала выполните /setup.",
        failureClass: "validation",
      });
    }

    await this.glossaryManager.validateLanguagePair(input.sourceLang, input.targetLang);

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let conflictsSkipped = 0;
    let localOnly = false;
    let syncWarning: string | null = null;

    if (input.dryRun) {
      for (const entry of entries) {
        const existing = this.repositories.glossaryRules.getActiveRule(input.guildId, input.sourceLang, input.targetLang, entry.sourceTerm);
        if (!existing) {
          added++;
        } else if (existing.rule_type === entry.mode && existing.target_term === entry.targetTerm) {
          unchanged++;
        } else if (input.replaceExisting) {
          updated++;
        } else {
          conflictsSkipped++;
        }
      }
    } else {
      const dbResult = this.repositories.glossaryRules.bulkUpsertRules({
        guildId: input.guildId,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        entries,
        replaceExisting: input.replaceExisting,
        userId: input.actorUserId,
      });
      added = dbResult.added;
      updated = dbResult.updated;
      unchanged = dbResult.unchanged;
      conflictsSkipped = dbResult.conflictsSkipped;
    }

    let activeVersionId = this.repositories.glossaryVersions.getActiveByPair(input.guildId, input.sourceLang, input.targetLang)?.glossary_version_id ?? null;
    if (!input.dryRun && (added > 0 || updated > 0)) {
      try {
        const synced = await this.glossaryManager.syncRulesForPair({
          guildId: input.guildId,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
        });
        this.repositories.channelMappings.updateActiveGlossaryForPair(input.guildId, input.sourceLang, input.targetLang, synced.glossary_version_id);
        activeVersionId = synced.glossary_version_id;
      } catch (error) {
        if (error instanceof AppError && error.code === "DEEPL_GLOSSARY_CREATE_FAILED") {
          localOnly = true;
          syncWarning = "DeepL glossary не активирован. Правила сохранены локально и всё равно будут применяться при переводе.";
          this.repositories.channelMappings.updateActiveGlossaryForPair(input.guildId, input.sourceLang, input.targetLang, null);
        } else {
          throw error;
        }
      }
    }

    return {
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      parsed: entries.length,
      added,
      updated,
      unchanged,
      conflictsSkipped,
      errors: parseErrors.length,
      parseWarnings: parseErrors.length > 0 ? formatParseErrors(parseErrors, 5) : "",
      activeVersionId,
      dryRun: input.dryRun,
      localOnly,
      syncWarning,
    };
  }

  private formatGlossaryImportResult(result: {
    sourceLang: string;
    targetLang: string;
    parsed: number;
    added: number;
    updated: number;
    unchanged: number;
    conflictsSkipped: number;
    errors: number;
    parseWarnings: string;
    activeVersionId: string | null;
    dryRun: boolean;
    localOnly: boolean;
    syncWarning: string | null;
  }): string {
    const noChanges = result.added === 0 && result.updated === 0 && result.conflictsSkipped === 0;
    const lines = [
      result.dryRun ? "**Dry-run glossary import OK.**" : (noChanges ? "**Импорт glossary: изменений не было.**" : "**Импорт glossary завершён.**"),
      `Pair: ${result.sourceLang} -> ${result.targetLang}`,
      `Parsed: ${result.parsed}`,
      result.dryRun ? `Would add: ${result.added}` : `Added: ${result.added}`,
      result.dryRun ? `Would update: ${result.updated}` : `Updated: ${result.updated}`,
      `Unchanged: ${result.unchanged}`,
      `Conflicts skipped: ${result.conflictsSkipped}`,
      `Warnings: ${result.errors}`,
      `Glossary mode: ${result.localOnly ? "local-only" : "deepl+local"}`,
      `Active glossary version: ${result.activeVersionId ?? "none"}`,
    ];
    if (result.syncWarning) {
      lines.push("", result.syncWarning);
    }
    if (result.parseWarnings) {
      lines.push("", `Parse warnings:\n${result.parseWarnings}`);
    }
    return lines.join("\n").slice(0, 1_950);
  }

  private formatAppErrorForDiscord(error: AppError): string {
    const details = typeof error.details?.body === "string" ? error.details.body : null;
    if (!details) {
      return error.message;
    }

    return `${error.message}\nDeepL/details: ${details.slice(0, 250)}`;
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
