import { Logger } from "pino";
import { AppConfig, CanonicalAttachment } from "../domain/types";

export interface PreparedMedia {
  files: Array<{
    name: string;
    data: Buffer;
    contentType?: string | null;
  }>;
  linkLines: string[];
}

export class AttachmentHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async prepare(
    attachments: CanonicalAttachment[],
    mediaMode: "auto" | "mirror" | "link_only",
  ): Promise<PreparedMedia> {
    const files: PreparedMedia["files"] = [];
    const linkLines: string[] = [];

    for (const attachment of attachments) {
      const canMirror =
        mediaMode !== "link_only" &&
        attachment.is_image &&
        attachment.size_bytes <= this.config.attachmentMirrorMaxBytes;

      if (!canMirror) {
        linkLines.push(`[${attachment.filename}](${attachment.url})`);
        continue;
      }

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        files.push({
          name: attachment.filename,
          data: buffer,
          contentType: attachment.content_type,
        });
      } catch (error) {
        this.logger.warn(
          {
            event: "attachment_mirror_failed",
            attachment_id: attachment.attachment_id,
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to mirror attachment",
        );
        linkLines.push(`[${attachment.filename}](${attachment.url})`);
      }
    }

    return { files, linkLines };
  }
}
