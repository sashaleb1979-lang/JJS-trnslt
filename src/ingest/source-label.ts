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
}): SourceLabelResult {
  // Admin override always wins regardless of message type.
  if (input.mapping.source_label_override?.trim()) {
    return { label: input.mapping.source_label_override.trim(), origin: "mapping_override" };
  }

  if (input.isForwardedMessage) {
    // For native-forward messages the forwarder's username is NOT a valid attribution.
    // Use the origin channel name first, then any embed-level attribution, then a
    // generic "Forwarded content" label. Never fall through to the author name.
    if (input.originChannelName?.trim()) {
      return { label: input.originChannelName.trim(), origin: "forwarded_origin_channel" };
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
