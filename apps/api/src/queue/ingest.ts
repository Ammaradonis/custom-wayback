/**
 * Cloud ingest: the queue consumer.
 *
 * This is the Phase 4 heart. One queue message carries exactly one bounded
 * stage of one (domain, month) job, so:
 *
 *   - **Resumable.** Progress is a cursor in `ingests`, not a local variable.
 *     A message that dies mid-batch is retried and continues from the cursor.
 *   - **Bounded.** `PAGES_PER_MESSAGE` / `ASSETS_PER_MESSAGE` / `maxRequests`
 *     cap what one invocation can do, so no single archived page can burn the
 *     CPU allotment or the wall clock.
 *   - **Polite.** every archive.org request goes through `CloudFetcher`; a 429
 *     streak opens the circuit breaker and re-enqueues the *same* stage after a
 *     cooldown, which is why a 429 storm costs time instead of losing work.
 *   - **Idempotent.** R2 keys are derived from content and URL, D1 writes are
 *     `INSERT OR REPLACE` on natural keys, and `usage_ledger` increments are
 *     guarded by the cursor, so at-least-once delivery cannot double-count.
 *
 * Stage graph:  survey → pages → pages → … → assets → assets → … → finalize
 */

import { parseHTML } from "linkedom/worker";
import type { Env } from "../env.js";
import { CloudFetcher, BudgetExhausted, looksLikeWaybackError, recordThrottle } from "./fetch.js";
import { rewriteHtml, extractReferences, assetPath, type PageRewriteResult } from "./rewrite.js";
import {
  buildIdUrl,
  buildSurveyUrl,
  extractIndexableText,
  extractTitle,
  hashString,
  htmlSurvey,
  parseCdxJson,
  selectPages as pipelineSelectPages,
  type CdxRow,
} from "@custom-wayback/pipeline";
import {
  ASSETS_PER_MESSAGE,
  CIRCUIT_BREAKER_THRESHOLD,
  LEASE_SECONDS,
  MAX_QUEUE_ATTEMPTS,
  PAGES_PER_MESSAGE,
  type IngestQueueMessage,
} from "@custom-wayback/shared";

// ── Local helpers ────────────────────────────────────────────────────────────

/**
 * Coerce a counter read back from D1 into a number.
 *
 * D1 does not guarantee a JS number for an INTEGER column in every result shape,
 * and a numeric string breaks `+` silently rather than loudly: `"0" + 2` is
 * `"02"`, which is truthy, non-zero, and completely wrong. Every counter that
 * feeds arithmetic goes through here.
 */
function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Time-sortable id for link-resolution rows, in the same ULID format the rest of
 * the schema uses.
 *
 * Inlined rather than imported so this module is self-contained and can be
 * executed directly by the test runner. Every relative import here is a module
 * the ingest path genuinely needs; a formatting helper is not one of them.
 */
const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  let time = Date.now();
  let timeChars = "";
  for (let i = 9; i >= 0; i--) {
    timeChars = (ULID_ENCODING[time % 32] ?? "0") + timeChars;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let randomChars = "";
  let bitsLeft = 0;
  let buffer = 0;
  let byteIdx = 0;
  for (let i = 0; i < 16; i++) {
    if (bitsLeft < 5) {
      buffer = (buffer << 8) | (bytes[byteIdx++] ?? 0);
      bitsLeft += 8;
    }
    bitsLeft -= 5;
    randomChars += ULID_ENCODING[(buffer >> bitsLeft) & 0x1f] ?? "0";
  }
  return timeChars + randomChars;
}

/**
 * Content hash of asset bytes — the key that makes storage cheap.
 *
 * `crypto.subtle` is the only digest available in Workers, and it is async; that
 * is why the call sites await it rather than hashing inline. It is also the
 * correct hash: bytes, not URLs, so the same logo referenced by 300 pages is
 * stored once (plan.md §3.1).
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SelectedPage mirrors the pipeline's shape; kept as a local alias for clarity. */
interface SelectedPage {
  url: string;
  ts: string;
  day: string;
  mime: string;
  bytes: number;
  digest: string | null;
}

interface AssetRef {
  url: string;
  ts: string;
}

interface StageOutcome {
  /** Next stage to run, or null when the job is finished. */
  next: IngestQueueMessage["stage"] | null;
  status: string;
  /** When the breaker is open, the caller should delay rather than retry immediately. */
  delaySeconds?: number;
  note?: string;
}

// ── Shared pipeline ──────────────────────────────────────────────────────────
//
// CDX parsing and capture selection are NOT implemented here. They live in
// `@custom-wayback/pipeline`, the same module the local Node runner uses, so the
// cloud and local paths cannot drift into choosing different captures for the
// same CDX rows. The package is runtime-agnostic by construction (see its
// `index.ts`): no Node builtins, no DOM, no filesystem.

/**
 * Pick one capture per (url, day) — the "single clean snapshot a day" policy
 * (plan.md §6.2) — then trim to this job's page budget.
 *
 * The trim is the caller's job rather than the selector's because the budget is a
 * *crawl* decision: it is frozen into `indests.pages_json` once, so every retry of
 * every later stage works from the identical plan.
 */
export function selectPages(rows: CdxRow[], seedUrl: string, maxPages: number): SelectedPage[] {
  const { pages } = pipelineSelectPages(rows, "perday", seedUrl);
  return pages.slice(0, Math.max(1, maxPages));
}

// ── Ledger access ────────────────────────────────────────────────────────────

