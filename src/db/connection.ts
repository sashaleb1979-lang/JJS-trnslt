import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { AppConfig } from "../domain/types";
import { runMigrations } from "./migrations";
import { applyPragmas } from "./pragmas";

export function ensureDataDirectories(config: AppConfig): { sentinelPath: string } {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const sentinelDir = path.join(config.dataDir, "sentinel");
  fs.mkdirSync(sentinelDir, { recursive: true });
  const sentinelPath = path.join(sentinelDir, "write-check.tmp");
  fs.writeFileSync(sentinelPath, "ok", "utf8");
  fs.unlinkSync(sentinelPath);
  return { sentinelPath };
}

export function openDatabase(config: AppConfig): Database.Database {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  applyPragmas(db);
  runMigrations(db);
  return db;
}
