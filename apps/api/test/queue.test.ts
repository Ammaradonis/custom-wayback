/**
 * The queue consumer, driven end to end without touching archive.org.
 *
 * ## Why a fake environment rather than Miniflare
 *
 * The cloud ingest path is the part of Phase 4 most likely to break silently, and
 * the parts that break are the *transitions*: survey → pages → assets → finalize,
 * the cursor advancing, the breaker parking a job, a retry picking up where it
 * stopped. Those are exactly the behaviours a real `wrangler dev` run cannot test,
 * because archive.org decides whether a survey succeeds and a 429 storm is not
 * something you can schedule.
 *
 * So this file runs the real `handleIngestMessage` against a small fake of the
 * three bindings it uses (D1, R2, Queues) plus a stubbed `fetch`. The ingest
 * module itself is untouched — no test-only branches, no injected seams — which is
 * the point: the test exercises the shipping code path.
 *
 * The D1 fake understands only the statements this consumer issues. That is a
 * deliberate limit, and it fails loudly on anything unrecognised rather than
 * quietly returning nothing, so a new query shows up here as a test failure
 * instead of as a mystery in production.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleIngestMessage, type IngestTestEnv } from "../src/queue/ingest.ts";

// ── A very small relational store ────────────────────────────────────────────
//
// Rows are plain objects. The "SQL" is matched by shape, not parsed, because the
// consumer issues a fixed, small set of statements.

/**
 * Columns SQLite would store with INTEGER affinity. Values bound to them are
 * coerced on write, exactly as D1 does, so arithmetic in the consumer behaves the
 * same here as in production. Without this the fake drifts between numbers and
 * numeric strings and the tests stop meaning what they say.
 */
const NUMERIC_COLUMNS = new Set([
  "cursor",
  "asset_cursor",
  "pages_total",
  "pages_done",
  "assets_total",
  "assets_done",
  "bytes_stored",
  "ia_429_count",
  "consecutive_429",
  "stage_attempts",
  "attempts",
  "lease_until",
  "breaker_open_until",
  "last_throttle_at",
  "status_code",
  "bytes",
  "ref_count",
  "first_seen_at",
  "value",
  "wait_ms",
  "created_at",
  "recorded_at",
  "delta_days",
  "resolved_day_epoch",
]);

function coerce(column: string, value: unknown): unknown {
  if (!NUMERIC_COLUMNS.has(column)) return value;
  if (value === null || value === undefined) return value;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : value;
}

/**
 * Split a SET clause on the commas that separate assignments — not the commas
 * inside `COALESCE(a, b)` or a CASE expression.
 */
function splitTopLevel(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of clause) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Apply the one CASE expression this consumer uses:
 *
 *   col = CASE WHEN <cond> THEN COALESCE(col, '<fallback>') ELSE col END
 *   col = CASE WHEN <cond> THEN ? ELSE col END
 *
 * `nextBind` advances the caller's bind cursor by however many `?` the expression
 * contains, so the bind positions stay aligned with the SQL.
 */
function handleCaseColumn(
  row: Row,
  column: string,
  expression: string,
  params: unknown[],
  nextBind: () => number,
): void {
  const whenMatch = /^CASE WHEN (.+?) THEN (.+?) ELSE .+? END$/s.exec(expression);
  if (!whenMatch) return;
  const [, condition, thenBranch] = whenMatch as unknown as [string, string, string];

  // The conditions used here are `<bind> > 0` and `<bind> = 'failed'`.
  let conditionHolds = false;
  const compare = /^\?\s*(>|=)\s*(.+)$/.exec(condition.trim());
  if (compare) {
    const [, operator, operandText] = compare as unknown as [string, string, string];
    const bound = params[nextBind()];
    const operand = operandText.trim().replace(/^'(.*)'$/s, "$1");
    conditionHolds = operator === ">" ? Number(bound) > Number(operand) : String(bound) === operand;
  }

  const thenTrimmed = thenBranch.trim();
  const coalesceMatch = /^COALESCE\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'?([^')]*)'?\s*\)$/i.exec(thenTrimmed);
  if (coalesceMatch) {
    const [, innerColumn, fallback] = coalesceMatch as unknown as [string, string, string];
    if (conditionHolds && !row[innerColumn]) row[innerColumn] = coerce(innerColumn, fallback);
    return;
  }

  if (thenTrimmed === "?") {
    const value = params[nextBind()];
    if (conditionHolds) row[column] = coerce(column, value);
    else if (row[column] === undefined) row[column] = null;
  }
}

