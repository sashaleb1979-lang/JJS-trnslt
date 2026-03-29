import { chunkText } from "../utils/text";

export function chunkForDiscordContent(input: string): string[] {
  return chunkText(input, 1_800);
}

export function fitEmbedDescription(input: string): string {
  if (input.length <= 3_800) {
    return input;
  }
  return `${input.slice(0, 3_797)}...`;
}
