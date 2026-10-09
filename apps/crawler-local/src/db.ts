/**
 * Local ledger: a thin wrapper over node:sqlite (built into Node 22.5+).
 *
 * No native build step (that is why this package does not use better-sqlite3: its
 * Node 24 build needs a C++ toolchain, and requiring Visual Studio to crawl a website
 * is a bad trade), no server, and the schema mirrors the D1 schema in plan.md
 * section 8 so Phase 4 is a migration rather than a rewrite.
 *
 * Everything here is idempotent so a crawl can be re-run and will reuse prior work.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SnapshotRow {
  domain: string;
  url: string;
  day: string;
  ts: string;
  status: number;
  mime: string;
  digest: string | null;
  bytes: number;
  r2Key: string;
  title: string | null;
  depth: number;
  navScore: number;
}

export interface RunRow {
  id: string;
  domain: string;
  month: string;
  mode: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  pagesTotal: number;
  pagesDone: number;
  assetsTotal: number;
  assetsDone: number;
  bytesStored: number;
  iaRequests: number;
  iaBytes: number;
  ia429: number;
  dedupeHits: number;
  error: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  domain       TEXT NOT NULL,
  month        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages_total  INTEGER NOT NULL DEFAULT 0,
  pages_done   INTEGER NOT NULL DEFAULT 0,
  assets_total INTEGER NOT NULL DEFAULT 0,
  assets_done  INTEGER NOT NULL DEFAULT 0,
  bytes_stored INTEGER NOT NULL DEFAULT 0,
  ia_requests  INTEGER NOT NULL DEFAULT 0,
  ia_bytes     INTEGER NOT NULL DEFAULT 0,
  ia_429       INTEGER NOT NULL DEFAULT 0,
  dedupe_hits  INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS captures (
  domain     TEXT NOT NULL,
  url        TEXT NOT NULL,
  ts         TEXT NOT NULL,
  mime       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  digest     TEXT,
  bytes      INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'html',
  PRIMARY KEY (domain, url, ts)
);
CREATE INDEX IF NOT EXISTS captures_url ON captures(domain, url);
CREATE INDEX IF NOT EXISTS captures_kind ON captures(domain, kind);

CREATE TABLE IF NOT EXISTS snapshot (
  domain     TEXT NOT NULL,
  url        TEXT NOT NULL,
  day        TEXT NOT NULL,
  ts         TEXT NOT NULL,
  status     INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  digest     TEXT,
  bytes      INTEGER NOT NULL DEFAULT 0,
  title      TEXT,
  depth      INTEGER NOT NULL DEFAULT 0,
  nav_score  INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  url_hash   TEXT NOT NULL,
  PRIMARY KEY (domain, url, day)
);
CREATE INDEX IF NOT EXISTS snapshot_day ON snapshot(domain, day);
CREATE INDEX IF NOT EXISTS snapshot_ts ON snapshot(domain, ts);

CREATE TABLE IF NOT EXISTS snapshot_extra (
  domain TEXT NOT NULL,
  url    TEXT NOT NULL,
  day    TEXT NOT NULL,
  ts     TEXT NOT NULL,
  PRIMARY KEY (domain, url, day, ts)
);

CREATE TABLE IF NOT EXISTS link_resolution (
  domain       TEXT NOT NULL,
  day          TEXT NOT NULL,
  from_url     TEXT NOT NULL,
  to_url       TEXT NOT NULL,
  resolved_day TEXT,
  resolved_ts  TEXT,
  delta_days   INTEGER,
  kind         TEXT NOT NULL,
  PRIMARY KEY (domain, day, from_url, to_url)
);

CREATE TABLE IF NOT EXISTS asset (
  hash       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  orig_url   TEXT,
  ref_count  INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_url ON asset(orig_url);

CREATE TABLE IF NOT EXISTS asset_ref (
  domain TEXT NOT NULL,
  day    TEXT NOT NULL,
  url    TEXT NOT NULL,
  hash   TEXT NOT NULL,
  role   TEXT NOT NULL,
  PRIMARY KEY (domain, day, url, hash, role)
);
CREATE INDEX IF NOT EXISTS asset_ref_hash ON asset_ref(hash);

CREATE TABLE IF NOT EXISTS cdx_survey (
  domain     TEXT NOT NULL,
  month      TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  payload    BLOB NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (domain, month, query_hash)
);

CREATE TABLE IF NOT EXISTS run_event (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at     INTEGER NOT NULL,
  level  TEXT NOT NULL,
  msg    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_event_run ON run_event(run_id);

CREATE TABLE IF NOT EXISTS usage (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  domain TEXT,
  month  TEXT,
  kind   TEXT NOT NULL,
  value  INTEGER NOT NULL,
  at     INTEGER NOT NULL
);
`;

type SqlValue = string | number | null;

/**
 * node:sqlite returns plain objects keyed by **column name** (snake_case), not by the
 * camelCase properties our interfaces declare. Treating a returned row as a typed
 * object without mapping is a silent lie: `row.r2Key` is `undefined` at runtime even
 * though TypeScript says it is a string. These mappers are the only place that
 * conversion happens, so nothing downstream can be fooled.
 */