/**
 * The bindings the consumer needs. Narrower than `Env` so tests can supply a
 * faithful fake without standing up Miniflare — the module never reaches for
 * anything outside this list, and that is the contract worth enforcing.
 */
export type IngestTestEnv = Pick<
  Env,
  | "DB"
  | "STORAGE"
  | "INGEST_QUEUE"
  | "DLQ_QUEUE"
  | "COVERAGE_KV"
  | "ASSETS"
  | "JWT_SECRET"
  | "STORAGE_ACCESS_KEY_ID"
  | "STORAGE_SECRET_ACCESS_KEY"
  | "STORAGE_ENDPOINT"
  | "STORAGE_BUCKET_NAME"
  | "CRAWLER_USER_AGENT"
  | "MAX_PAGES_PER_MONTH"
  | "SNAPSHOT_BEHAVIOR"
  | "PURGE_GRACE_SECONDS"
  | "CRAWL_QUOTA_PER_DAY"
  | "MONTHLY_BUDGET_USD"
>;

interface IngestRow {
  id: string;
  domain_id: string;
  month: string;
  status: string;
  stage: string | null;
  cursor: number;
  asset_cursor: number;
  pages_json: string | null;
  assets_json: string | null;
  pages_total: number;
  pages_done: number;
  assets_total: number;
  assets_done: number;
  bytes_stored: number;
  budget_json: string | null;
  ia_429_count: number;
  consecutive_429: number;
  breaker_open_until: number | null;
  lease_until: number | null;
  attempts: number;
  stage_attempts: number;
  day_index_json: string | null;
}

/**
 * The two statements that put one page into the search index.
 *
 * Both are needed because `snapshot_fts` is an FTS5 virtual table with no unique
 * constraint to upsert against, and `search_docs` is the ordinary table that
 * carries the bookkeeping. The delete is what makes a re-ingest replace rather
 * than duplicate: without it, crawling the same page twice would return it twice
 * in every search result forever.
 *
 * Returns an empty array — rather than throwing — when the page yielded no
 * indexable text, which is normal for a redirect stub or a JS-only shell.
 */
