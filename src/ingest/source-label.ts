import { ChannelMappingRow } from "../domain/types";

export interface SourceLabelResult {
  label: string;
  /** Identifies which field was used so callers can log the origin. */
  origin: string;
}

export function detectSourceLabel(input: {
  mapping: ChannelMappingRow;
  authorName: string;
  embedAuthorName?: string | null;
  embedFooterText?: string | null;
  /** True when the message is a Discord native forward (message_snapshots present). */
  isForwardedMessage?: boolean;
  /**
   * The name of the origin channel resolved from the message reference, if available.
   * Only meaningful when isForwardedMessage is true.
   */
  originChannelName?: string | null;
  /**
   * The name of the origin guild/server, if available and different from the receiving guild.
   * Used as a fallback attribution for cross-server forwards when the channel name is
   * not resolvable from the local cache.
   */
  originGuildName?: string | null;
}): SourceLabelResult {
  // Admin override always wins regardless of message type.
  if (input.mapping.source_label_override?.trim()) {
    return { label: input.mapping.source_label_override.trim(), origin: "mapping_override" };
  }

  if (input.isForwardedMessage) {
    // For native-forward messages the forwarder's username is NOT a valid attribution.
    // Priority:
    //   a) origin channel name (same-server forwards where channel is in cache)
    //   b) origin guild/server name (cross-server forwards where the channel is not in cache)
    //   c) embed author name from the original post (e.g. announcement embed attribution)
    //   d) embed footer text from the original post
    //   e) generic "Forwarded content" – never use the forwarder's username
    if (input.originChannelName?.trim()) {
      return { label: input.originChannelName.trim(), origin: "forwarded_origin_channel" };
    }
    if (input.originGuildName?.trim()) {
      return { label: input.originGuildName.trim(), origin: "forwarded_origin_guild" };
    }
    if (input.embedAuthorName?.trim()) {
      return { label: input.embedAuthorName.trim(), origin: "embed_author" };
    }
    if (input.embedFooterText?.trim()) {
      return { label: input.embedFooterText.trim(), origin: "embed_footer" };
    }
    return { label: "Forwarded content", origin: "forwarded_fallback" };
  }

  // Regular crosspost / follow / webhook messages.
  if (input.embedAuthorName?.trim()) {
    return { label: input.embedAuthorName.trim(), origin: "embed_author" };
  }
  if (input.embedFooterText?.trim()) {
    return { label: input.embedFooterText.trim(), origin: "embed_footer" };
  }
  const authorLabel = input.authorName.trim();
  return { label: authorLabel || "Official Discord", origin: authorLabel ? "author_name" : "default" };
}