function mapSnapshotRow(raw: unknown): SnapshotRow | undefined {
  if (!raw) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    domain: String(r['domain']),
    url: String(r['url']),
    day: String(r['day']),
    ts: String(r['ts']),
    status: Number(r['status']),
    mime: String(r['mime']),
    digest: r['digest'] === null || r['digest'] === undefined ? null : String(r['digest']),
    bytes: Number(r['bytes']),
    r2Key: String(r['r2_key']),
    title: r['title'] === null || r['title'] === undefined ? null : String(r['title']),
    depth: Number(r['depth']),
    navScore: Number(r['nav_score']),
  };
}

function mapRunRow(raw: unknown): RunRow | undefined {
  if (!raw) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    id: String(r['id']),
    domain: String(r['domain']),
    month: String(r['month']),
    mode: String(r['mode']),
    status: String(r['status']),
    startedAt: Number(r['started_at']),
    finishedAt: r['finished_at'] === null || r['finished_at'] === undefined ? null : Number(r['finished_at']),
    pagesTotal: Number(r['pages_total']),
    pagesDone: Number(r['pages_done']),
    assetsTotal: Number(r['assets_total']),
    assetsDone: Number(r['assets_done']),
    bytesStored: Number(r['bytes_stored']),
    iaRequests: Number(r['ia_requests']),
    iaBytes: Number(r['ia_bytes']),
    ia429: Number(r['ia_429']),
    dedupeHits: Number(r['dedupe_hits']),
    error: r['error'] === null || r['error'] === undefined ? null : String(r['error']),
  };
}