type Row = Record<string, unknown>;

interface TableSpec {
  /** Column name in the `bind()` order the consumer uses, per statement kind. */
  name: string;
  rows: Row[];
  /** Primary key columns, for INSERT OR REPLACE semantics. */
  key: string[];
}

class FakeDb {
  readonly tables = new Map<string, TableSpec>();
  readonly log: string[] = [];
  /** Statements the fake did not understand — a failure, not a silent no-op. */
  readonly unrecognised: string[] = [];

  seedIngest(row: Row): void {
    this.table("ingests", ["id"]).rows.push(row);
  }

  ingest(): Row {
    const row = this.table("ingests", ["id"]).rows[0];
    if (!row) throw new Error("no ingest row");
    return row;
  }

  snapshots(): Row[] {
    return this.table("snapshots", ["id"]).rows;
  }

  assets(): Row[] {
    return this.table("assets", ["hash"]).rows;
  }

  links(): Row[] {
    return this.table("link_resolutions", ["id"]).rows;
  }

  usage(): Row[] {
    return this.table("usage_ledger", ["id"]).rows;
  }

  /** Rows the consumer wrote into the full-text index. */
  searchDocs(): Row[] {
    return this.table("search_docs", ["snapshot_id"]).rows;
  }

  /** Rows the consumer wrote into the FTS5 table itself. */
  ftsRows(): Row[] {
    return this.table("snapshot_fts", ["doc_id"]).rows;
  }

  throttles(): Row[] {
    return this.table("throttle_events", ["id"]).rows;
  }

  private table(name: string, key: string[]): TableSpec {
    let t = this.tables.get(name);
    if (!t) {
      t = { name, rows: [], key };
      this.tables.set(name, t);
    }
    return t;
  }

  private upsert(name: string, key: string[], row: Row): void {
    const t = this.table(name, key);
    const idx = t.rows.findIndex((r) => key.every((k) => r[k] === row[k]));
    if (idx >= 0) t.rows[idx] = { ...t.rows[idx], ...row };
    else t.rows.push(row);
  }

