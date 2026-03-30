import { Message } from "discord.js";
import { ChannelMappingRow, PostPayload } from "../domain/types";
import { nowIso } from "../utils/time";
import { extractUrls, normalizeWhitespace } from "../utils/text";
import { buildContentChecksum, buildDedupeKey } from "./checksum";
import { detectSourceLabel } from "./source-label";
import { hasMessageSnapshots } from "./message-filter";

export class MessageCanonicalizer {
  canonicalize(message: Message, mapping: ChannelMappingRow, followConfidence: "high" | "medium" | "low"): PostPayload {
    const receivedAt = nowIso();
    const canonicalizedAt = nowIso();
    const contentText = normalizeWhitespace(message.content ?? "");
    const embeds = message.embeds.map((embed, index) => ({
      embed_index: index,
      type: embed.data.type ?? "rich",
      title: embed.title ?? null,
      description: embed.description ?? null,
      fields: (embed.fields ?? []).map((field) => ({
        name: field.name,
        value: field.value,
        inline: field.inline ?? false,
      })),
      footer_text: embed.footer?.text ?? null,
      author_name: embed.author?.name ?? null,
      url: embed.url ?? null,
      image_url: embed.image?.url ?? embed.thumbnail?.url ?? null,
    }));
    const attachments = message.attachments.map((attachment) => ({
      attachment_id: attachment.id,
      filename: attachment.name ?? attachment.id,
      content_type: attachment.contentType ?? null,
      size_bytes: attachment.size,
      url: attachment.url,
      proxy_url: attachment.proxyURL ?? null,
      is_image: attachment.contentType?.startsWith("image/") ?? false,
      is_spoiler: attachment.spoiler,
    }));

    const outputChannel = message.guild?.channels.cache.get(mapping.output_channel_id);
    const rawFlags = Array.from(message.flags.toArray(), (flag) => flag.toString());

    const payload: PostPayload = {
      schema_version: 1,
      mapping_id: mapping.mapping_id,
      guild: {
        guild_id: message.guildId!,
        guild_name: message.guild?.name ?? "Unknown guild",
        locale: message.guild?.preferredLocale ?? null,
      },
      raw_channel: {
        channel_id: message.channelId,
        channel_name: "name" in message.channel ? (message.channel.name ?? "raw-follow") : "raw-follow",
        channel_type: String(message.channel.type),
      },
      output_channel: {
        channel_id: mapping.output_channel_id,
        channel_name: outputChannel && "name" in outputChannel ? (outputChannel.name ?? "translated") : "translated",
        channel_type: outputChannel ? String(outputChannel.type) : "unknown",
      },
      raw_message: {
        message_id: message.id,
        message_type: String(message.type),
        webhook_id: message.webhookId ?? null,
        application_id: message.applicationId ?? null,
        author_id: message.author.id,
        author_name: message.author.username,
        is_webhook: Boolean(message.webhookId),
        flags: rawFlags,
        jump_url: message.url,
        timestamp: message.createdAt.toISOString(),
        edited_timestamp: message.editedAt?.toISOString() ?? null,
      },
      origin_reference: {
        origin_guild_id: message.reference?.guildId ?? null,
        origin_channel_id: message.reference?.channelId ?? null,
        origin_message_id: message.reference?.messageId ?? null,
        origin_jump_url: null,
        reference_type: hasMessageSnapshots(message) ? "forwarded" : message.reference ? "follow_crosspost" : null,
      },
      source_markers: {
        has_webhook_id: Boolean(message.webhookId),
        has_message_reference: Boolean(message.reference),
        has_mention_channels: message.mentions.channels.size > 0,
        follow_confidence: followConfidence,
      },
      content: {
        raw_text: message.content ?? "",
        normalized_text: contentText,
        is_empty: !contentText,
      },
      embeds,
      attachments,
      urls: [
        ...extractUrls(message.content ?? "").map((url) => ({ url, source: "content" as const, kind: "external_link" as const })),
        ...embeds
          .flatMap((embed) => [embed.url, embed.image_url].filter(Boolean))
          .map((url) => ({ url: url!, source: "embed" as const, kind: "external_link" as const })),
        ...attachments.map((attachment) => ({
          url: attachment.url,
          source: "attachment" as const,
          kind: attachment.is_image ? ("image" as const) : ("attachment" as const),
        })),
      ],
      mentions: {
        user_ids: message.mentions.users.map((user) => user.id),
        role_ids: message.mentions.roles.map((role) => role.id),
        channel_ids: message.mentions.channels.map((channel) => channel.id),
        mention_everyone: message.mentions.everyone,
      },
      text_blocks: this.extractTextBlocks(contentText, embeds),
      detected_source_label: detectSourceLabel({
        mapping,
        authorName: message.author.username,
        embedAuthorName: embeds[0]?.author_name ?? null,
        embedFooterText: embeds[0]?.footer_text ?? null,
      }),
      translation: {
        status: "pending",
        source_lang_configured: mapping.source_lang,
        target_lang: mapping.target_lang,
        glossary_required: true,
        glossary_version_id: mapping.active_glossary_version_id,
        attempt: 0,
      },
      checksums: {
        content_checksum: buildContentChecksum(message),
        dedupe_key: "",
      },
      audit: {
        received_at: receivedAt,
        canonicalized_at: canonicalizedAt,
      },
    };

    payload.checksums.dedupe_key = buildDedupeKey(payload);
    return payload;
  }

  private extractTextBlocks(contentText: string, embeds: PostPayload["embeds"]): PostPayload["text_blocks"] {
    const blocks: PostPayload["text_blocks"] = [];

    if (contentText) {
      blocks.push({
        block_id: "content:0",
        block_type: "content_body",
        source_text: contentText,
        preserve_markdown: true,
      });
    }

    for (const embed of embeds) {
      if (embed.title) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:title`,
          block_type: "embed_title",
          source_text: embed.title,
          preserve_markdown: false,
        });
      }
      if (embed.description) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:desc`,
          block_type: "embed_description",
          source_text: embed.description,
          preserve_markdown: true,
        });
      }
      if (embed.author_name) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:author`,
          block_type: "embed_author",
          source_text: embed.author_name,
          preserve_markdown: false,
        });
      }
      if (embed.footer_text) {
        blocks.push({
          block_id: `embed:${embed.embed_index}:footer`,
          block_type: "embed_footer",
          source_text: embed.footer_text,
          preserve_markdown: false,
        });
      }
      embed.fields.forEach((field, index) => {
        if (field.name) {
          blocks.push({
            block_id: `embed:${embed.embed_index}:field:${index}:name`,
            block_type: "embed_field_name",
            source_text: field.name,
            preserve_markdown: false,
          });
        }
        if (field.value) {
          blocks.push({
            block_id: `embed:${embed.embed_index}:field:${index}:value`,
            block_type: "embed_field_value",
            source_text: field.value,
            preserve_markdown: true,
          });
        }
      });
    }

    return blocks;
  }
}
