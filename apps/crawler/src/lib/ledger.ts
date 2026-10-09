/**
 * Local SQLite ledger (development / PC-runner mode).
 *
 * In production the crawler writes to Cloudflare D1 via the HTTP API.
 * Locally it writes to a SQLite file using better-sqlite3 so the same
 * pipeline can be validated without any cloud credentials.
 *
 * The schema mirrors packages/shared/src/schema.ts exactly.
 */

import Database from "better-sqlite3";
import type { CrawlBudget } from "@custom-wayback/shared";

export function openLedger(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createTables(db);
  return db;
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingests (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      pages_total INTEGER NOT NULL DEFAULT 0,
      pages_done INTEGER NOT NULL DEFAULT 0,
      assets_total INTEGER NOT NULL DEFAULT 0,
      assets_done INTEGER NOT NULL DEFAULT 0,
      bytes_stored INTEGER NOT NULL DEFAULT 0,
      budget_json TEXT,
      ia_429_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(domain_id, month)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      ingest_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      url TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      mime TEXT NOT NULL,
      digest TEXT,
      bytes INTEGER,
      r2_key TEXT,
      page_id TEXT,
      resolved_day TEXT,
      resolved_ts TEXT,
      delta_days INTEGER,
      served_at INTEGER,
      purged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS snapshots_domain_day ON snapshots(domain, day);

    CREATE TABLE IF NOT EXISTS assets (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      ref_count INTEGER NOT NULL DEFAULT 1,
      r2_deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS link_resolutions (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      day TEXT NOT NULL,
      from_url TEXT NOT NULL,
      to_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      resolved_day TEXT,
      resolved_ts TEXT,
      delta_days INTEGER,
      UNIQUE(domain, day, from_url, to_url)
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT,
      month TEXT,
      kind TEXT NOT NULL,
      value INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
  `);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export interface IngestRecord {
  id: string;
  domainId: string;
  month: string;
  budget: CrawlBudget;
}

export function upsertIngest(
  db: Database.Database,
  rec: IngestRecord,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ingests
     (id, domain_id, month, status, budget_json, started_at)
     VALUES (?,?,?,'queued',?,?)`,
  ).run(
    rec.id,
    rec.domainId,
    rec.month,
    JSON.stringify(rec.budget),
    Math.floor(Date.now() / 1000),
  );
}

export function updateIngestStatus(
  db: Database.Database,
  id: string,
  status: string,
  extra?: {
    pagesTotal?: number;
    pagesDone?: number;
    assetsTotal?: number;
    assetsDone?: number;
    bytesStored?: number;
    ia429Count?: number;
    errorMessage?: string;
  },
): void {
  const fields = ["status = ?"];
  const values: (string | number)[] = [status];

  if (extra?.pagesTotal !== undefined) { fields.push("pages_total = ?"); values.push(extra.pagesTotal); }
  if (extra?.pagesDone !== undefined) { fields.push("pages_done = ?"); values.push(extra.pagesDone); }
  if (extra?.assetsTotal !== undefined) { fields.push("assets_total = ?"); values.push(extra.assetsTotal); }
  if (extra?.assetsDone !== undefined) { fields.push("assets_done = ?"); values.push(extra.assetsDone); }
  if (extra?.bytesStored !== undefined) { fields.push("bytes_stored = ?"); values.push(extra.bytesStored); }
  if (extra?.ia429Count !== undefined) { fields.push("ia_429_count = ?"); values.push(extra.ia429Count); }
  if (extra?.errorMessage !== undefined) { fields.push("error_message = ?"); values.push(extra.errorMessage); }

  if (["ready", "partial", "failed"].includes(status)) {
    fields.push("finished_at = ?");
    values.push(Math.floor(Date.now() / 1000));
  }

  values.push(id);
  db.prepare(`UPDATE ingests SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function recordUsage(
  db: Database.Database,
  domain: string,
  month: string,
  kind: string,
  value: number,
): void {
  db.prepare(
    `INSERT INTO usage_ledger (domain, month, kind, value, recorded_at)
     VALUES (?,?,?,?,?)`,
  ).run(domain, month, kind, value, Math.floor(Date.now() / 1000));
}