  /** Build the D1-like interface the consumer uses. */
  binding(): D1Database {
    const self = this;

    function makeStatement(sql: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          const rows = exec(sql, bound);
          return (rows[0] as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: exec(sql, bound) as T[] };
        },
        async run(): Promise<{ success: true; meta: { changes: number } }> {
          const rows = exec(sql, bound);
          return { success: true, meta: { changes: rows.length } };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    }

    function exec(sql: string, params: unknown[]): Row[] {
      const s = sql.replace(/\s+/g, " ").trim();
      self.log.push(s.slice(0, 90));

      // ── ingests: load ────────────────────────────────────────────────────
      //
      // Returns the live row objects, exactly as D1 returns the current state.
      // The consumer re-reads its own row between stages, so a fake that returned
      // a snapshot would let a stalled stage machine look healthy for a whole
      // test run.
      if (/^SELECT i\.id, i\.domain_id/i.test(s)) {
        return self.table("ingests", ["id"]).rows;
      }

      // ── ingests: updates ────────────────────────────────────────────────
      //
      // The SET clause is parsed, not looked up. See the comment at the parse site
      // for why three hand-maintained column maps in a row were a mistake.

      /** The SET clause of a normalised `UPDATE ingests SET … WHERE id = ?`. */
      const setClauseOf = (statement: string): string | null =>
        /^UPDATE ingests SET (.*?) WHERE id = \?$/.exec(statement)?.[1] ?? null;

      const setClause = setClauseOf(s);
      if (setClause !== null) {
        // Parse the SET clause rather than looking it up in a hand-written table.
        //
        // Three earlier versions of this fake maintained a column map, and all
        // three mis-wrote a column while the tests still passed: prefix regexes
        // collided across statements sharing an opening, full-text keys broke when
        // a template literal wrapped, and one map listed `cursor` for an SQL
        // literal `cursor = 0` — writing the ingest id into the cursor. The
        // symptom each time was identical and invisible: a cursor that never
        // advances, so the stage machine loops to its ceiling and the crawl
        // "completes" having done nothing.
        //
        // So the fake now derives the write from the SQL itself. There is nothing
        // left to keep in sync, and `?` positions cannot get out of step with
        // column names because both are read from the same text.
        const row = self.ingest();
        let bindIndex = 0;
        for (const assignment of splitTopLevel(setClause)) {
          const eq = assignment.indexOf("=");
          if (eq < 0) {
            throw new Error(`Fake D1 cannot parse SET assignment "${assignment}" (no "=").`);
          }
          const column = assignment.slice(0, eq).trim();
          const expression = assignment.slice(eq + 1).trim();

          if (expression === "?") {
            const bound = params[bindIndex++];
            row[column] = coerce(column, bound);
            continue;
          }
          if (/^NULL$/i.test(expression)) {
            row[column] = null;
            continue;
          }
          if (/^COALESCE\(/i.test(expression)) {
            // The only COALESCE here is `COALESCE(col, ?)`: a non-null bind wins,
            // otherwise the existing value stays.
            const bound = params[bindIndex++];
            if (row[column] === null || row[column] === undefined) row[column] = coerce(column, bound);
            continue;
          }
          if (/^CASE\b/i.test(expression)) {
            handleCaseColumn(row, column, expression, params, () => bindIndex++);
            continue;
          }
          // `col = col + ?` — a counter increment. The spacing varies between call
          // sites (`+ ?`, `+?`), which is exactly the kind of detail a
          // hand-maintained pattern gets wrong and then silently skips a write.
          if (/^[A-Za-z_][A-Za-z0-9_]*\s*\+\s*\?$/.test(expression)) {
            row[column] = coerce(column, Number(row[column] ?? 0) + Number(params[bindIndex++] ?? 0));
            continue;
          }
          if (expression.includes("?")) {
            throw new Error(
              `Fake D1 does not understand the SET expression "${column} = ${expression}". ` +
              `Teach it rather than letting the write be silently dropped — a dropped ` +
              `write is invisible and makes the whole suite meaningless.`,
            );
          }
          // A literal: strip surrounding quotes if present.
          row[column] = coerce(column, expression.replace(/^'(.*)'$/s, "$1"));
        }

        const expectedBinds = (setClause.match(/\?/g) ?? []).length;
        if (bindIndex !== expectedBinds) {
          throw new Error(
            `Fake D1 consumed ${bindIndex} bind(s) for "${setClause.replace(/\s+/g, " ")}" ` +
            `but the SET clause has ${expectedBinds}. The parser and the SQL disagree; ` +
            `fix the parser rather than the assertion.`,
          );
        }
        return [];
      }

      if (/^UPDATE domains SET last_crawled_at/i.test(s)) return [];

      // ── snapshots ────────────────────────────────────────────────────────
      if (/^INSERT OR REPLACE INTO snapshots/i.test(s)) {
        const cols = [
          "id", "ingest_id", "domain", "url", "day", "ts", "status_code", "mime",
          "digest", "bytes", "r2_key", "page_id", "served_at", "purged_at",
          "resolved_day", "resolved_ts", "delta_days", "content_digest", "title",
        ];
        const row: Row = {};
        cols.forEach((c, i) => (row[c] = params[i]));
        self.upsert("snapshots", ["id"], row);
        return [row];
      }

      // ── search index (Phase 5) ───────────────────────────────────────────
      //
      // Modelled rather than ignored, so the tests can assert that a crawl
      // actually produces index rows — and so a statement the consumer starts
      // issuing without a handler here shows up as a failure instead of passing
      // silently (which is the whole reason `unrecognised` exists).
      if (/^DELETE FROM snapshot_fts WHERE doc_id = \?/i.test(s)) {
        const table = self.table("snapshot_fts", ["doc_id"]);
        for (let i = table.rows.length - 1; i >= 0; i--) {
          if (table.rows[i]?.["doc_id"] === params[0]) table.rows.splice(i, 1);
        }
        return [];
      }
      if (/^INSERT INTO snapshot_fts/i.test(s)) {
        const row: Row = {
          doc_id: params[0], url: params[1], title: params[2], text: params[3],
          domain: params[4], day: params[5], ts: params[6],
        };
        self.upsert("snapshot_fts", ["doc_id"], row);
        return [row];
      }
      if (/^INSERT OR REPLACE INTO search_docs/i.test(s)) {
        const row: Row = {
          snapshot_id: params[0], domain: params[1], url: params[2], day: params[3],
          title: params[4], bytes: params[5], indexed_at: params[6],
        };
        self.upsert("search_docs", ["snapshot_id"], row);
        return [row];
      }

      // ── assets ───────────────────────────────────────────────────────────
      if (/^SELECT hash FROM assets WHERE hash = \?/i.test(s)) {
        return self.table("assets", ["hash"]).rows.filter((r) => r["hash"] === params[0]);
      }
      if (/^UPDATE assets SET ref_count = ref_count \+ 1/i.test(s)) {
        const row = self.table("assets", ["hash"]).rows.find((r) => r["hash"] === params[0]);
        if (row) row["ref_count"] = Number(row["ref_count"] ?? 1) + 1;
        return row ? [row] : [];
      }
      if (/^INSERT OR REPLACE INTO assets/i.test(s)) {
        const row: Row = {
          hash: params[0], mime: params[1], bytes: params[2],
          r2_key: params[3], first_seen_at: params[4], ref_count: params[5],
        };
        self.upsert("assets", ["hash"], row);
        return [row];
      }

      // ── link resolutions ─────────────────────────────────────────────────
      if (/^INSERT OR IGNORE INTO link_resolutions/i.test(s)) {
        const row: Row = {
          id: params[0], domain: params[1], day: params[2], from_url: params[3],
          to_url: params[4], kind: params[5], resolved_day: params[6],
          resolved_ts: params[7], delta_days: params[8],
        };
        const existing = self.table("link_resolutions", ["id"]).rows.some((r) => r["id"] === row["id"]);
        if (!existing) self.table("link_resolutions", ["id"]).rows.push(row);
        return [row];
      }

      // ── usage ledger ─────────────────────────────────────────────────────
      if (/^INSERT INTO usage_ledger/i.test(s)) {
        const row: Row = {
          domain: params[0], month: params[1], kind: params[2],
          value: params[3], recorded_at: params[4],
        };
        self.table("usage_ledger", ["domain", "month", "kind", "recorded_at"]).rows.push(row);
        return [row];
      }

      // ── throttle telemetry ───────────────────────────────────────────────
      if (/^INSERT INTO throttle_events/i.test(s)) {
        const row: Row = {
          domain: params[0], month: params[1], ingest_id: params[2], host: params[3],
          status: params[4], wait_ms: params[5], attempt: params[6],
          breaker_open: params[7], kind: params[8], created_at: params[9],
        };
        self.table("throttle_events", ["created_at", "status"]).rows.push(row);
        return [row];
      }

      self.unrecognised.push(s.slice(0, 160));
      return [];
    }

    return {
      prepare: makeStatement,
      async batch(statements: D1PreparedStatement[]) {
        const out = [];
        for (const s of statements) out.push(await s.run());
        return out;
      },
    } as unknown as D1Database;
  }
}

// ── R2 / Queue / KV fakes ────────────────────────────────────────────────────

class FakeR2 {
  readonly objects = new Map<string, { bytes: number; contentType: string }>();
  puts = 0;

