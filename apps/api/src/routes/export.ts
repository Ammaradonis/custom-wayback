/**
 * Export a crawled month as a self-contained static bundle
 * (plan.md §15, "Snapshot export as a static ZIP").
 *
 *   POST   /v1/export                    — build a bundle for one (domain, month)
 *   GET    /v1/export/:id                — status and metadata
 *   GET    /v1/export/:id/download       — the bytes, as an attachment
 *   DELETE /v1/export/:id                — remove the artifact, keep the record
 *
 * The product sentence this implements: *"Hand a self-contained month of a site to
 * a colleague, or archive it yourself with no dependency on this tool."* Everything
 * about the design follows from the second half of that. A bundle is not a cache
 * of our viewer — it is a copy of the archive that has to keep working after this
 * Worker, this bucket and this account are gone, so:
 *
 *   - every internal link is rewritten to a file inside the zip, relative to the
 *     page that contains it (works from `file://`, from a subdirectory, forever);
 *   - `index.html` and `README.txt` are written by `lib/bundle.ts` with no script,
 *     no framework and no CDN — a browser from 1996 could render them;
 *   - attribution and a link back to the original capture are part of the format
 *     (plan.md §12 rule 7), not a nicety appended afterwards.
 *
 * ## Why this file is thin
 *
 * All the interesting decisions — entry names, relative paths, link rewriting,
 * CRC-32, the ZIP container, the README and the landing page — live in
 * `lib/bundle.ts` as pure functions over plain data, so they can be tested in
 * Node, where there is no R2 and no Worker. What is left here is I/O: two queries,
 * a join through `domains` for ownership, an R2 read per blob and one write. The
 * one DOM operation is link rewriting, which uses `HTMLRewriter` because that is
 * what the Workers runtime provides and because a month of archived pages is not
 * something to hold as parsed DOMs.
 *
 * ## Cost
 *
 * This is the most expensive thing a user can ask the API to do: it reads every
 * stored page and every referenced asset out of R2 and writes a bundle back. It
 * is therefore throttled on the `"jobs"` budget rather than the read budget, and
 * it is bounded by `MAX_BUNDLE_BYTES` — R2 storage is the largest line item in
 * plan.md §11, and an unbounded export is a bill with a progress bar.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env.js";
import {
  INDEX_ENTRY,
  README_ENTRY,
  buildIndexHtml,
  buildReadme,
  buildZipStream,
  collectAssetHashes,
  countMissing,
  dosTimestamp,
  pageEntryName,
  pageRewrites,
  platformDeflate,
  rewriteUrlsInText,
  rewriteValue,
  titleFromPrefix,
  utf8,
  type IndexPage,
  type PageLocation,
  type ZipEntry,
} from "../lib/bundle.js";
import { authenticateRequest } from "../lib/auth.js";
import { consumeRateLimit, userBucket } from "../lib/ratelimit.js";
import { ulid } from "../lib/ulid.js";

export const exportRouter = new Hono<{ Bindings: Env }>();

/**
 * Upper bound on one bundle, measured on the bytes read out of R2.
 *
 * A Worker has a fixed memory ceiling and `buildZipStream` holds one input blob
 * at a time, so this is a guard on the total rather than on any single read.
 * Refusing loudly beats building until the isolate dies: a 500 part-way through
 * tells the user nothing, while this message tells them the month is too large
 * for one request and what to do about it. `MAX_PAGES_PER_MONTH` keeps a normal
 * month well under this (§6.3).
 */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Auth ─────────────────────────────────────────────────────────────────────

exportRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

// ── Rows ─────────────────────────────────────────────────────────────────────

interface ExportRow {
  id: string;
  user_id: string;
  domain: string;
  month: string;
  r2_key: string;
  bytes: number;
  pages: number;
  assets: number;
  missing: number;
  status: string;
  error_message: string | null;
  created_at: number;
  finished_at: number | null;
}

interface PageRow {
  url: string;
  day: string;
  ts: string;
  r2_key: string;
  bytes: number | null;
  title: string | null;
}

type Ctx = Context<{ Bindings: Env }>;

/**
 * The caller's own export row, or nothing.
 *
 * Ownership is a filter in the statement (`user_id = ?`), not a check afterwards,
 * so there is exactly one place where "may this caller see this export?" is
 * decided and no way to forget it on a new route. `R2.N` naming would be nicer,
 * but the `exports` table is its own thing and every column is read explicitly so
 * a schema addition cannot silently change this shape.
 */
