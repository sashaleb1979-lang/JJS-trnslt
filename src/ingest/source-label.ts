import { ChannelMappingRow } from "../domain/types";

export function detectSourceLabel(input: {
  mapping: ChannelMappingRow;
  authorName: string;
  embedAuthorName?: string | null;
  embedFooterText?: string | null;
}): string {
  if (input.mapping.source_label_override?.trim()) {
    return input.mapping.source_label_override.trim();
  }

  if (input.embedAuthorName?.trim()) {
    return input.embedAuthorName.trim();
  }

  if (input.embedFooterText?.trim()) {
    return input.embedFooterText.trim();
  }

  return input.authorName.trim() || "Official Discord";
}