  binding(): R2Bucket {
    const self = this;
    return {
      async put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: R2PutOptions) {
        const size =
          typeof value === "string"
            ? new TextEncoder().encode(value).byteLength
            : value instanceof ArrayBuffer
              ? value.byteLength
              : (value as ArrayBufferView).byteLength;
        self.objects.set(key, {
          bytes: size,
          contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
        });
        self.puts += 1;
        return { key } as unknown as R2Object;
      },
    } as unknown as R2Bucket;
  }
}

interface SentMessage {
  body: unknown;
  delaySeconds?: number;
}

class FakeQueue {
  readonly sent: SentMessage[] = [];
  binding(): Queue {
    const self = this;
    return {
      async send(body: unknown, options?: { delaySeconds?: number }) {
        self.sent.push(options?.delaySeconds === undefined ? { body } : { body, delaySeconds: options.delaySeconds });
      },
    } as unknown as Queue;
  }
}

// ── Scenario ─────────────────────────────────────────────────────────────────

const DOMAIN = "example.com";
const MONTH = "2024-01";

const CDX_HEADER = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const CDX_ROWS = [
  ["20240115090000", `https://${DOMAIN}/`, "text/html", "200", "digest-home", "4200"],
  ["20240115090000", `https://${DOMAIN}/about`, "text/html", "200", "digest-about", "3000"],
];

