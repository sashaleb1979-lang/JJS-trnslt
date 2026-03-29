import {
  ChannelType,
  ChatInputCommandInteraction,
  GuildMember,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { AppConfig } from "../domain/types";

export function isAdminInteraction(interaction: ChatInputCommandInteraction, config: AppConfig): boolean {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    return false;
  }

  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return config.adminRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export type SupportedSetupChannel = TextChannel | NewsChannel;

export function ensureTextChannel(channel: unknown): SupportedSetupChannel | null {
  if (!channel || typeof channel !== "object" || !("type" in channel)) {
    return null;
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }

  return channel as SupportedSetupChannel;
}

export function validateSetupPermissions(input: {
  botMember: GuildMember;
  rawChannel: SupportedSetupChannel;
  outputChannel: SupportedSetupChannel;
}): string[] {
  const issues: string[] = [];
  const rawPerms = input.rawChannel.permissionsFor(input.botMember);
  const outputPerms = input.outputChannel.permissionsFor(input.botMember);

  if (!rawPerms?.has(PermissionFlagsBits.ViewChannel) || !rawPerms?.has(PermissionFlagsBits.ReadMessageHistory)) {
    issues.push("Бот не видит raw-канал или не может читать его историю.");
  }

  if (!outputPerms?.has(PermissionFlagsBits.ViewChannel)) {
    issues.push("Бот не видит output-канал.");
  }
  if (!outputPerms?.has(PermissionFlagsBits.SendMessages)) {
    issues.push("Бот не может писать в output-канал.");
  }
  if (!outputPerms?.has(PermissionFlagsBits.EmbedLinks)) {
    issues.push("Боту не хватает права Embed Links в output-канале.");
  }
  if (!outputPerms?.has(PermissionFlagsBits.AttachFiles)) {
    issues.push("Боту не хватает права Attach Files в output-канале.");
  }

  return issues;
}
