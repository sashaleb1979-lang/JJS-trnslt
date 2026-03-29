import crypto from "node:crypto";
import { Message } from "discord.js";
import { PostPayload } from "../domain/types";

export function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function buildContentChecksum(message: Message): string {
  const parts = [
    message.content,
    ...message.embeds.flatMap((embed) => [
      embed.title ?? "",
      embed.description ?? "",
      ...(embed.fields?.flatMap((field) => [field.name ?? "", field.value ?? ""]) ?? []),
      embed.footer?.text ?? "",
      embed.author?.name ?? "",
    ]),
    ...message.attachments.map((attachment) => attachment.url),
  ];

  return sha256(parts.join("\n"));
}

export function buildDedupeKey(payload: Pick<PostPayload, "mapping_id" | "origin_reference" | "raw_message">): string {
  const { origin_reference: origin, raw_message: raw } = payload;
  if (origin.origin_message_id && origin.origin_channel_id) {
    return sha256(
      [payload.mapping_id, origin.origin_guild_id ?? "unknown", origin.origin_channel_id, origin.origin_message_id].join("|"),
    );
  }

  return sha256([payload.mapping_id, "raw", raw.message_id].join("|"));
}