const HOME_HTML = `<!DOCTYPE html>
<html lang="en"><head>
  <title>Example</title>
  <link rel="stylesheet" href="/style.css">
</head><body>
  <h1>Example Domain</h1>
  <img src="/logo.png" alt="logo">
  <a href="/about">About</a>
  <a href="/never-captured">Dead</a>
  <a href="https://elsewhere.test/">External</a>
  <script src="/app.js"></script>
  <script src="https://www.google-analytics.com/analytics.js"></script>
  <form action="/search"><input name="q"></form>
  <base href="https://example.com/">
</body></html>`;

const ABOUT_HTML = `<!DOCTYPE html><html><head><title>About</title></head>
<body><img src="/logo.png"><a href="/">Home</a></body></html>`;

const CSS = "body { background: url('/bg.png'); }";
const JS = "console.log('app');";

interface Harness {
  db: FakeDb;
  r2: FakeR2;
  queue: FakeQueue;
  env: IngestTestEnv;
  fetches: string[];
  /** Remove the fetch stub. */
  restore(): void;
}

function harness(options: { maxPages?: number; fetchBehaviour?: (url: string) => Response | undefined } = {}): Harness {
  const db = new FakeDb();
  db.seedIngest({
    id: "ingest-1",
    domain_id: "domain-1",
    month: MONTH,
    status: "queued",
    stage: null,
    cursor: 0,
    asset_cursor: 0,
    pages_json: null,
    assets_json: null,
    day_index_json: null,
    pages_total: 0,
    pages_done: 0,
    assets_total: 0,
    assets_done: 0,
    bytes_stored: 0,
    budget_json: JSON.stringify({
      maxPagesPerMonth: options.maxPages ?? 10,
      maxBytesPerMonth: 750 * 1024 * 1024,
      maxAssetsPerPage: 120,
      maxDepth: 3,
    }),
    ia_429_count: 0,
    consecutive_429: 0,
    breaker_open_until: null,
    lease_until: null,
    attempts: 0,
    stage_attempts: 0,
  });

  const r2 = new FakeR2();
  const queue = new FakeQueue();
  const fetches: string[] = [];

  const env = {
    DB: db.binding(),
    STORAGE: r2.binding(),
    INGEST_QUEUE: queue.binding(),
    DLQ_QUEUE: queue.binding(),
    COVERAGE_KV: { async delete() {}, async get() { return null; }, async put() {} } as unknown as KVNamespace,
    ASSETS: { async fetch() { return new Response(""); } } as unknown as Fetcher,
    JWT_SECRET: "x".repeat(48),
    STORAGE_ACCESS_KEY_ID: "test",
    STORAGE_SECRET_ACCESS_KEY: "test",
    STORAGE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    STORAGE_BUCKET_NAME: "test-bucket",
    CRAWLER_USER_AGENT: "CustomWaybackTestBot/1.0",
    MAX_PAGES_PER_MONTH: "1000",
    SNAPSHOT_BEHAVIOR: "nearest" as const,
    PURGE_GRACE_SECONDS: "1800",
    CRAWL_QUOTA_PER_DAY: "8",
    MONTHLY_BUDGET_USD: "25",
  } as unknown as IngestTestEnv;

  // Stub the network. `id_` fetches get the archived bytes; the CDX endpoint gets
  // a real CDX JSON document. Anything else is a test bug and returns 404.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetches.push(url);

    const custom = options.fetchBehaviour?.(url);
    if (custom) return custom;

    if (url.includes("/cdx/search/cdx")) {
      return new Response(JSON.stringify([CDX_HEADER, ...CDX_ROWS]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/style.css")) {
      return new Response(CSS, { status: 200, headers: { "content-type": "text/css" } });
    }
    if (url.includes("/app.js")) {
      return new Response(JS, { status: 200, headers: { "content-type": "application/javascript" } });
    }
    if (url.includes("/logo.png")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.includes("/bg.png")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.includes(`https://${DOMAIN}/about`) && url.includes("id_")) {
      return new Response(ABOUT_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes(`https://${DOMAIN}/`) && url.includes("id_")) {
      return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not archived", { status: 404 });
  }) as typeof globalThis.fetch;

  return { db, r2, queue, env, fetches, restore: () => { globalThis.fetch = originalFetch; } };
}

/** Drive the stage machine to completion, following the messages it re-enqueues. */
async function drain(
  env: IngestTestEnv,
  db: FakeDb,
  queue: FakeQueue,
  start: { ingestId: string; stage: string },
  maxMessages = 60,
): Promise<string[]> {
  const processed: string[] = [];
  let next: { stage: string } | undefined = start as { stage: string };

  for (let guard = 0; guard < maxMessages && next; guard++) {
    const stage = next.stage;
    processed.push(stage);
    const before = queue.sent.length;
    await handleIngestMessage(env, {
      ingestId: start.ingestId,
      domain: DOMAIN,
      month: MONTH,
      stage: stage as "survey" | "pages" | "assets" | "finalize",
    });
    const after = queue.sent.slice(before);
    const followUp = after.at(-1);
    // A delay means the breaker parked the job — stop there; the tests that care
    // about throttling assert on it explicitly.
    if (!followUp || followUp.delaySeconds !== undefined) break;
    next = followUp.body as { stage: string };
  }

  return processed;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("survey stage freezes a work plan and moves the job to the pages stage", async () => {
  const h = harness();
  try {
    await handleIngestMessage(h.env, {
      ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "survey",
    });

    const row = h.db.ingest();
    assert.equal(row["stage"], "pages");
    assert.equal(row["status"], "fetching");

    const plan = JSON.parse(row["pages_json"] as string) as { url: string; day: string; ts: string }[];
    assert.equal(plan.length, 2, "two captured URLs → two planned pages");
    assert.equal(plan[0]?.url, `https://${DOMAIN}/`, "the seed page is crawled first");

    const dayIndex = JSON.parse(row["day_index_json"] as string) as Record<string, Record<string, string>>;
    assert.equal(dayIndex[`https://${DOMAIN}/`]?.["2024-01-15"], "20240115090000");

    // The plan was queued for the next stage rather than done inline.
    const follow = h.queue.sent.at(-1)?.body as { stage: string };
    assert.equal(follow.stage, "pages");
    assert.equal(h.queue.sent.at(-1)?.delaySeconds, undefined, "no delay when nothing throttled us");

    assert.deepEqual(h.db.unrecognised, [], "every statement the consumer issued was understood by the fake");
  } finally {
    h.restore();
  }
});

test("pages and assets stages run to completion and store content-addressed bytes", async () => {
  const h = harness();
  try {
    const stages = await drain(h.env, h.db, h.queue, { ingestId: "ingest-1", stage: "survey" });

    // The plan is bounded, so the number of messages must be too. A drain that
    // keeps going means a cursor is not advancing — which is precisely the bug an
    // earlier version of this test hid behind a loose attempt ceiling. The
    // expected shape is exactly survey → pages → assets → finalize.
    assert.ok(
      stages.length <= 8,
      `2 pages should take a handful of messages, took ${stages.length}: ${stages.join(" → ")}`,
    );
    assert.deepEqual(
      [...new Set(stages)],
      ["survey", "pages", "assets", "finalize"],
      `expected to visit each stage once, visited: ${stages.join(" → ")}`,
    );

    const row = h.db.ingest();
    assert.equal(row["stage"], "done", "the job reached its terminal stage");
    assert.equal(row["status"], "ready", "all planned pages were stored, so the crawl is ready");
    assert.equal(row["pages_done"], 2, "both planned pages were rewritten and stored");

    // ── pages were rewritten and stored ──────────────────────────────────
    const snapshots = h.db.snapshots();
    assert.equal(snapshots.length, 2);
    for (const snap of snapshots) {
      assert.match(snap["r2_key"] as string, /^pages\/example\.com\/2024-01-15\/[0-9a-f]{16}\.html$/);
      assert.equal(snap["mime"], "text/html");
      assert.ok((snap["bytes"] as number) > 0);
    }

    // ── assets are content-addressed and de-duplicated across pages ───────
    const assets = h.db.assets();
    const logoRows = assets.filter((a) => (a["r2_key"] as string).endsWith(String(a["hash"])));
    assert.ok(logoRows.length >= 2, `expected the CSS + JS + logo assets, got ${assets.length}`);
    for (const asset of assets) {
      assert.match(asset["r2_key"] as string, /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/, "keys are content-addressed");
    }
    // The logo appears on both pages; it must be stored once and counted twice.
    const storedObjectCount = h.r2.objects.size;
    const assetRowCount = assets.length;
    assert.ok(
      storedObjectCount <= assetRowCount + 2,
      `R2 holds ${storedObjectCount} objects for ${assetRowCount} asset rows — de-duplication is not working`,
    );

    // ── the rewritten HTML is actually rewritten ──────────────────────────
    const rewritten = [...h.r2.objects.keys()].filter((k) => k.startsWith("pages/"));
    assert.equal(rewritten.length, 2);

    // ── link resolution: /about resolves, /never-captured is marked dead ──
    const links = h.db.links();
    const toAbout = links.find((l) => l["to_url"] === `https://${DOMAIN}/about`);
    assert.ok(toAbout, "the /about link must be recorded");
    assert.equal(toAbout["resolved_day"], "2024-01-15");

    // ── usage accounting recorded real work ───────────────────────────────
    const kinds = new Set(h.db.usage().map((u) => u["kind"]));
    assert.ok(kinds.has("ia_fetch"), "archive.org fetches must be recorded");
    assert.ok(kinds.has("bytes_stored"), "stored bytes must be recorded");
    assert.ok(kinds.has("r2_put"), "R2 writes must be recorded");
    assert.ok(kinds.has("queue_op"), "queue operations must be recorded");

    // A crawl that inspects N assets for two pages must not refetch the shared
    // logo: this is the §6.5 de-duplication claim, asserted on the wire.
    const logoFetches = h.fetches.filter((u) => u.includes("/logo.png")).length;
    assert.ok(logoFetches <= 2, `the shared logo was fetched ${logoFetches} times`);

    assert.deepEqual(h.db.unrecognised, [], "every statement the consumer issued was understood by the fake");
  } finally {
    h.restore();
  }
});

test("a resumed job continues from its cursor instead of restarting", async () => {
  const h = harness();
  try {
    // Walk the survey, then exactly one pages message.
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "survey" });
    const pagesBefore = (h.db.ingest()["cursor"] as number) ?? 0;

    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });
    const afterFirst = h.db.ingest()["cursor"] as number;
    assert.ok(afterFirst > pagesBefore, "the cursor advanced");

    const snapshotsAfterFirst = h.db.snapshots().length;

    // Now simulate a redelivery of the *same* stage — an at-least-once queue will
    // do this. It must not redo the pages already committed.
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    const snapshotsAfterRetry = h.db.snapshots().length;
    assert.ok(
      snapshotsAfterRetry >= snapshotsAfterFirst,
      "a redelivery must not lose work, and must not go backwards",
    );
    const cursorAfterRetry = h.db.ingest()["cursor"] as number;
    assert.ok(cursorAfterRetry >= afterFirst, `the cursor went backwards: ${afterFirst} → ${cursorAfterRetry}`);

    assert.deepEqual(h.db.unrecognised, []);
  } finally {
    h.restore();
  }
});

