import Database from "better-sqlite3";
import { PublishPlan, TranslatedOutputRow } from "../../domain/types";
import { nowIso } from "../../utils/time";

export class TranslatedOutputsRepository {
  constructor(private readonly db: Database.Database) {}

  getByRawMessageId(rawMessageId: string): TranslatedOutputRow | null {
    return (
      this.db
        .prepare<string, TranslatedOutputRow>("SELECT * FROM translated_outputs WHERE raw_message_id = ?")
        .get(rawMessageId) ?? null
    );
  }

  getByPrimaryMessageId(primaryMessageId: string): TranslatedOutputRow | null {
    return (
      this.db
        .prepare<string, TranslatedOutputRow>("SELECT * FROM translated_outputs WHERE primary_message_id = ?")
        .get(primaryMessageId) ?? null
    );
  }

  insertOrReplace(input: {
    outputId: string;
    rawMessageId: string;
    mappingId: string;
    outputChannelId: string;
    primaryMessageId: string;
    allMessageIds: string[];
    renderModeUsed: string;
    publishedStatus: string;
    publishedPayload: PublishPlan;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO translated_outputs (
          output_id, raw_message_id, mapping_id, output_channel_id, primary_message_id, all_message_ids_json,
          render_mode_used, published_status, published_payload_json, published_at, updated_at
        ) VALUES (
          @outputId, @rawMessageId, @mappingId, @outputChannelId, @primaryMessageId, @allMessageIdsJson,
          @renderModeUsed, @publishedStatus, @publishedPayloadJson, @publishedAt, @updatedAt
        )
        ON CONFLICT(raw_message_id) DO UPDATE SET
          output_id = excluded.output_id,
          mapping_id = excluded.mapping_id,
          output_channel_id = excluded.output_channel_id,
          primary_message_id = excluded.primary_message_id,
          all_message_ids_json = excluded.all_message_ids_json,
          render_mode_used = excluded.render_mode_used,
          published_status = excluded.published_status,
          published_payload_json = excluded.published_payload_json,
          updated_at = excluded.updated_at`,
      )
      .run({
        ...input,
        allMessageIdsJson: JSON.stringify(input.allMessageIds),
        publishedPayloadJson: JSON.stringify(input.publishedPayload),
        publishedAt: now,
        updatedAt: now,
      });
  }

  markManualMissingByPrimaryMessageId(primaryMessageId: string): void {
    this.db
      .prepare("UPDATE translated_outputs SET published_status = 'manual_missing', updated_at = ? WHERE primary_message_id = ?")
      .run(nowIso(), primaryMessageId);
  }

  deleteByRawMessageId(rawMessageId: string): void {
    this.db.prepare("DELETE FROM translated_outputs WHERE raw_message_id = ?").run(rawMessageId);
  }
}
