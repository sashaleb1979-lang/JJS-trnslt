import Database from "better-sqlite3";

const migrations: Array<{ id: string; sql: string }> = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        default_source_lang TEXT NOT NULL,
        default_target_lang TEXT NOT NULL,
        admin_role_ids_json TEXT,
        log_channel_id TEXT,
        publish_original_on_failure INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS glossary_versions (
        glossary_version_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        compiled_entries_tsv TEXT NOT NULL,
        entries_checksum TEXT NOT NULL,
        deepl_glossary_id TEXT,
        deepl_ready INTEGER NOT NULL,
        sync_status TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        failed_at TEXT,
        failure_reason TEXT,
        UNIQUE(guild_id, source_lang, target_lang, version_no)
      );

      CREATE TABLE IF NOT EXISTS channel_mappings (
        mapping_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        raw_channel_id TEXT NOT NULL,
        output_channel_id TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        source_label_override TEXT,
        active_glossary_version_id TEXT,
        render_mode TEXT NOT NULL,
        media_mode TEXT NOT NULL,
        is_paused INTEGER NOT NULL,
        pause_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (active_glossary_version_id) REFERENCES glossary_versions(glossary_version_id) ON DELETE SET NULL,
        UNIQUE(guild_id, raw_channel_id),
        CHECK(raw_channel_id <> output_channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_mappings_guild ON channel_mappings(guild_id);
      CREATE INDEX IF NOT EXISTS idx_channel_mappings_output ON channel_mappings(output_channel_id);

      CREATE TABLE IF NOT EXISTS processed_raw_messages (
        raw_message_id TEXT PRIMARY KEY,
        mapping_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        raw_channel_id TEXT NOT NULL,
        origin_message_id TEXT,
        origin_channel_id TEXT,
        origin_guild_id TEXT,
        follow_confidence TEXT NOT NULL,
        canonical_payload_json TEXT NOT NULL,
        content_checksum TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        ingest_status TEXT NOT NULL,
        skip_reason TEXT,
        received_at TEXT NOT NULL,
        canonicalized_at TEXT NOT NULL,
        FOREIGN KEY (mapping_id) REFERENCES channel_mappings(mapping_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_processed_raw_mapping_received ON processed_raw_messages(mapping_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_processed_raw_origin_message ON processed_raw_messages(origin_message_id, origin_channel_id, origin_guild_id);
      CREATE INDEX IF NOT EXISTS idx_processed_raw_dedupe_key ON processed_raw_messages(mapping_id, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_processed_raw_checksum_received ON processed_raw_messages(mapping_id, content_checksum, received_at DESC);

      CREATE TABLE IF NOT EXISTS translated_outputs (
        output_id TEXT PRIMARY KEY,
        raw_message_id TEXT NOT NULL UNIQUE,
        mapping_id TEXT NOT NULL,
        output_channel_id TEXT NOT NULL,
        primary_message_id TEXT NOT NULL,
        all_message_ids_json TEXT NOT NULL,
        render_mode_used TEXT NOT NULL,
        published_status TEXT NOT NULL,
        published_payload_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (raw_message_id) REFERENCES processed_raw_messages(raw_message_id) ON DELETE CASCADE,
        FOREIGN KEY (mapping_id) REFERENCES channel_mappings(mapping_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_outputs_mapping_published_at ON translated_outputs(mapping_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outputs_primary_message_id ON translated_outputs(primary_message_id);

      CREATE TABLE IF NOT EXISTS glossary_rules (
        rule_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        source_term TEXT NOT NULL,
        target_term TEXT,
        status TEXT NOT NULL,
        notes TEXT,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_rules_unique_active
        ON glossary_rules(guild_id, source_lang, target_lang, source_term, status);
      CREATE INDEX IF NOT EXISTS idx_glossary_rules_pair ON glossary_rules(guild_id, source_lang, target_lang);
      CREATE INDEX IF NOT EXISTS idx_glossary_rules_guild_status ON glossary_rules(guild_id, status);
      CREATE INDEX IF NOT EXISTS idx_glossary_versions_pair_status ON glossary_versions(guild_id, source_lang, target_lang, sync_status);

      CREATE TABLE IF NOT EXISTS translation_jobs (
        job_id TEXT PRIMARY KEY,
        raw_message_id TEXT NOT NULL UNIQUE,
        mapping_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        priority INTEGER NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (raw_message_id) REFERENCES processed_raw_messages(raw_message_id) ON DELETE CASCADE,
        FOREIGN KEY (mapping_id) REFERENCES channel_mappings(mapping_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_next_attempt ON translation_jobs(status, next_attempt_at, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_mapping_status ON translation_jobs(mapping_id, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires ON translation_jobs(lease_expires_at);

      CREATE TABLE IF NOT EXISTS failed_jobs (
        failed_job_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        raw_message_id TEXT NOT NULL,
        mapping_id TEXT NOT NULL,
        failure_class TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        failure_summary TEXT NOT NULL,
        payload_snapshot_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        first_failed_at TEXT NOT NULL,
        final_failed_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT,
        FOREIGN KEY (job_id) REFERENCES translation_jobs(job_id) ON DELETE CASCADE,
        FOREIGN KEY (raw_message_id) REFERENCES processed_raw_messages(raw_message_id) ON DELETE CASCADE,
        FOREIGN KEY (mapping_id) REFERENCES channel_mappings(mapping_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_failed_jobs_mapping_time ON failed_jobs(mapping_id, final_failed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_failed_jobs_code ON failed_jobs(failure_code);

      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_guild_created_at ON audit_log(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

      CREATE TABLE IF NOT EXISTS admin_preferences (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        compact_status_view INTEGER NOT NULL,
        receive_log_alerts INTEGER NOT NULL,
        timezone TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "002_glossary_partial_unique_index",
    sql: `
      DROP INDEX IF EXISTS idx_glossary_rules_unique_active;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_rules_unique_active
        ON glossary_rules(guild_id, source_lang, target_lang, source_term)
        WHERE status = 'active';
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const appliedRows = db.prepare<[], { id: string }>("SELECT id FROM schema_migrations").all();
  const applied = new Set<string>(appliedRows.map((row: { id: string }) => row.id));

  const tx = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        continue;
      }
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
    }
  });

  tx();
}