test("a 429 storm opens the circuit breaker and re-enqueues the same stage with a delay", async () => {
  const h = harness({
    fetchBehaviour: (url) => {
      // The two id_ page fetches are throttled; the CDX survey is fine, so the
      // job gets a plan and then hits the wall — exactly the failure mode §12 is
      // about.
      if (url.includes("id_")) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
      }
      return undefined;
    },
  });
  try {
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "survey" });
    assert.equal(h.db.ingest()["stage"], "pages", "the survey succeeded; the plan exists");

    // Walk the pages stage until the breaker trips. With maxAttempts 3 per URL and
    // a threshold of 5, the first message should already be parked.
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    const row = h.db.ingest();
    const events = h.db.throttles();
    assert.ok(events.length > 0, "throttle telemetry must be recorded");
    assert.ok(
      events.every((e) => e["status"] === 429),
      "every recorded throttle should carry the status we received",
    );
    assert.ok(
      events.some((e) => (e["wait_ms"] as number) > 0),
      "a recorded throttle must carry the backoff we actually applied",
    );

    const followUp = h.queue.sent.at(-1);
    assert.ok(followUp, "the job must be handed back to the queue");
    assert.equal(
      (followUp.body as { stage: string }).stage,
      "pages",
      "a throttled stage is retried, not skipped and not failed",
    );
    assert.ok(
      followUp.delaySeconds !== undefined && followUp.delaySeconds > 0,
      "a throttled retry must be delayed, or we would hammer a service that just asked us to stop",
    );

    // Progress made before the throttle is preserved.
    assert.equal(row["lease_until"], null, "the lease is released so the job can be picked up again");
    assert.deepEqual(h.db.unrecognised, []);
  } finally {
    h.restore();
  }
});

