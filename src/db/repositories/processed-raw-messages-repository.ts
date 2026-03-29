import Database from "better-sqlite3";
import { PostPayload, ProcessedRawMessageRow } from "../../domain/types";

export class ProcessedRawMessagesRepository {
  constructor(private readonly db: Database.Database) {}

  exists(rawMessageId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM processed_raw_messages WHERE raw_message_id = ?").get(rawMessageId) as
      | { found: number }
      | undefined;
    return Boolean(row?.found);
  }

  getByRawMessageId(rawMessageId: string): ProcessedRawMessageRow | null {
    return (
      this.db
        .prepare<string, ProcessedRawMessageRow>("SELECT * FROM processed_raw_messages WHERE raw_message_id = ?")
        .get(rawMessageId) ?? null
    );
  }

  findStableDuplicate(mappingId: string, dedupeKey: string, rawMessageId: string): ProcessedRawMessageRow | null {
    return (
      this.db
        .prepare<string[], ProcessedRawMessageRow>(
          `SELECT * FROM processed_raw_messages
           WHERE mapping_id = ? AND dedupe_key = ? AND raw_message_id <> ?
           ORDER BY received_at DESC LIMIT 1`,
        )
        .get(mappingId, dedupeKey, rawMessageId) ?? null
    );
  }

  findPossibleDuplicateByChecksum(mappingId: string, contentChecksum: string, rawMessageId: string, sinceIso: string): ProcessedRawMessageRow | null {
    return (
      this.db
        .prepare<string[], ProcessedRawMessageRow>(
          `SELECT * FROM processed_raw_messages
           WHERE mapping_id = ? AND content_checksum = ? AND raw_message_id <> ? AND received_at >= ?
           ORDER BY received_at DESC LIMIT 1`,
        )
        .get(mappingId, contentChecksum, rawMessageId, sinceIso) ?? null
    );
  }

  insert(input: {
    rawMessageId: string;
    mappingId: string;
    guildId: string;
    rawChannelId: string;
    originMessageId: string | null;
    originChannelId: string | null;
    originGuildId: string | null;
    followConfidence: string;
    payload: PostPayload;
    contentChecksum: string;
    dedupeKey: string;
    ingestStatus: string;
    skipReason: string | null;
    receivedAt: string;
    canonicalizedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO processed_raw_messages (
          raw_message_id, mapping_id, guild_id, raw_channel_id, origin_message_id, origin_channel_id,
          origin_guild_id, follow_confidence, canonical_payload_json, content_checksum, dedupe_key,
          ingest_status, skip_reason, received_at, canonicalized_at
        ) VALUES (
          @rawMessageId, @mappingId, @guildId, @rawChannelId, @originMessageId, @originChannelId,
          @originGuildId, @followConfidence, @payloadJson, @contentChecksum, @dedupeKey,
          @ingestStatus, @skipReason, @receivedAt, @canonicalizedAt
        )`,
      )
      .run({
        ...input,
        payloadJson: JSON.stringify(input.payload),
      });
  }

  getLatestForMapping(mappingId: string): ProcessedRawMessageRow | null {
    return (
      this.db
        .prepare<string, ProcessedRawMessageRow>(
          "SELECT * FROM processed_raw_messages WHERE mapping_id = ? ORDER BY received_at DESC LIMIT 1",
        )
        .get(mappingId) ?? null
    );
  }
}