async function loadExport(c: Ctx, userId: string, id: string): Promise<ExportRow | null> {
  return c.env.DB.prepare(
    `SELECT id, user_id, domain, month, r2_key, bytes, pages, assets, missing,
            status, error_message, created_at, finished_at
     FROM exports
     WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<ExportRow>();
}

function exportJson(row: ExportRow): Record<string, unknown> {
  return {
    id: row.id,
    domain: row.domain,
    month: row.month,
    status: row.status,
    bytes: row.bytes,
    pages: row.pages,
    assets: row.assets,
    /**
     * Pages the bundle could NOT include because their stored blob had already
     * been deleted by the post-serve purge job. Reported on every response, not
     * hidden: it is the amount of the month the caller is not getting, and an
     * export that is quietly partial is worse than one that says so.
     */
    missing: row.missing,
    error: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    ...(row.status === "ready" ? { downloadUrl: `/v1/export/${row.id}/download` } : {}),
  };
}

/** A filename a browser will not mangle and a header cannot be broken by. */
function bundleFilename(domain: string, month: string): string {
  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_") || "site";
  const safeMonth = month.replace(/[^0-9-]/g, "") || "month";
  return `${safeDomain}-${safeMonth}.zip`;
}

// ── Build ────────────────────────────────────────────────────────────────────

interface DiscoveredPage {
  row: PageRow;
  entry: string;
}

/**
 * Turn the captured pages into the zip's contents.
 *
 * Two passes over R2 on purpose. The first reads every stored page to learn which
 * assets it references — the reference is the *rewritten* HTML's, so it cannot be
 * known without reading the bytes. The second writes the pages, by which point
 * the asset set is complete and `pageRewrites` can produce a relative path for
 * every one of them. The alternative is storing an asset-to-page index at ingest
 * time, which is a schema change and a second source of truth for something the
 * bytes already say.
 *
 * A page whose blob has been purged since the row was read, or an asset that is
 * gone, is counted and skipped. Nothing is invented to fill the gap: a silently
 * fabricated page is far worse than a missing one the README admits to.
 */
async function buildEntries(
  env: Env,
  domain: string,
  month: string,
  pages: DiscoveredPage[],
  firstTs: string | undefined,
  lastTs: string | undefined,
  missing: number,
): Promise<{ entries: ZipEntry[]; assets: number; missingAssets: number; skippedPages: number }> {
  // ── Pass 1: what does the month reference, and what is each page called? ──
  const html = new Map<string, string>();
  const titles = new Map<string, string>();
  const assetHashes = new Set<string>();
  let skippedPages = 0;

  for (const page of pages) {
    const object = await env.STORAGE.get(page.row.r2_key);
    if (!object) {
      skippedPages += 1;
      continue;
    }
    const text = await object.text();
    html.set(page.entry, text);
    collectAssetHashes(text, assetHashes);
    // The crawl records a title when it indexed the page; for an archive crawled
    // before that column existed, or one the extractor found nothing in, a second
    // bounded read is worth it — a landing page whose entries are bare URLs is
    // markedly harder to browse than one with real page names.
    if (page.row.title) {
      titles.set(page.entry, page.row.title);
    } else {
      const prefix = await env.STORAGE.get(page.row.r2_key, { range: { offset: 0, length: 4096 } });
      const title = prefix ? titleFromPrefix(new Uint8Array(await prefix.arrayBuffer())) : undefined;
      if (title) titles.set(page.entry, title);
    }
  }

  // ── Pass 2: the assets, then the pages ────────────────────────────────────
  const included: string[] = [];
  const assetBytes = new Map<string, Uint8Array>();
  let missingAssets = 0;

  for (const hash of [...assetHashes].sort()) {
    const object = await env.STORAGE.get(`assets/${hash.slice(0, 2)}/${hash}`);
    if (!object) {
      missingAssets += 1;
      continue;
    }
    assetBytes.set(hash, new Uint8Array(await object.arrayBuffer()));
    included.push(hash);
  }

  const locations: PageLocation[] = pages
    .filter((page) => html.has(page.entry))
    .map((page) => ({ url: page.row.url, entry: page.entry }));

  const entries: ZipEntry[] = [];

  // The two files at the root come first so that a reader who opens the zip sees
  // them immediately, in every tool, whatever the sort order it applies.
  const indexPages: IndexPage[] = pages
    .filter((page) => html.has(page.entry))
    .map((page) => ({
      day: page.row.day,
      url: page.row.url,
      entry: page.entry,
      title: titles.get(page.entry),
    }));

  entries.push({
    name: INDEX_ENTRY,
    bytes: utf8(
      buildIndexHtml({ domain, month, pages: indexPages, assetCount: included.length, missing }),
    ),
  });
  entries.push({
    name: README_ENTRY,
    bytes: utf8(
      buildReadme({
        domain,
        month,
        days: [...new Set(pages.map((page) => page.row.day))].sort(),
        pages: indexPages.length,
        assets: included.length,
        missing,
        firstTs,
        lastTs,
      }),
    ),
  });

  for (const page of pages) {
    const text = html.get(page.entry);
    if (text === undefined) continue;
    const plan = pageRewrites(domain, { url: page.row.url, entry: page.entry }, locations, included);

    const rewritten = await rewritePageHtml(text, plan, {
      domain,
      month,
      sourceUrl: page.row.url,
      day: page.row.day,
    });

    entries.push({
      name: page.entry,
      bytes: utf8(rewritten),
      // The capture's own timestamp, so an extracted file's mtime says when the
      // page was taken rather than when the bundle happened to be built. This is
      // also what makes two exports of the same month byte-identical.
      ...dosTimestamp(page.row.ts),
    });
  }

  for (const hash of included) {
    const bytes = assetBytes.get(hash);
    if (!bytes) continue;
    entries.push({ name: `assets/${hash.slice(0, 2)}/${hash}`, bytes });
  }

  return { entries, assets: included.length, missingAssets, skippedPages };
}

/**
 * Rewrite one stored page so it refers only to files inside the bundle.
 *
 * `HTMLRewriter` rather than a DOM, for the reason it exists in this runtime: a
 * month of archived pages, some of them megabytes of 2004 table soup, is not
 * something to parse into memory one document at a time. It streams.
 *
 * Two kinds of work happen here:
 *
 *   1. **Attributes the rewriter can see.** `href`, `src`, `srcset`, `poster` and
 *      the injected `<base>`.
 *   2. **URLs hidden in text.** A `style="background:url(/assets/…)"` attribute, a
 *      `<style>` block, and `srcset` candidates are matched as strings by
 *      `rewriteUrlsInText`, which is exact because every URL the ingest rewriter
 *      produced is absolute and machine-generated.
 *
 * A provenance banner is prepended to `<body>`. plan.md §12 rule 7 asks for
 * visible attribution, and a reader who opens one page directly out of the zip
 * (rather than through `index.html`) should still be told where it came from and
 * that handling it is a request, not a right. It is styled inline so it cannot
 * depend on any asset in the archive.
 */
async function rewritePageHtml(
  html: string,
  plan: ReturnType<typeof pageRewrites>,
  info: { domain: string; month: string; sourceUrl: string; day: string },
): Promise<string> {
  const mapSrcset = (value: string | null): string | undefined => {
    if (!value) return undefined;
    const rewritten = value
      .split(",")
      .map((part) => {
        const [url, ...descriptor] = part.trim().split(/\s+/);
        if (!url) return part.trim();
        const mapped = rewriteValue(plan, url);
        return [mapped ?? url, ...descriptor].join(" ");
      })
      .join(", ");
    return rewritten === value ? undefined : rewritten;
  };

  const banner =
    `<div style="all:initial;display:block;box-sizing:border-box;width:100%;` +
    `padding:6px 10px;background:#1b1b1f;color:#f5f5f5;` +
    `font:12px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">` +
    `Archived copy of <span style="opacity:.8">${escapeForBanner(info.sourceUrl)}</span> — ` +
    `captured ${escapeForBanner(info.day)} from the Internet Archive Wayback Machine. ` +
    `Exported from ${escapeForBanner(info.domain)} (${escapeForBanner(info.month)}).</div>`;

  const response = new HTMLRewriter()
    .on("base", {
      element(el) {
        // Whatever the capture or the ingest pass left here, the bundle has
        // exactly one correct value and it is not an absolute path: inside a zip
        // `/` is outside the archive.
        el.setAttribute("href", plan.base);
      },
    })
    .on("a[href], area[href]", {
      element(el) {
        const next = rewriteValue(plan, el.getAttribute("href"));
        if (next !== undefined) el.setAttribute("href", next);
      },
    })
    .on("link[href]", {
      element(el) {
        const next = rewriteValue(plan, el.getAttribute("href"));
        if (next !== undefined) el.setAttribute("href", next);
      },
    })
    .on("[src]", {
      element(el) {
        const next = rewriteValue(plan, el.getAttribute("src"));
        if (next !== undefined) el.setAttribute("src", next);
      },
    })
    .on("[poster]", {
      element(el) {
        const next = rewriteValue(plan, el.getAttribute("poster"));
        if (next !== undefined) el.setAttribute("poster", next);
      },
    })
    .on("[srcset]", {
      element(el) {
        const next = mapSrcset(el.getAttribute("srcset"));
        if (next !== undefined) el.setAttribute("srcset", next);
      },
    })
    .on("[style]", {
      element(el) {
        const style = el.getAttribute("style");
        if (!style) return;
        const next = rewriteUrlsInText(style, plan);
        if (next !== style) el.setAttribute("style", next);
      },
    })
    .on("style", {
      // A `<style>` block arrives as text, not as an attribute, and text is
      // delivered in chunks — so the rewriter gets a `text` handler rather than
      // reading `textContent` (which a streaming parser does not have). A URL
      // split across two chunks would be missed, which is acceptable: the token is
      // machine-generated and short, and the alternative is buffering every
      // document's `<style>` blocks in memory.
      text(chunk) {
        const next = rewriteUrlsInText(chunk.text, plan);
        if (next !== chunk.text) chunk.replace(next);
      },
    })
    .on("body", {
      element(el) {
        el.prepend(banner, { html: true });
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));

  return await response.text();
}

function escapeForBanner(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── POST /v1/export ──────────────────────────────────────────────────────────

exportRouter.post("/", async (c) => {
  const userId = c.get("userId" as never) as string;

  // The body is the documented form; the query string is accepted as well so a
  // link or a curl one-liner can start an export without a JSON encoder.
  let body: { domain?: unknown; month?: unknown } = {};
  try {
    body = (await c.req.json()) as { domain?: unknown; month?: unknown };
  } catch {
    body = {};
  }
  const rawDomain = body.domain ?? c.req.query("domain");
  const rawMonth = body.month ?? c.req.query("month");

  if (typeof rawDomain !== "string" || rawDomain.trim().length === 0) {
    return c.json({ error: "domain is required" }, 400);
  }
  const domain = rawDomain.trim().toLowerCase();
  if (typeof rawMonth !== "string" || !MONTH_PATTERN.test(rawMonth)) {
    return c.json({ error: "month must be YYYY-MM" }, 400);
  }
  const month = rawMonth;

  // Building a bundle reads every page and asset of a month out of R2 and writes
  // the result back. That is the `jobs` budget, not the `read` budget.
  const limit = await consumeRateLimit(c.env, userBucket(userId, "jobs"), "jobs");
  if (!limit.allowed) {
    return c.json(
      {
        error: "rate_limited",
        message: `Too many export requests. Try again in ${limit.retryAfter}s.`,
        retryAfter: limit.retryAfter,
      },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  // Ownership, by join through the domain the caller actually owns. A month of
  // somebody else's domain is not a thing this API will discuss the existence of.
  const ingest = await c.env.DB.prepare(
    `SELECT i.id AS id
     FROM domains d
     JOIN ingests i ON i.domain_id = d.id
     WHERE d.domain = ? AND d.user_id = ? AND i.month = ?
     LIMIT 1`,
  )
    .bind(domain, userId, month)
    .first<{ id: string }>();
  if (!ingest) return c.json({ error: "Not found" }, 404);

  const stored = await c.env.DB.prepare(
    `SELECT s.url AS url, s.day AS day, s.ts AS ts, s.r2_key AS r2_key, s.bytes AS bytes, s.title AS title
     FROM snapshots s
     WHERE s.ingest_id = ? AND s.r2_key IS NOT NULL
     ORDER BY s.day ASC, s.url ASC`,
  )
    .bind(ingest.id)
    .all<PageRow>();
  const rows = stored.results ?? [];

  const counts = await c.env.DB.prepare(
    `SELECT
       COUNT(DISTINCT url) AS total,
       COUNT(DISTINCT CASE WHEN r2_key IS NOT NULL THEN url END) AS stored
     FROM snapshots WHERE ingest_id = ?`,
  )
    .bind(ingest.id)
    .first<{ total: number; stored: number }>();

  const missing = countMissing({
    total: Number(counts?.total ?? rows.length),
    stored: Number(counts?.stored ?? rows.length),
  });

  if (rows.length === 0) {
    return c.json(
      {
        error: "nothing_to_export",
        message:
          missing > 0
            ? `All ${missing} page(s) captured for ${domain} ${month} have already been removed from storage, so there is nothing left to bundle.`
            : `No pages are stored for ${domain} ${month} yet — crawl the month first.`,
        missing,
      },
      409,
    );
  }

  const estimated = rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
  if (estimated > MAX_BUNDLE_BYTES) {
    return c.json(
      {
        error: "bundle_too_large",
        message:
          `${domain} ${month} holds about ${Math.round(estimated / (1024 * 1024))} MB of pages, ` +
          `which is over the ${Math.round(MAX_BUNDLE_BYTES / (1024 * 1024))} MB ceiling for one export. ` +
          `Export a smaller month, or raise MAX_PAGES_PER_MONTH and re-crawl at a lower page budget.`,
        bytes: estimated,
        limitBytes: MAX_BUNDLE_BYTES,
      },
      413,
    );
  }

  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  const r2Key = `exports/${domain}/${month}/${id}.zip`;

  // The row exists before any work starts, so a bundle that dies mid-build leaves
  // a record with a reason instead of an anonymous object in the bucket.
  await c.env.DB.prepare(
    `INSERT INTO exports (id, user_id, domain, month, r2_key, pages, assets, missing, status, created_at)
     VALUES (?,?,?,?,?,0,0,?,'building',?)`,
  )
    .bind(id, userId, domain, month, r2Key, missing, now)
    .run();

  const pages: DiscoveredPage[] = rows.map((row) => ({
    row,
    entry: pageEntryName(row.day, row.url),
  }));

  // The capture range, for the README. `ts` sorts as text because it is fixed
  // width, so this needs no date parsing and cannot pick up a timezone.
  const timestamps = rows.map((row) => row.ts).filter((ts) => /^\d{14}$/.test(ts)).sort();
  const firstTs = timestamps[0];
  const lastTs = timestamps[timestamps.length - 1];

  try {
    const built = await buildEntries(c.env, domain, month, pages, firstTs, lastTs, missing);

    // Assemble into one buffer before the R2 write.
    //
    // R2's `put` rejects a stream whose length it cannot determine:
    //   "Provided readable stream must have a known length (request/response body
    //    or readable half of FixedLengthStream)"
    // A ZIP's total length is not known until the central directory at the end has
    // been emitted, so `FixedLengthStream` cannot be constructed up front either.
    // Buffering is the honest resolution, and it is affordable because
    // `MAX_BUNDLE_BYTES` (64 MiB) already refuses anything larger before a single
    // byte is read — the ceiling is what makes this safe rather than optimistic.
    const chunks: Uint8Array[] = [];
    let written = 0;
    for await (const chunk of buildZipStream(built.entries, { deflate: platformDeflate })) {
      written += chunk.length;
      if (written > MAX_BUNDLE_BYTES) {
        throw new Error(
          `bundle exceeded MAX_BUNDLE_BYTES (${MAX_BUNDLE_BYTES}) while being assembled`,
        );
      }
      chunks.push(chunk);
    }

    const bundle = new Uint8Array(written);
    let offset = 0;
    for (const chunk of chunks) {
      bundle.set(chunk, offset);
      offset += chunk.length;
    }

    await c.env.STORAGE.put(r2Key, bundle, {
      httpMetadata: {
        contentType: "application/zip",
        contentDisposition: `attachment; filename="${bundleFilename(domain, month)}"`,
      },
      customMetadata: { exportId: id, domain, month },
    });

    const finished = Math.floor(Date.now() / 1000);
    const pagesIncluded = built.entries.filter((entry) => entry.name.startsWith("pages/")).length;
    await c.env.DB.prepare(
      `UPDATE exports SET status = 'ready', bytes = ?, pages = ?, assets = ?, missing = ?,
         error_message = NULL, finished_at = ?
       WHERE id = ? AND user_id = ?`,
    )
      .bind(written, pagesIncluded, built.assets, missing, finished, id, userId)
      .run();

    // An export that is missing pages, assets, or both says so in the response.
    // The caller is about to hand this file to somebody; they are entitled to know
    // how complete it is before they do.
    const warnings: string[] = [];
    if (built.skippedPages > 0) {
      warnings.push(`${built.skippedPages} page(s) were removed from storage while the bundle was being built.`);
    }
    if (built.missingAssets > 0) {
      warnings.push(`${built.missingAssets} referenced asset(s) were no longer in storage and are not in the bundle.`);
    }

    return c.json(
      {
        id,
        status: "ready",
        domain,
        month,
        bytes: written,
        pages: pagesIncluded,
        assets: built.assets,
        missing,
        warnings,
        downloadUrl: `/v1/export/${id}/download`,
        statusUrl: `/v1/export/${id}`,
      },
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[export] ${id} failed for ${domain} ${month}: ${message}`);
    await c.env.DB.prepare(
      `UPDATE exports SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`,
    )
      .bind(message.slice(0, 500), Math.floor(Date.now() / 1000), id)
      .run();
    return c.json({ id, status: "failed", error: message, statusUrl: `/v1/export/${id}` }, 500);
  }
});

// ── GET /v1/export/:id ───────────────────────────────────────────────────────

exportRouter.get("/:id", async (c) => {
  const userId = c.get("userId" as never) as string;
  const row = await loadExport(c, userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(exportJson(row));
});

// ── GET /v1/export/:id/download ──────────────────────────────────────────────

exportRouter.get("/:id/download", async (c) => {
  const userId = c.get("userId" as never) as string;
  const row = await loadExport(c, userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.status === "building") {
    return c.json({ error: "not_ready", status: row.status, message: "This bundle is still being built." }, 409, {
      "Retry-After": "5",
    });
  }
  if (row.status === "deleted") {
    return c.json(
      {
        error: "gone",
        status: row.status,
        message:
          "This export was deleted: its bundle was removed from storage to stop it accumulating cost. " +
          "The record remains, and a new export of the same month can be built at any time.",
      },
      410,
    );
  }
  if (row.status === "failed") {
    return c.json({ error: "failed", status: row.status, error_message: row.error_message }, 409);
  }

  const object = await c.env.STORAGE.get(row.r2_key);
  if (!object) {
    // The row is the record; the object is the artifact. Losing the object while
    // keeping the row is a known consequence of R2 lifecycle rules, and a 404
    // would suggest the export never existed when in fact it did and can be
    // rebuilt.
    return c.json(
      {
        error: "gone",
        status: row.status,
        message:
          "The bundle for this export is no longer in storage. The record remains and the export can be built again.",
      },
      410,
    );
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundleFilename(row.domain, row.month)}"`,
      // Explicit, from the object's own size. A browser download with no
      // Content-Length shows no progress and no total, which for a bundle that is
      // tens of megabytes looks like a hang.
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Custom-Wayback-Export": row.id,
    },
  });
});

// ── DELETE /v1/export/:id ────────────────────────────────────────────────────

exportRouter.delete("/:id", async (c) => {
  const userId = c.get("userId" as never) as string;
  const id = c.req.param("id");
  const row = await loadExport(c, userId, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.status === "deleted") {
    return c.json({ ok: true, id, status: "deleted", alreadyDeleted: true });
  }

  try {
    await c.env.STORAGE.delete(row.r2_key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[export] ${id} delete failed: ${message}`);
    return c.json({ error: "delete_failed", message }, 503);
  }

  // The artifact goes; the record stays. The row is the only way to know that the
  // export existed, what it contained, and that it was deliberately removed
  // rather than lost — and it is what a second DELETE needs in order to be
  // idempotent instead of a 404.
  await c.env.DB.prepare(
    `UPDATE exports SET status = 'deleted', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND user_id = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), id, userId)
    .run();

  return c.json({ ok: true, id, status: "deleted", bytes: row.bytes });
});