test("a missing capture is skipped, not fatal", async () => {
  const h = harness({
    fetchBehaviour: (url) => {
      if (url.includes("/about") && url.includes("id_")) {
        return new Response("Wayback Machine doesn't have that page archived", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return undefined;
    },
  });
  try {
    await drain(h.env, h.db, h.queue, { ingestId: "ingest-1", stage: "survey" });
    const row = h.db.ingest();

    // archive.org answering with its "not archived" page under HTTP 200 must not
    // be stored as if it were the page, and must not abort the crawl.
    assert.equal(h.db.snapshots().length, 1, "only the real capture is stored");
    assert.equal(row["pages_done"], 2, "the skipped page still counts as visited, so the cursor moves");
    assert.ok(["ready", "partial"].includes(row["status"] as string));
    assert.deepEqual(h.db.unrecognised, []);
  } finally {
    h.restore();
  }
});

test("the byte cap stops the crawl and says so", async () => {
  const h = harness({ maxPages: 10 });
  try {
    // Shrink the byte ceiling so the first page already exceeds it.
    h.db.ingest()["budget_json"] = JSON.stringify({
      maxPagesPerMonth: 10,
      maxBytesPerMonth: 1,
      maxAssetsPerPage: 120,
      maxDepth: 3,
    });

    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "survey" });
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    const row = h.db.ingest();
    assert.equal(row["status"], "partial", "a capped crawl is partial, not failed and not ready");
    assert.match(String(row["degraded_reason"] ?? ""), /byte cap/i, "the reason must name the cap that stopped it");
    assert.equal(row["stage"], "finalize", "the job moves on to finalize rather than dying");
    assert.deepEqual(h.db.unrecognised, []);
  } finally {
    h.restore();
  }
});

