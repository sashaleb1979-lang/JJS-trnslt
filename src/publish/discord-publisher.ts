import { AttachmentBuilder, Client, EmbedBuilder, MessageCreateOptions } from "discord.js";
import { Logger } from "pino";
import { AppError } from "../domain/errors";
import { PublishPlan, PublishResult } from "../domain/types";

export class DiscordPublisher {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  async publish(channelId: string, plan: PublishPlan): Promise<PublishResult> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) {
      throw new AppError({
        code: "OUTPUT_CHANNEL_NOT_SENDABLE",
        message: "Bot cannot send messages to the configured output channel",
        failureClass: "permanent_publish",
      });
    }

    const sendableChannel = channel as { send: (payload: MessageCreateOptions) => Promise<{ id: string }> };
    const messageIds: string[] = [];
    let anchorId: string | null = null;

    for (const item of plan.messages) {
      const payload: MessageCreateOptions = {
        allowedMentions: { parse: [], repliedUser: false },
        content: item.content,
        embeds: item.embeds?.map((embed) => {
          const builder = new EmbedBuilder();
          if (embed.title) {
            builder.setTitle(embed.title);
          }
          if (embed.description) {
            builder.setDescription(embed.description);
          }
          if (embed.footer) {
            builder.setFooter({ text: embed.footer });
          }
          if (embed.url) {
            builder.setURL(embed.url);
          }
          if (embed.imageUrl) {
            builder.setImage(embed.imageUrl);
          }
          return builder;
        }),
        files: item.files?.map((file) => new AttachmentBuilder(file.data!, { name: file.name })),
      };

      if (item.replyToAnchor && anchorId) {
        payload.reply = {
          messageReference: anchorId,
          failIfNotExists: false,
        };
      }

      try {
        const sent = await sendableChannel.send(payload);
        if (!anchorId) {
          anchorId = sent.id;
        }
        messageIds.push(sent.id);
      } catch (error) {
        this.logger.error(
          {
            event: "publish_failed",
            channel_id: channelId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to publish translated output",
        );
        throw new AppError({
          code: "DISCORD_PUBLISH_FAILED",
          message: "Discord publish failed",
          retryable: true,
          failureClass: "permanent_publish",
          cause: error,
        });
      }
    }

    return {
      primaryMessageId: messageIds[0],
      allMessageIds: messageIds,
      mode: plan.mode,
    };
  }
}