function indexStatements(
  env: Env,
  doc: {
    snapshotId: string;
    domain: string;
    url: string;
    day: string;
    ts: string;
    html: string;
    bytes: number;
  },
): D1PreparedStatement[] {
  const text = extractIndexableText(doc.html);
  if (text.length === 0) return [];
  const title = extractTitle(doc.html);
  const now = Math.floor(Date.now() / 1000);

  return [
    env.DB.prepare(`DELETE FROM snapshot_fts WHERE doc_id = ?`).bind(doc.snapshotId),
    env.DB.prepare(
      `INSERT INTO snapshot_fts (doc_id, url, title, text, domain, day, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(doc.snapshotId, doc.url, title ?? "", text, doc.domain, doc.day, doc.ts),
    env.DB.prepare(
      `INSERT OR REPLACE INTO search_docs (snapshot_id, domain, url, day, title, bytes, indexed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(doc.snapshotId, doc.domain, doc.url, doc.day, title, doc.bytes, now),
  ];
}

/**
 * One of the stage runners. Each takes the same arguments so the dispatcher can
 * treat them uniformly, and each returns what to do next rather than doing it —
 * which is what keeps a stage replayable.
 */
type StageRunner = (
  env: Env,
  msg: IngestQueueMessage,
  row: IngestRow,
  fetcher: CloudFetcher,
  usage: UsageBatch,
) => Promise<StageOutcome>;

async function loadIngest(env: Env, ingestId: string): Promise<IngestRow | null> {
  return env.DB.prepare(
    `SELECT i.id, i.domain_id, i.month, i.status, i.stage, i.cursor, i.asset_cursor,
            i.pages_json, i.assets_json, i.day_index_json, i.pages_total, i.pages_done,
            i.assets_total, i.assets_done, i.bytes_stored, i.budget_json,
            i.ia_429_count, i.consecutive_429, i.breaker_open_until, i.lease_until,
            i.attempts, i.stage_attempts
     FROM ingests i WHERE i.id = ?`,
  )
    .bind(ingestId)
    .first<IngestRow>();
}

function budgetOf(row: IngestRow): { maxPagesPerMonth: number; maxBytesPerMonth: number; maxAssetsPerPage: number; maxDepth: number } {
  const fallback = { maxPagesPerMonth: 1000, maxBytesPerMonth: 750 * 1024 * 1024, maxAssetsPerPage: 120, maxDepth: 3 };
  if (!row.budget_json) return fallback;
  try {
    const parsed = JSON.parse(row.budget_json) as Partial<typeof fallback>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/**
 * Batched usage rows: one D1 write per flush instead of one per event.
 *
 * No constructor parameter properties anywhere in this file. The tests run the
 * source under Node's strip-only TypeScript mode, which rejects that syntax — and
 * a module that cannot be executed by the test runner is a module that only gets
 * tested through the network. Same discipline as `apps/crawler-local`.
 */
class UsageBatch {
  private readonly stmts: D1PreparedStatement[] = [];
  private readonly env: Env;
  private readonly domain: string;
  private readonly month: string;

  constructor(env: Env, domain: string, month: string) {
    this.env = env;
    this.domain = domain;
    this.month = month;
  }

  add(kind: string, value: number): void {
    if (value === 0) return;
    this.stmts.push(
      this.env.DB.prepare(
        `INSERT INTO usage_ledger (domain, month, kind, value, recorded_at) VALUES (?,?,?,?,?)`,
      ).bind(this.domain, this.month, kind, value, Math.floor(Date.now() / 1000)),
    );
  }

  get size(): number {
    return this.stmts.length;
  }

  async flush(): Promise<void> {
    if (this.stmts.length === 0) return;
    try {
      await this.env.DB.batch(this.stmts);
    } catch {
      // Accounting must never fail a crawl.
    }
    this.stmts.length = 0;
  }
}

// ── Stage: survey ────────────────────────────────────────────────────────────

async function runSurvey(
  env: Env,
  msg: IngestQueueMessage,
  row: IngestRow,
  fetcher: CloudFetcher,
  usage: UsageBatch,
): Promise<StageOutcome> {
  const [year, mon] = msg.month.split("-") as [string, string];
  const from = `${year}${mon}01`;
  const lastDay = new Date(Number(year), Number(mon), 0).getDate();
  const to = `${year}${mon}${String(lastDay).padStart(2, "0")}`;

  await env.DB.prepare(`UPDATE ingests SET status = 'surveying', stage = 'survey' WHERE id = ?`)
    .bind(msg.ingestId)
    .run();

  const budget = budgetOf(row);
  // The survey row cap is deliberately larger than the page budget: selection
  // happens locally and costs archive.org nothing, while a second CDX query does.
  //
  // Note what is NOT in this query: `collapse` and `showResumeKey`. Both force a
  // full index scan and are the documented reason a domain+month CDX query hangs
  // until it 504s. Day bucketing happens client-side in the pipeline instead,
  // which costs archive.org nothing. See `packages/pipeline/src/wayback.ts` for
  // the measured evidence behind that choice.
  const cdxLimit = Math.min(5000, Math.max(200, budget.maxPagesPerMonth * 4));
  const url = buildSurveyUrl(htmlSurvey(msg.domain, from, to, cdxLimit));

  const outcome = await fetcher.fetch(url, {
    accept: "application/json,text/plain,*/*",
    // The CDX index is the one endpoint that legitimately takes tens of seconds.
    // The pipeline's measured table (packages/pipeline/src/wayback.ts) records
    // domain+month range queries returning at ~10–25 s and hanging to 60 s+ when
    // they are going to fail. A 20 s timeout therefore fails queries that would
    // have succeeded, which is what the first smoke-test run showed. 45 s sits
    // inside the plan's "seconds to low minutes" promise and still fails fast
    // enough that a dead survey does not stall the job.
    timeoutMs: 45_000,
  });
  usage.add("ia_fetch", 1);

  if (outcome.kind === "throttled") {
    return {
      next: "survey",
      status: "queued",
      delaySeconds: Math.ceil(outcome.waitMs / 1000),
      note: `archive.org is throttling us — resuming in ${Math.ceil(outcome.waitMs / 1000)}s`,
    };
  }
  if (outcome.kind !== "ok") {
    // A failed survey is not fatal: the job degrades to a seed-page-only crawl
    // rather than reporting "failed" for something archive.org did.
    const reason = outcome.kind === "error" ? outcome.message : `HTTP ${outcome.status}`;
    await env.DB.prepare(
      `UPDATE ingests SET degraded_reason = ?, status = 'fetching', stage = 'pages',
         pages_json = '[]', pages_total = 0, cursor = 0 WHERE id = ?`,
    )
      .bind(`CDX survey unavailable (${reason}); crawled nothing new`, msg.ingestId)
      .run();
    return { next: "finalize", status: "fetching", note: `CDX survey failed: ${reason}` };
  }

  const parsed = parseCdxJson(new TextDecoder().decode(outcome.body));
  if (parsed.error) {
    await env.DB.prepare(
      `UPDATE ingests SET degraded_reason = ?, status = 'fetching', stage = 'pages',
         pages_json = '[]', pages_total = 0, cursor = 0 WHERE id = ?`,
    )
      .bind(`CDX survey returned an error: ${parsed.error.slice(0, 200)}`, msg.ingestId)
      .run();
    return { next: "finalize", status: "fetching", note: `CDX survey error: ${parsed.error.slice(0, 120)}` };
  }

  const seed = `https://${msg.domain}/`;
  const selected = selectPages(parsed.rows, seed, budget.maxPagesPerMonth);

  // The work plan is frozen here, once. A retry of any later stage re-reads it,
  // so the crawl cannot change shape between attempts.
  //
  // `dayIndex` is url → { day → ts } for every selected page: it is what the
  // pages stage uses to resolve an internal link to a day we can actually serve,
  // and keeping it here means navigation resolution costs zero extra queries.
  const dayIndex: Record<string, Record<string, string>> = {};
  for (const page of selected) {
    const entry = dayIndex[page.url] ?? (dayIndex[page.url] = {});
    entry[page.day] = page.ts;
  }

  await env.DB.prepare(
    `UPDATE ingests SET status = 'fetching', stage = 'pages', pages_json = ?, day_index_json = ?,
       pages_total = ?, cursor = 0, asset_cursor = 0, degraded_reason = NULL WHERE id = ?`,
  )
    .bind(JSON.stringify(selected), JSON.stringify(dayIndex), selected.length, msg.ingestId)
    .run();

  return {
    next: selected.length > 0 ? "pages" : "finalize",
    status: "fetching",
    note: `${parsed.rows.length} CDX rows → ${selected.length} pages selected`,
  };
}

// ── Stage: pages ─────────────────────────────────────────────────────────────

async function runPages(
  env: Env,
  msg: IngestQueueMessage,
  row: IngestRow,
  fetcher: CloudFetcher,
  usage: UsageBatch,
): Promise<StageOutcome> {
  const budget = budgetOf(row);
  const pages: SelectedPage[] = row.pages_json ? (JSON.parse(row.pages_json) as SelectedPage[]) : [];
  const dayIndex: Record<string, Record<string, string>> = row.day_index_json
    ? (JSON.parse(row.day_index_json) as Record<string, Record<string, string>>)
    : {};

  // Coerced, not trusted. D1 hands back a numeric column as a string in some
  // result shapes, and `cursor + PAGES_PER_MESSAGE` on the string "0" produces
  // "02" — after which `slice("02", "022")` silently returns an empty batch, the
  // cursor never advances, and the job burns through its delivery ceiling having
  // crawled nothing. The symptom is a crawl that "completes" with zero pages, so
  // it is worth one Number() call to make the arithmetic total.
  const cursor = toCount(row.cursor);
  const batch = pages.slice(cursor, cursor + PAGES_PER_MESSAGE);

  if (batch.length === 0) return { next: "assets", status: "rewriting" };

  const assetIndex: AssetRef[] = row.assets_json ? (JSON.parse(row.assets_json) as AssetRef[]) : [];
  const knownAssets = new Set(assetIndex.map((a) => a.url));

  // original asset URL → our content-addressed route, for every asset this
  // invocation has already placed. Seeding it empty each time is correct: the
  // reference is re-derived from the bytes, and the bytes are already in R2 and
  // in the `assets` table, so a re-derivation costs one R2 read at most.
  const resolvedAssets = new Map<string, string>();

  let done = toCount(row.pages_done);
  let bytesStored = toCount(row.bytes_stored);

  for (const page of batch) {
    if (bytesStored >= budget.maxBytesPerMonth) {
      await env.DB.prepare(
        `UPDATE ingests SET degraded_reason = ?, status = 'partial', stage = 'finalize',
           cursor = ?, pages_done = ?, bytes_stored = ? WHERE id = ?`,
      )
        .bind("monthly byte cap reached — remaining pages are on-demand", cursor, done, bytesStored, msg.ingestId)
        .run();
      return { next: "finalize", status: "partial", note: "byte cap reached" };
    }

    // ---- 1. The page's own bytes, via id_ raw replay ---------------------
    let pageOutcome;
    try {
      pageOutcome = await fetcher.fetch(buildIdUrl(page.ts, page.url));
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      done += 1;
      continue;
    }
    usage.add("ia_fetch", 1);

    if (pageOutcome.kind === "throttled") {
      await persistPageProgress(env, msg.ingestId, cursor, done, bytesStored, assetIndex);
      const secs = Math.ceil(pageOutcome.waitMs / 1000);
      return {
        next: "pages",
        status: "fetching",
        delaySeconds: secs,
        note: `archive.org is throttling us — resuming in ${secs}s`,
      };
    }
    if (pageOutcome.kind !== "ok" || looksLikeWaybackError(pageOutcome.body, pageOutcome.contentType)) {
      // A capture that 404s or returns an archive.org error page is data, not an
      // exception: skip it and keep the crawl going.
      done += 1;
      continue;
    }

    const rawHtml = new TextDecoder("utf-8").decode(pageOutcome.body);
    const { document } = parseHTML(rawHtml);
    const refs = extractReferences(document, page.url);

    // ---- 2. Fetch this page's assets so the rewrite can be complete -------
    // A bounded slice per page: beyond the budget you are pulling ad and tracker
    // soup nobody wants (§6.3 MAX_ASSETS_PER_PAGE).
    const wanted = refs.assets.slice(0, budget.maxAssetsPerPage);
    const assetMap = new Map<string, string>();

    for (const assetUrl of wanted) {
      // Two layers of de-duplication before spending a request:
      //   1. `assetIndex` — every asset reference already collected for this job,
      //      each carrying the capture timestamp it was first seen at. A URL in
      //      here has already been fetched (or queued) once; refetching it per
      //      page is the difference between hundreds and tens of thousands of
      //      requests on an image-heavy site (§3.1, §6.5).
      //   2. `assetMap` — within this page, so the same URL referenced by two
      //      attributes is looked at once.
      const known = resolvedAssets.get(assetUrl);
      if (known) {
        assetMap.set(assetUrl, known);
        continue;
      }

      let assetOutcome;
      try {
        assetOutcome = await fetcher.fetch(buildIdUrl(page.ts, assetUrl));
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          // Out of request budget: commit what we have and resume this page
          // later. The cursor does not advance, so nothing is lost.
          await persistPageProgress(env, msg.ingestId, cursor, done, bytesStored, assetIndex);
          throw err;
        }
        continue;
      }
      usage.add("ia_fetch", 1);
      if (assetOutcome.kind === "throttled") {
        await persistPageProgress(env, msg.ingestId, cursor, done, bytesStored, assetIndex);
        const secs = Math.ceil(assetOutcome.waitMs / 1000);
        return {
          next: "pages",
          status: "fetching",
          delaySeconds: secs,
          note: `archive.org is throttling us — resuming in ${secs}s`,
        };
      }
      if (assetOutcome.kind !== "ok") continue;

      const hash = await sha256Hex(assetOutcome.body);
      const key = `assets/${hash.slice(0, 2)}/${hash}`;
      // Content-addressed: the same bytes referenced by another page, another
      // month, or another domain cost nothing extra to store. Only the ref_count
      // moves, which is why this lookup earns its keep.
      const exists = await env.DB.prepare(`SELECT hash FROM assets WHERE hash = ?`)
        .bind(hash)
        .first<{ hash: string }>();
      if (exists) {
        await env.DB.prepare(`UPDATE assets SET ref_count = ref_count + 1 WHERE hash = ?`).bind(hash).run();
      } else {
        await env.STORAGE.put(key, assetOutcome.body, {
          httpMetadata: { contentType: assetOutcome.contentType },
          customMetadata: { cacheControl: "public, max-age=31536000, immutable" },
        });
        usage.add("r2_put", 1);
        usage.add("bytes_stored", assetOutcome.body.byteLength);
        bytesStored += assetOutcome.body.byteLength;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count)
           VALUES (?,?,?,?,?,1)`,
        )
          .bind(hash, assetOutcome.contentType, assetOutcome.body.byteLength, key, Math.floor(Date.now() / 1000))
          .run();
      }

      const route = assetPath(hash);
      resolvedAssets.set(assetUrl, route);
      assetMap.set(assetUrl, route);
      // Queue every asset the rewrite could not place. The follow-up stage walks
      // this index with a larger per-message budget, so a page whose assets
      // outran the request budget is still completed.
      if (!knownAssets.has(assetUrl)) {
        knownAssets.add(assetUrl);
        assetIndex.push({ url: assetUrl, ts: page.ts });
      }
    }

    // ---- 3. Link resolution ----------------------------------------------
    // Resolve every in-site link to the nearest day the plan actually contains,
    // so a click never lands on a dead end (§6.4 "temporal resolution").
    const linkMap = new Map<string, { day: string; deltaDays: number }>();
    for (const link of refs.links) {
      const days = dayIndex[link];
      if (!days) continue;
      const resolved = resolveNearestDay(Object.keys(days), page.day);
      if (resolved) linkMap.set(link, resolved);
    }

    // ---- 4. Rewrite once, store bytes ------------------------------------
    let rewritten: PageRewriteResult;
    try {
      rewritten = rewriteHtml(document, {
        domain: msg.domain,
        day: page.day,
        pageUrl: page.url,
        assetMap,
        linkMap,
      });
    } catch (err) {
      console.error(`[ingest] rewrite failed for ${page.url}: ${err instanceof Error ? err.message : err}`);
      done += 1;
      continue;
    }

    const htmlBytes = new TextEncoder().encode(rewritten.html);
    const uhash = hashString(page.url);
    const r2Key = `pages/${msg.domain}/${page.day}/${uhash}.html`;
    await env.STORAGE.put(r2Key, htmlBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    usage.add("r2_put", 1);
    usage.add("bytes_stored", htmlBytes.byteLength);
    bytesStored += htmlBytes.byteLength;

    const snapshotId = (await sha256Hex(new TextEncoder().encode(`${msg.domain}|${page.url}|${page.day}`))).slice(0, 32);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO snapshots
         (id, ingest_id, domain, url, day, ts, status_code, mime, digest, bytes, r2_key, page_id,
          served_at, purged_at, resolved_day, resolved_ts, delta_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, NULL, NULL, ?, ?, 0)`,
    )
      .bind(
        snapshotId,
        msg.ingestId,
        msg.domain,
        page.url,
        page.day,
        page.ts,
        200,
        "text/html",
        page.digest,
        htmlBytes.byteLength,
        r2Key,
        `${msg.domain}/${page.day}/${uhash}`,
        page.day,
        page.ts,
      )
      .run();

    // ── Index the page for search (plan.md §15) ─────────────────────────────
    //
    // Extracted here, once, while the bytes are in hand — never read back out of
    // R2 later. The post-serve purge job deletes page blobs by design, so a search
    // that fetched bodies from R2 would silently lose every page the user had
    // already visited. The index is the durable copy of the text.
    const searchStmts = indexStatements(env, {
      snapshotId,
      domain: msg.domain,
      url: page.url,
      day: page.day,
      ts: page.ts,
      html: rewritten.html,
      bytes: htmlBytes.byteLength,
    });
    if (searchStmts.length > 0) {
      usage.add("d1_write", searchStmts.length);
      try {
        await env.DB.batch(searchStmts);
      } catch (err) {
        // Search is a feature, not the product. A page that fails to index must
        // still be browsable, so this is logged and swallowed rather than
        // failing the crawl — but it is never silent.
        console.error(
          `[ingest] search index failed for ${page.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (rewritten.internalLinks.length > 0) {
      const linkStmts = rewritten.internalLinks.slice(0, 200).map((link) => {
        const resolved = linkMap.get(link);
        return env.DB.prepare(
          `INSERT OR IGNORE INTO link_resolutions
             (id, domain, day, from_url, to_url, kind, resolved_day, resolved_ts, delta_days)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).bind(
          `${snapshotId}${hashString(link)}`.slice(0, 32),
          msg.domain,
          page.day,
          page.url,
          link,
          "internal",
          resolved?.day ?? null,
          resolved ? (dayIndex[link]?.[resolved.day] ?? null) : null,
          resolved?.deltaDays ?? null,
        );
      });
      try {
        await env.DB.batch(linkStmts);
      } catch {
        // Link rows are a navigation nicety; never fail a page over them.
      }
    }

    done += 1;
  }

  const nextCursor = cursor + batch.length;
  await persistPageProgress(env, msg.ingestId, nextCursor, done, bytesStored, assetIndex);
  usage.add("queue_op", 1);

  const hasMore = nextCursor < pages.length;
  return {
    next: hasMore ? "pages" : "assets",
    status: hasMore ? "fetching" : "rewriting",
    ...(hasMore ? {} : { note: `${done} pages rewritten` }),
  };
}

/**
 * Nearest day in `days` to `fromDay`. Same policy as the local runner's
 * `resolveLink`: closest wins, earlier breaks a tie (so a page never silently
 * shows a *later* version when an earlier one was available).
 */
function resolveNearestDay(
  days: string[],
  fromDay: string,
  toleranceDays = 31,
): { day: string; deltaDays: number } | undefined {
  if (days.includes(fromDay)) return { day: fromDay, deltaDays: 0 };
  let best: { day: string; deltaDays: number } | undefined;
  for (const day of days) {
    const delta = daysBetween(fromDay, day);
    if (Math.abs(delta) > toleranceDays) continue;
    if (
      !best ||
      Math.abs(delta) < Math.abs(best.deltaDays) ||
      (Math.abs(delta) === Math.abs(best.deltaDays) && delta < best.deltaDays)
    ) {
      best = { day, deltaDays: delta };
    }
  }
  return best;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

async function persistPageProgress(
  env: Env,
  ingestId: string,
  cursor: number,
  pagesDone: number,
  bytesStored: number,
  assetIndex: AssetRef[],
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ingests SET cursor = ?, pages_done = ?, bytes_stored = ?,
       assets_json = ?, assets_total = ? WHERE id = ?`,
  )
    .bind(cursor, pagesDone, bytesStored, JSON.stringify(assetIndex), assetIndex.length, ingestId)
    .run();
}

// ── Stage: assets ────────────────────────────────────────────────────────────

async function runAssets(
  env: Env,
  msg: IngestQueueMessage,
  row: IngestRow,
  fetcher: CloudFetcher,
  usage: UsageBatch,
): Promise<StageOutcome> {
  const assets: AssetRef[] = row.assets_json ? (JSON.parse(row.assets_json) as AssetRef[]) : [];
  const cursor = toCount(row.asset_cursor);
  const batch = assets.slice(cursor, cursor + ASSETS_PER_MESSAGE);

  if (batch.length === 0) {
    return { next: "finalize", status: "ready" };
  }

  let done = toCount(row.assets_done);
  let bytesStored = toCount(row.bytes_stored);

  for (const asset of batch) {
    const outcome = await fetcher.fetch(buildIdUrl(asset.ts, asset.url));
    usage.add("ia_fetch", 1);

    if (outcome.kind === "throttled") {
      await persistAssetProgress(env, msg.ingestId, cursor, done, bytesStored);
      return {
        next: "assets",
        status: "rewriting",
        delaySeconds: Math.ceil(outcome.waitMs / 1000),
        note: `archive.org is throttling us — resuming in ${Math.ceil(outcome.waitMs / 1000)}s`,
      };
    }
    if (outcome.kind !== "ok") {
      done += 1;
      continue;
    }

    const hash = await sha256Hex(outcome.body);
    const key = `assets/${hash.slice(0, 2)}/${hash}`;

    // Content-addressed: if the bytes are already stored, the only cost is the
    // ref_count bump, which is why a 400-page crawl pulls hundreds of assets
    // rather than tens of thousands (§6.5).
    const existing = await env.DB.prepare(`SELECT hash FROM assets WHERE hash = ?`)
      .bind(hash)
      .first<{ hash: string }>();

    if (existing) {
      await env.DB.prepare(`UPDATE assets SET ref_count = ref_count + 1 WHERE hash = ?`).bind(hash).run();
    } else {
      await env.STORAGE.put(key, outcome.body, {
        httpMetadata: { contentType: outcome.contentType },
      });
      usage.add("r2_put", 1);
      usage.add("bytes_stored", outcome.body.byteLength);
      bytesStored += outcome.body.byteLength;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count)
         VALUES (?,?,?,?,?,1)`,
      )
        .bind(hash, outcome.contentType, outcome.body.byteLength, key, Math.floor(Date.now() / 1000))
        .run();
    }

    done += 1;
  }

  const nextCursor = cursor + batch.length;
  await persistAssetProgress(env, msg.ingestId, nextCursor, done, bytesStored);
  usage.add("queue_op", 1);

  const hasMore = nextCursor < assets.length;
  return { next: hasMore ? "assets" : "finalize", status: "rewriting" };
}

