import { Message, MessageFlags } from "discord.js";
import { ChannelMappingRow } from "../domain/types";

export interface MessageFilterDecision {
  accepted: boolean;
  reason: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Type-safe check for Discord's native message forwarding payload (2024+).
 *
 * discord.js may not yet include `messageSnapshots` in its typings for all versions,
 * so we probe the property through `unknown` rather than casting to `any`.
 */
export function hasMessageSnapshots(message: Message): boolean {
  const snapshots = (message as unknown as { messageSnapshots?: { size: number } }).messageSnapshots;
  return (snapshots?.size ?? 0) > 0;
}

/**
 * Returns true if the message looks like a forwarded or manually shared message.
 *
 * Covers:
 *  - Discord's native "Forward" feature (message_snapshots present, added 2024+)
 *  - A message referencing another message that also carries content/embeds/attachments
 *  - A message with embeds or attachments posted by a user in the raw intake channel
 *    (e.g. someone manually pasted a link or shared media from an announcement)
 *
 * This check is intentionally permissive within the raw channel context because the
 * raw channel is an operator-controlled channel and should only receive curated content.
 */
export function isForwardedOrSharedMessage(message: Message): boolean {
  // Discord's native "Forward" feature: discord.js exposes forwarded snapshots as
  // message.messageSnapshots (Collection<string, MessageSnapshot>).
  if (hasMessageSnapshots(message)) return true;

  const hasReference = Boolean(message.reference?.messageId || message.reference?.channelId);
  const hasContent = Boolean(message.content?.trim());
  const hasEmbeds = message.embeds.length > 0;
  const hasAttachments = message.attachments.size > 0;

  // A message that references another message and carries meaningful content is
  // almost certainly a forward, a shared post, or a cross-channel repost.
  if (hasReference && (hasContent || hasEmbeds || hasAttachments)) return true;

  // A message with embeds or attachments but no webhook in a raw intake channel
  // is treated as shared/reposted content (link share, media share, etc.).
  if (hasEmbeds || hasAttachments) return true;

  return false;
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

    // Accept forwarded / manually-shared messages that didn't match the
    // follow-like heuristic (e.g. no webhook, no crosspost flags).
    if (isForwardedOrSharedMessage(message)) {
      return { accepted: true, reason: "forwarded_or_shared", confidence: "medium" };
    }

    return { accepted: false, reason: "rejected_unsupported_raw_message", confidence: "low" };
  }
}
