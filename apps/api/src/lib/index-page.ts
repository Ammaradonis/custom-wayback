/**
 * The search-index write path (plan.md §15).
 *
 * One function, used by two callers that must not diverge:
 *
 *  - the queue consumer, indexing each page as it is rewritten (the normal path);
 *  - `POST /v1/search/reindex`, backfilling pages that were crawled before search
 *    existed (the recovery path).
 *
 * If these two wrote different rows, a backfilled archive would search differently
 * from a freshly crawled one, and the difference would only show up months later.
 *
 * ## Why the text is extracted at ingest and never read from R2 afterwards
 *
 * The post-serve purge job deletes page blobs by design. A search that read bodies
 * out of R2 would silently lose every page already visited — the archive would
 * appear to shrink as it was used. The index is the durable copy of the text.
 */

import type { Env } from "../env.js";
import { extractIndexableText, extractTitle } from "@custom-wayback/pipeline";

export interface IndexablePage {
  /** `snapshots.id` — the join key, held explicitly rather than via FTS5 rowid. */
  snapshotId: string;
  domain: string;
  url: string;
  day: string;
  ts: string;
  /** The *rewritten* HTML, so the index matches what the viewer serves. */
  html: string;
  bytes: number;
}

/**
 * Statements that put one page into the index, or `[]` when it has no text.
 *
 * Three statements, in order, and the order matters:
 *
 *  1. `DELETE` — `snapshot_fts` is an FTS5 virtual table with no unique
 *     constraint to upsert against. Without the delete, re-crawling a page would
 *     return it twice in every search, forever.
 *  2. `INSERT` into the FTS table itself.
 *  3. `INSERT OR REPLACE` into `search_docs`, the ordinary table carrying the
 *     title/bytes bookkeeping and the `snapshot_id` the search join uses.
 *
 * Returning `[]` for a text-less page is normal (redirect stubs, image-only
 * pages, JS shells whose text never existed in the HTML) — not an error.
 */
export function indexStatements(env: Env, page: IndexablePage): D1PreparedStatement[] {
  const text = extractIndexableText(page.html);
  if (text.length === 0) return [];

  const title = extractTitle(page.html);
  const now = Math.floor(Date.now() / 1000);

  return [
    env.DB.prepare(`DELETE FROM snapshot_fts WHERE doc_id = ?`).bind(page.snapshotId),
    env.DB.prepare(
      `INSERT INTO snapshot_fts (doc_id, url, title, text, domain, day, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(page.snapshotId, page.url, title ?? "", text, page.domain, page.day, page.ts),
    env.DB.prepare(
      `INSERT OR REPLACE INTO search_docs (snapshot_id, domain, url, day, title, bytes, indexed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(page.snapshotId, page.domain, page.url, page.day, title, page.bytes, now),
  ];
}

/** Rows written per indexed page — used for cost accounting. */
export const STATEMENTS_PER_PAGE = 3;