async function persistAssetProgress(
  env: Env,
  ingestId: string,
  assetCursor: number,
  assetsDone: number,
  bytesStored: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ingests SET asset_cursor = ?, assets_done = ?, bytes_stored = ? WHERE id = ?`,
  )
    .bind(assetCursor, assetsDone, bytesStored, ingestId)
    .run();
}

// ── Stage: finalize ──────────────────────────────────────────────────────────

async function runFinalize(env: Env, msg: IngestQueueMessage, row: IngestRow): Promise<StageOutcome> {
  const pages = row.pages_json ? (JSON.parse(row.pages_json) as SelectedPage[]) : [];
  // "partial" is honest: the byte cap, a failed survey, or a skipped capture all
  // mean we stored fewer pages than the plan asked for.
  const status = toCount(row.pages_done) >= pages.length && pages.length > 0 ? "ready" : pages.length === 0 ? "failed" : "partial";

  await env.DB.prepare(
    `UPDATE ingests SET status = ?, stage = 'done', finished_at = ?,
       lease_until = NULL, consecutive_429 = 0, breaker_open_until = NULL WHERE id = ?`,
  )
    .bind(status, Math.floor(Date.now() / 1000), msg.ingestId)
    .run();

  await env.DB.prepare(`UPDATE domains SET last_crawled_at = ? WHERE id = ?`)
    .bind(Math.floor(Date.now() / 1000), row.domain_id)
    .run();

  // The coverage bar is immutable history; refreshing it is one CDX probe. We
  // write it once at finalize rather than on every read (§4, KV for coarse caches).
  try {
    await env.COVERAGE_KV.delete(`coverage:${msg.domain}:${msg.month}`);
  } catch {
    // Cache invalidation is best-effort.
  }

  return { next: null, status };
}

// ── Consumer entry point ─────────────────────────────────────────────────────

/**
 * Handle one queue message.
 *
 * Returning normally acks the message. Throwing retries it (up to the queue's
 * `max_retries`, then the DLQ). We deliberately return *normally* for anything
 * that is archive.org's fault, and hand the retry to our own stage machine with
 * an explicit delay — a Queue retry would restart the stage immediately and
 * hammer a throttled service.
 */
export async function handleIngestMessage(env: Env, msg: IngestQueueMessage): Promise<void> {
  const row = await loadIngest(env, msg.ingestId);
  if (!row) {
    console.warn(`[ingest] unknown ingest ${msg.ingestId}; dropping message`);
    return;
  }

  // Cancelled or already finished: drop the message rather than resurrect it.
  if (["failed", "ready", "partial"].includes(row.status) && row.stage === "done") {
    return;
  }

  // A live lease means another consumer owns this job right now. Re-enqueue with
  // a short delay instead of racing it — two consumers on one cursor would
  // double-fetch and double-count.
  const now = Math.floor(Date.now() / 1000);
  if (row.lease_until && row.lease_until > now) {
    await env.INGEST_QUEUE.send({ ...msg, enqueuedAt: now }, { delaySeconds: 20 });
    return;
  }

  // Circuit breaker: the previous invocation found archive.org throttling us.
  if (row.breaker_open_until && row.breaker_open_until > now) {
    const wait = row.breaker_open_until - now;
    await env.INGEST_QUEUE.send({ ...msg, enqueuedAt: now }, { delaySeconds: Math.min(wait, 900) });
    console.log(`[ingest] ${msg.ingestId} circuit breaker open for another ${wait}s`);
    return;
  }

  // The durable row is the authority on which stage a job is in; the message is
  // only a nudge. A queue delivers at least once, so a duplicate or out-of-order
  // message for a stage the job has already finished can arrive at any time —
  // and if we acted on `msg.stage` we would re-run the old stage, send another
  // message for the same old stage, and spin forever without ever advancing the
  // cursor. Re-nudge on the job's actual stage instead.
  const stage: IngestQueueMessage["stage"] = (row.stage as IngestQueueMessage["stage"]) ?? "survey";

  if (row.stage !== null && msg.stage !== stage) {
    console.log(
      `[ingest] ${msg.ingestId}: stale message for stage '${msg.stage}' ` +
      `(job is at '${stage}'); re-driving the current stage`,
    );
    await env.INGEST_QUEUE.send({ ...msg, stage, enqueuedAt: now });
    return;
  }

  const attempts = toCount(row.attempts) + 1;

  // The stage counter resets when the stage advances. It is the one the delivery
  // ceiling uses, because a 250-page crawl legitimately takes ~125 messages and a
  // job-wide counter would park that healthy crawl as `partial` around page 24.
  const stageAttempts = stage === row.stage ? toCount(row.stage_attempts) + 1 : 1;

  await env.DB.prepare(
    `UPDATE ingests SET lease_until = ?, attempts = ?, stage = ?, stage_attempts = ? WHERE id = ?`,
  )
    .bind(now + LEASE_SECONDS, attempts, stage, stageAttempts, msg.ingestId)
    .run();

  const fetcher = new CloudFetcher(env.CRAWLER_USER_AGENT);
  // Seed the durable throttle state, so a job throttled in an earlier invocation
  // resumes at the right place in the backoff curve instead of starting over at
  // "one throttle" and retrying immediately.
  fetcher.seed({
    consecutive: row.consecutive_429,
    breakerOpenUntil: row.breaker_open_until,
  });
  const usage = new UsageBatch(env, msg.domain, msg.month);
  fetcher.onThrottle = (info) => {
    void recordThrottle(env, {
      domain: msg.domain,
      month: msg.month,
      ingestId: msg.ingestId,
      url: info.url,
      status: info.status,
      waitMs: info.waitMs,
      attempt: info.attempt,
      kind: "backoff",
      breakerOpen: false,
    });
  };

  let outcome: StageOutcome;
  try {
    if (stage === "survey") {
      outcome = await runSurvey(env, msg, row, fetcher, usage);
    } else if (stage === "pages") {
      outcome = await runPages(env, msg, row, fetcher, usage);
    } else if (stage === "assets") {
      outcome = await runAssets(env, msg, row, fetcher, usage);
    } else {
      outcome = await runFinalize(env, msg, row);
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      // Perfectly normal: we hit this invocation's request ceiling. Hand the
      // same stage straight back to the queue with no delay.
      console.log(`[ingest] ${msg.ingestId} ${stage}: ${err.message}`);
      await env.INGEST_QUEUE.send({ ...msg, stage, attempt: attempts, enqueuedAt: now });
      await usage.flush();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] ${msg.ingestId} ${stage} failed: ${message}`);
    // Persist the failure but let the queue retry: an unhandled throw here is a
    // bug or a transient platform fault, not archive.org's behaviour.
    await env.DB.prepare(
      `UPDATE ingests SET lease_until = NULL, error_message = ? WHERE id = ?`,
    )
      .bind(message.slice(0, 500), msg.ingestId)
      .run();
    await usage.flush();
    throw err;
  }

  usage.add("worker_request", 1);
  usage.add("queue_op", 1);

  // Persist the throttle streak and open the breaker if it is warranted. This is
  // the durable half of politeness: the next invocation — possibly in a different
  // isolate — reads it from D1 and behaves.
  const throttled = fetcher.throttled > 0;
  const breakNow = fetcher.shouldBreak;
  const breakerUntil = fetcher.ledger.breakerOpenUntil;
  // When the breaker trips, the policy resets the consecutive counter (the
  // cooldown *is* the backoff). Report the pre-trip streak in that case so the
  // UI's "N throttle responses so far" does not drop to zero at the worst moment.
  const consecutiveToPersist = breakNow
    ? Math.max(toCount(row.consecutive_429), CIRCUIT_BREAKER_THRESHOLD)
    : fetcher.consecutiveThrottles;

  await env.DB.prepare(
    `UPDATE ingests SET
       lease_until = NULL,
       status = ?,
       ia_429_count = ia_429_count + ?,
       consecutive_429 = ?,
       breaker_open_until = COALESCE(?, breaker_open_until),
       last_throttle_at = CASE WHEN ? > 0 THEN ? ELSE last_throttle_at END,
       error_message = CASE WHEN ? = 'failed' THEN COALESCE(error_message, 'no captures found in range') ELSE error_message END
     WHERE id = ?`,
  )
    .bind(
      outcome.status,
      fetcher.throttled,
      consecutiveToPersist,
      breakerUntil,
      fetcher.throttled,
      Math.floor(Date.now() / 1000),
      outcome.status,
      msg.ingestId,
    )
    .run();

  if (breakNow) {
    await recordThrottle(env, {
      domain: msg.domain,
      month: msg.month,
      ingestId: msg.ingestId,
      url: "https://web.archive.org/",
      status: 429,
      waitMs: fetcher.budget.breakerCooldownMs,
      attempt: attempts,
      kind: "breaker",
      breakerOpen: true,
    });
  }

  if (outcome.note) {
    console.log(`[ingest] ${msg.ingestId} ${stage}: ${outcome.note}`);
  }

  await usage.flush();

  if (outcome.next === null) return;

  // Delivery-attempt ceiling, per stage. The queue's own `max_retries` covers
  // thrown errors; this covers the self-re-enqueue path, which the queue cannot
  // see. It exists to stop a job that is genuinely stuck (a page that always
  // throttles, a survey that never returns) from spinning forever — not to cap
  // how many pages a healthy crawl may fetch.
  const stageCeiling = MAX_QUEUE_ATTEMPTS * Math.max(1, PAGES_PER_MESSAGE);
  if (stageAttempts >= stageCeiling) {
    console.warn(
      `[ingest] ${msg.ingestId} stage '${stage}' exceeded its ceiling ` +
      `(${stageAttempts} ≥ ${stageCeiling}); parking as partial`,
    );
    await env.DB.prepare(
      `UPDATE ingests SET status = 'partial', stage = 'done', finished_at = ?, lease_until = NULL,
         degraded_reason = COALESCE(degraded_reason, ?)
       WHERE id = ?`,
    )
      .bind(
        Math.floor(Date.now() / 1000),
        `stopped after ${stageAttempts} attempts at the '${stage}' stage`,
        msg.ingestId,
      )
      .run();
    return;
  }

  const delay = outcome.delaySeconds ?? (breakNow ? Math.ceil(fetcher.budget.breakerCooldownMs / 1000) : 0);

  // Advance the durable stage *before* sending the message that announces it.
  //
  // The row and the message must never disagree about which stage a job is in.
  // When they did, every consumer invocation correctly refused to act on the
  // message (the stale-message guard above) while the row still named the
  // finished stage — so the job ping-ponged between two stages and the cursor
  // never moved. Writing the destination first makes the transition atomic from
  // the consumer's point of view: by the time a message exists, its stage is
  // already the job's stage. A duplicate or reordered delivery is then a no-op
  // rather than a stall.
  //
  // The stage counter also resets here, which is what keeps the delivery ceiling
  // a per-stage bound rather than a cap on how much a healthy crawl may fetch.
  if (outcome.next !== stage) {
    await env.DB.prepare(
      `UPDATE ingests SET stage = ?, stage_attempts = 0 WHERE id = ?`,
    )
      .bind(outcome.next, msg.ingestId)
      .run();
  }

  await env.INGEST_QUEUE.send(
    { ...msg, stage: outcome.next, attempt: attempts, enqueuedAt: now },
    delay > 0 ? { delaySeconds: Math.min(delay, 900) } : undefined,
  );
}

/** Terminal handler for the dead-letter queue: record it, never silently drop it. */
export async function handleDeadLetter(env: Env, msg: IngestQueueMessage, reason: string): Promise<void> {
  console.error(`[ingest] dead-letter: ${msg.ingestId} (${msg.stage}) — ${reason}`);
  try {
    await env.DB.prepare(
      `UPDATE ingests SET status = 'failed', stage = 'done', lease_until = NULL,
         finished_at = ?, error_message = ?
       WHERE id = ? AND status NOT IN ('ready','partial')`,
    )
      .bind(Math.floor(Date.now() / 1000), `dead-lettered: ${reason}`.slice(0, 500), msg.ingestId)
      .run();
  } catch {
    // Nothing more we can do; the log line above is the record.
  }
}

/** Re-exported so tests and future call sites share one implementation. */
export { hashString, sha256Hex };