function mapAssetRow(raw: unknown): { hash: string; mime: string; bytes: number; ref_count: number; orig_url: string | null } {
  const r = raw as Record<string, unknown>;
  return {
    hash: String(r['hash']),
    mime: String(r['mime']),
    bytes: Number(r['bytes']),
    ref_count: Number(r['ref_count']),
    orig_url: r['orig_url'] === null || r['orig_url'] === undefined ? null : String(r['orig_url']),
  };
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- runs

  startRun(id: string, domain: string, month: string, mode: string): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, domain, month, mode, status, started_at) VALUES (?, ?, ?, ?, 'surveying', ?)
         ON CONFLICT(id) DO UPDATE SET status='surveying', started_at=excluded.started_at`,
      )
      .run(id, domain, month, mode, Date.now());
  }

  updateRun(id: string, fields: Partial<Omit<RunRow, 'id' | 'domain' | 'month' | 'mode'>>): void {
    const map: Record<string, string> = {
      status: 'status',
      finishedAt: 'finished_at',
      pagesTotal: 'pages_total',
      pagesDone: 'pages_done',
      assetsTotal: 'assets_total',
      assetsDone: 'assets_done',
      bytesStored: 'bytes_stored',
      iaRequests: 'ia_requests',
      iaBytes: 'ia_bytes',
      ia429: 'ia_429',
      dedupeHits: 'dedupe_hits',
      error: 'error',
    };
    const sets: string[] = [];
    const values: SqlValue[] = [];
    for (const [key, value] of Object.entries(fields)) {
      const column = map[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(value as SqlValue);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getRun(id: string): RunRow | undefined {
    return mapRunRow(this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id));
  }

  addEvent(runId: string, level: string, msg: string): void {
    this.db
      .prepare(`INSERT INTO run_event (run_id, at, level, msg) VALUES (?, ?, ?, ?)`)
      .run(runId, Date.now(), level, msg);
  }

  // ---------------------------------------------------------------- captures

  /** Replace the stored capture index for a domain+kind. */
  replaceCaptures(
    domain: string,
    kind: string,
    rows: { url: string; ts: string; mime: string; status: number; digest: string | null; bytes: number }[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO captures (domain, url, ts, mime, status, digest, bytes, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, url, ts) DO UPDATE SET mime=excluded.mime, status=excluded.status,
         digest=excluded.digest, bytes=excluded.bytes, kind=excluded.kind`,
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        insert.run(domain, r.url, r.ts, r.mime, r.status, r.digest, r.bytes, kind);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  countCaptures(domain: string, kind: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM captures WHERE domain = ? AND kind = ?`)
      .get(domain, kind) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------------- snapshots

  upsertSnapshot(row: SnapshotRow, urlHash: string): void {
    this.db
      .prepare(
        `INSERT INTO snapshot (domain, url, day, ts, status, mime, digest, bytes, title, depth, nav_score, r2_key, url_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain, url, day) DO UPDATE SET ts=excluded.ts, status=excluded.status, mime=excluded.mime,
           digest=excluded.digest, bytes=excluded.bytes, title=excluded.title, depth=excluded.depth,
           nav_score=excluded.nav_score, r2_key=excluded.r2_key, url_hash=excluded.url_hash`,
      )
      .run(
        row.domain, row.url, row.day, row.ts, row.status, row.mime, row.digest, row.bytes,
        row.title, row.depth, row.navScore, row.r2Key, urlHash,
      );
  }

  recordExtraCapture(domain: string, url: string, day: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO snapshot_extra (domain, url, day, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(domain, url, day, ts) DO NOTHING`,
      )
      .run(domain, url, day, ts);
  }

  snapshotFor(domain: string, url: string, day: string): SnapshotRow | undefined {
    return mapSnapshotRow(
      this.db
        .prepare(`SELECT * FROM snapshot WHERE domain = ? AND url = ? AND day = ?`)
        .get(domain, url, day),
    );
  }

  pagesForDay(domain: string, day: string): SnapshotRow[] {
    return this.db
      .prepare(`SELECT * FROM snapshot WHERE domain = ? AND day = ? ORDER BY url`)
      .all(domain, day)
      .map(mapSnapshotRow)
      .filter((row): row is SnapshotRow => row !== undefined);
  }

  allSnapshots(domain: string): SnapshotRow[] {
    return this.db
      .prepare(`SELECT * FROM snapshot WHERE domain = ? ORDER BY day, url`)
      .all(domain)
      .map(mapSnapshotRow)
      .filter((row): row is SnapshotRow => row !== undefined);
  }

  daysWithPages(domain: string): { day: string; n: number }[] {
    return this.db
      .prepare(`SELECT day, COUNT(*) AS n FROM snapshot WHERE domain = ? GROUP BY day ORDER BY day`)
      .all(domain) as never;
  }

  // ---------------------------------------------------------------- link ledger

  upsertLinkResolution(row: {
    domain: string;
    day: string;
    fromUrl: string;
    toUrl: string;
    resolvedDay: string | null;
    resolvedTs: string | null;
    deltaDays: number | null;
    kind: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO link_resolution (domain, day, from_url, to_url, resolved_day, resolved_ts, delta_days, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain, day, from_url, to_url) DO UPDATE SET resolved_day=excluded.resolved_day,
           resolved_ts=excluded.resolved_ts, delta_days=excluded.delta_days, kind=excluded.kind`,
      )
      .run(
        row.domain, row.day, row.fromUrl, row.toUrl, row.resolvedDay, row.resolvedTs, row.deltaDays, row.kind,
      );
  }

  linkResolutionsFor(
    domain: string,
    day: string,
  ): { to_url: string; resolved_day: string | null; resolved_ts: string | null; delta_days: number | null; kind: string }[] {
    return this.db
      .prepare(
        `SELECT to_url, resolved_day, resolved_ts, delta_days, kind
           FROM link_resolution WHERE domain = ? AND day = ?`,
      )
      .all(domain, day) as never;
  }

  // ---------------------------------------------------------------- assets

  upsertAsset(row: { hash: string; mime: string; bytes: number; r2Key: string; origUrl: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO asset (hash, mime, bytes, r2_key, orig_url, first_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1,
           orig_url = COALESCE(asset.orig_url, excluded.orig_url)`,
      )
      .run(row.hash, row.mime, row.bytes, row.r2Key, row.origUrl, Date.now());
  }

  addAssetRef(domain: string, day: string, url: string, hash: string, role: string): void {
    this.db
      .prepare(
        `INSERT INTO asset_ref (domain, day, url, hash, role) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(domain, day, url, hash, role) DO NOTHING`,
      )
      .run(domain, day, url, hash, role);
  }

  assetStats(): { unique: number; totalBytes: number; shared: number; refs: number } {
    const uniq = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM asset`)
      .get() as { n: number; b: number };
    const shared = this.db
      .prepare(`SELECT COUNT(*) AS n FROM asset WHERE ref_count > 1`)
      .get() as { n: number };
    const refs = this.db.prepare(`SELECT COUNT(*) AS n FROM asset_ref`).get() as { n: number };
    return { unique: uniq.n, totalBytes: uniq.b, shared: shared.n, refs: refs.n };
  }

  topAssets(limit = 10): { hash: string; mime: string; bytes: number; ref_count: number; orig_url: string | null }[] {
    return this.db
      .prepare(
        `SELECT hash, mime, bytes, ref_count, orig_url FROM asset ORDER BY ref_count DESC, bytes DESC LIMIT ?`,
      )
      .all(limit)
      .map(mapAssetRow);
  }

  /** How many bytes would have been stored without content-addressed dedupe. */
  naiveAssetBytes(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(a.bytes),0) AS b FROM asset_ref r JOIN asset a ON a.hash = r.hash`)
      .get() as { b: number };
    return row.b;
  }

  // ---------------------------------------------------------------- survey cache

  getSurvey(domain: string, month: string, queryHash: string): string | undefined {
    const row = this.db
      .prepare(`SELECT payload FROM cdx_survey WHERE domain = ? AND month = ? AND query_hash = ?`)
      .get(domain, month, queryHash) as { payload: Uint8Array } | undefined;
    if (!row) return undefined;
    return new TextDecoder().decode(row.payload);
  }

  putSurvey(domain: string, month: string, queryHash: string, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO cdx_survey (domain, month, query_hash, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(domain, month, query_hash) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
      )
      .run(domain, month, queryHash, new TextEncoder().encode(payload), Date.now());
  }

  // ---------------------------------------------------------------- usage

  recordUsage(runId: string, domain: string, month: string, kind: string, value: number): void {
    this.db
      .prepare(`INSERT INTO usage (run_id, domain, month, kind, value, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, domain, month, kind, value, Date.now());
  }
}