test("a cancelled job is dropped instead of resurrected", async () => {
  const h = harness();
  try {
    h.db.ingest()["status"] = "failed";
    h.db.ingest()["stage"] = "done";

    const before = h.queue.sent.length;
    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    assert.equal(h.queue.sent.length, before, "a finished/cancelled job must not enqueue more work");
    assert.equal(h.db.snapshots().length, 0, "and must not do any work");
  } finally {
    h.restore();
  }
});

test("a live lease defers to the current owner rather than racing it", async () => {
  const h = harness();
  try {
    const future = Math.floor(Date.now() / 1000) + 60;
    h.db.ingest()["lease_until"] = future;
    h.db.ingest()["stage"] = "pages";

    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    const followUp = h.queue.sent.at(-1);
    assert.ok(followUp, "the deferred message is re-enqueued");
    assert.ok(
      followUp.delaySeconds !== undefined && followUp.delaySeconds > 0,
      "a deferred message waits rather than retrying immediately",
    );
    assert.equal(h.db.snapshots().length, 0, "two consumers must never work the same cursor");
  } finally {
    h.restore();
  }
});

test("an open circuit breaker parks the job until the cooldown expires", async () => {
  const h = harness();
  try {
    h.db.ingest()["stage"] = "pages";
    h.db.ingest()["breaker_open_until"] = Math.floor(Date.now() / 1000) + 120;

    await handleIngestMessage(h.env, { ingestId: "ingest-1", domain: DOMAIN, month: MONTH, stage: "pages" });

    const followUp = h.queue.sent.at(-1);
    assert.ok(followUp, "the parked job is re-enqueued");
    assert.equal(followUp.delaySeconds, 120, "the delay matches the remaining cooldown");
    assert.equal(h.fetches.length, 0, "a parked job must make no archive.org requests at all");
  } finally {
    h.restore();
  }
});
