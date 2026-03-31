import { ChannelMappingRow, PostPayload, PublishPlan, TranslationPublicationStatus } from "../domain/types";
import { sanitizeForDiscord } from "../utils/text";
import { chunkForDiscordContent, fitEmbedDescription } from "./chunker";
import { PreparedMedia } from "./attachment-handler";

export class PublishRenderer {
  buildPlan(input: {
    payload: PostPayload;
    mapping: ChannelMappingRow;
    translatedBlocks: Map<string, string>;
    media: PreparedMedia;
    translationStatus: TranslationPublicationStatus;
  }): PublishPlan {
    const title = this.resolveTitle(input.payload, input.translatedBlocks);
    const body = this.resolveBody(input.payload, input.translatedBlocks);
    const footer = `Источник: ${input.payload.detected_source_label} • ${this.resolveFooterStatus(input.translationStatus)}`;
    const fileLinks = input.media.linkLines.length > 0 ? `\n\nВложения:\n${input.media.linkLines.join("\n")}` : "";
    const finalBody = sanitizeForDiscord(`${body}${fileLinks}`.trim());

    if (input.mapping.render_mode === "embed" || (input.mapping.render_mode === "auto" && finalBody.length <= 3_800)) {
      return {
        mode: "embed",
        messages: [
          {
            embeds: [
              {
                title: title ?? undefined,
                description: fitEmbedDescription(finalBody || "Оригинальный пост без текста."),
                footer,
                url: input.payload.urls[0]?.url,
                imageUrl: undefined,
              },
            ],
            files: input.media.files,
          },
        ],
      };
    }

    const chunks = chunkForDiscordContent(finalBody || "Оригинальный пост без текста.");
    if (chunks.length <= 1 && input.mapping.render_mode === "plain") {
      return {
        mode: "plain",
        messages: [
          {
            content: `${title ? `**${title}**\n\n` : ""}${chunks[0]}\n\n_${footer}_`,
            files: input.media.files,
          },
        ],
      };
    }

    const messages: PublishPlan["messages"] = [
      {
        embeds: [
          {
            title: title ?? undefined,
            description: fitEmbedDescription(chunks[0]),
            footer,
            url: input.payload.urls[0]?.url,
          },
        ],
        files: input.media.files,
      },
    ];

    const remainder = chunks.slice(1);
    remainder.forEach((chunk) => {
      messages.push({
        content: chunk,
        replyToAnchor: true,
      });
    });

    return {
      mode: remainder.length > 0 ? "header_chain" : "embed",
      messages,
    };
  }

  private resolveTitle(payload: PostPayload, translatedBlocks: Map<string, string>): string | null {
    const embedTitleKey = payload.text_blocks.find((block) => block.block_type === "embed_title")?.block_id;
    if (embedTitleKey && translatedBlocks.get(embedTitleKey)?.trim()) {
      return translatedBlocks.get(embedTitleKey)!.trim().slice(0, 256);
    }

    return null;
  }

  private resolveBody(payload: PostPayload, translatedBlocks: Map<string, string>): string {
    const sections: string[] = [];

    const mainBody = payload.text_blocks
      .filter((block) => block.block_type === "content_body")
      .map((block) => translatedBlocks.get(block.block_id) ?? block.source_text)
      .join("\n\n");
    if (mainBody.trim()) {
      sections.push(mainBody.trim());
    }

    const embedGroups = new Map<number, string[]>();
    for (const block of payload.text_blocks.filter((entry) => entry.block_id.startsWith("embed:"))) {
      const match = block.block_id.match(/^embed:(\d+):/);
      const group = Number(match?.[1] ?? 0);
      if (!embedGroups.has(group)) {
        embedGroups.set(group, []);
      }

      const translated = translatedBlocks.get(block.block_id) ?? block.source_text;
      if (!translated.trim()) {
        continue;
      }

      if (block.block_type === "embed_title") {
        embedGroups.get(group)!.push(`**${translated.trim()}**`);
      } else {
        embedGroups.get(group)!.push(translated.trim());
      }
    }

    for (const [, lines] of embedGroups) {
      if (lines.length > 0) {
        sections.push(lines.join("\n"));
      }
    }

    return sections.join("\n\n").trim();
  }

  private resolveFooterStatus(status: TranslationPublicationStatus): string {
    switch (status) {
      case "skipped":
        return "Перевод не требуется";
      case "partial_original":
        return "Частично оригинал (ошибка перевода)";
      case "fallback_original":
        return "Оригинал (ошибка перевода)";
      case "translated":
      default:
        return "Автоперевод DeepL";
    }
  }
}
