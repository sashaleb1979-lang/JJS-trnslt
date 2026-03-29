import { Message, MessageFlags } from "discord.js";
import { ChannelMappingRow } from "../domain/types";

export interface MessageFilterDecision {
  accepted: boolean;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export class MessageFilter {
  evaluate(message: Message, mapping: ChannelMappingRow | null): MessageFilterDecision {
    if (!mapping) {
      return { accepted: false, reason: "raw_channel_not_mapped", confidence: "low" };
    }

    if (message.author.id === message.client.user?.id) {
      return { accepted: false, reason: "bot_own_message", confidence: "low" };
    }

    const hasWebhook = Boolean(message.webhookId);
    const flags = message.flags;
    const isCrosspostLike =
      flags.has(MessageFlags.Crossposted) ||
      flags.has(MessageFlags.IsCrosspost) ||
      flags.has(MessageFlags.SourceMessageDeleted);
    const hasReference = Boolean(message.reference?.messageId || message.reference?.channelId);
    const hasMentionChannels = message.mentions.channels.size > 0;

    const score = [hasWebhook, isCrosspostLike, hasReference, hasMentionChannels].filter(Boolean).length;
    if (score >= 2) {
      return { accepted: true, reason: "follow_like", confidence: "high" };
    }
    if (hasWebhook || isCrosspostLike) {
      return { accepted: true, reason: "likely_follow", confidence: "medium" };
    }

    return { accepted: false, reason: "not_follow_like", confidence: "low" };
  }
}
