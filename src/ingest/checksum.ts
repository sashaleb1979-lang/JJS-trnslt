import crypto from "node:crypto";
import { Message } from "discord.js";
import { PostPayload } from "../domain/types";
import { getFirstSnapshot, hasMessageSnapshots } from "./message-filter";

export function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function buildContentChecksum(message: Message): string {
  // For native Discord forwards the real content lives in the first message snapshot,
  // not in message.content / message.embeds (which are empty on the forwarding wrapper).
  // We must hash the snapshot content to avoid every native forward sharing the same checksum.
  if (hasMessageSnapshots(message)) {
    const snapshot = getFirstSnapshot(message);
    const parts = [
      snapshot?.content ?? "",
      ...(snapshot?.embeds ?? []).flatMap((embed) => [
        embed.title ?? "",
        embed.description ?? "",
        ...(embed.fields?.flatMap((field) => [field.name ?? "", field.value ?? ""]) ?? []),
        embed.footer?.text ?? "",
        embed.author?.name ?? "",
      ]),
      ...(snapshot?.attachments.map((a) => a.url) ?? []),
      // Also include the outer wrapper content (forwarder's optional comment).
      message.content ?? "",
    ];
    return sha256(parts.join("\n"));
  }

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
