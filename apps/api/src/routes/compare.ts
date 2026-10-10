/**
 * Compare two months of the same domain (plan.md §15, "Diff two months").
 *
 *  GET /v1/compare?domain=…&from=2024-02&to=2024-03
 *      → which pages were added, removed, changed or unchanged
 *  GET /v1/compare/page?domain=…&from=…&to=…&url=…
 *      → the actual textual diff for one changed page
 *
 * ## Two calls, on purpose
 *
 * The list is cheap — two indexed D1 reads and nothing else, because each crawl
 * recorded a `content_digest` of the bytes it stored. The per-page diff is
 * expensive: it reads both versions out of R2 and runs a word-level diff. Keeping
 * them separate means the list stays instant on a domain with thousands of pages,
 * and the user pays for a detail diff only on the pages they actually open.
 *
 * ## Why `unknown` is a first-class outcome
 *
 * Pages crawled before digests existed have no `content_digest`. The honest answer
 * for those is "cannot tell without comparing the bytes", not `unchanged` — a
 * confident "nothing changed here" that is really "I did not look" is worse than
 * no answer at all, because it is the kind of wrong that gets acted on.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { authenticateRequest } from "../lib/auth.js";
import { consumeRateLimit, userBucket } from "../lib/ratelimit.js";
import { classifyChange, diffPageText, summariseDiff, type ChangeKind, type PageChange } from "../lib/compare.js";
import { extractIndexableText } from "@custom-wayback/pipeline";

export const compareRouter = new Hono<{ Bindings: Env }>();

compareRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

interface SnapshotRow {
  url: string;
  day: string;
  content_digest: string | null;
  title: string | null;
  bytes: number | null;
  r2_key: string | null;
}

/** Load one month's snapshots for a domain the caller owns. */
async function loadMonth(
  env: Env,
  userId: string,
  domain: string,
  month: string,
): Promise<Map<string, SnapshotRow> | null> {
  const owned = await env.DB.prepare(
    `SELECT id FROM domains WHERE domain = ? AND user_id = ? AND tracking_status != 'deleted'`,
  )
    .bind(domain, userId)
    .first<{ id: string }>();
  if (!owned) return null;

  const rows = await env.DB.prepare(
    `SELECT url, day, content_digest, title, bytes, r2_key
     FROM snapshots
     WHERE domain = ? AND day LIKE ?
     ORDER BY day`,
  )
    .bind(domain, `${month}-%`)
    .all<SnapshotRow>();

  const byUrl = new Map<string, SnapshotRow>();
  for (const row of rows.results ?? []) {
    // One row per URL per month is the "single clean snapshot a day" contract, but
    // a URL captured on several days within the month legitimately has several
    // rows. Keep the latest day: comparing "how the page looked at the end of the
    // month" against the other month is the useful default, and it is stable.
    const existing = byUrl.get(row.url);
    if (!existing || row.day > existing.day) byUrl.set(row.url, row);
  }
  return byUrl;
}

// ── The list ─────────────────────────────────────────────────────────────────

compareRouter.get("/", async (c) => {
  const userId = c.get("userId" as never) as string;

  const limit = await consumeRateLimit(c.env, userBucket(userId, "read"), "read");
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retryAfter: limit.retryAfter }, 429, {
      "Retry-After": String(limit.retryAfter),
    });
  }

  const domain = c.req.query("domain");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!domain || !from || !to) {
    return c.json({ error: "domain, from and to are required" }, 400);
  }
  if (!MONTH.test(from) || !MONTH.test(to)) {
    return c.json({ error: "from and to must be YYYY-MM" }, 400);
  }
  if (from === to) {
    return c.json({ error: "from and to are the same month; nothing to compare" }, 400);
  }

  const [before, after] = await Promise.all([
    loadMonth(c.env, userId, domain, from),
    loadMonth(c.env, userId, domain, to),
  ]);
  if (!before || !after) return c.json({ error: "Domain not found" }, 404);
  if (before.size === 0 && after.size === 0) {
    return c.json({ error: "Neither month has been crawled", from, to }, 404);
  }

  const counts: Record<ChangeKind, number> = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
    unknown: 0,
  };
  const changes: PageChange[] = [];

  const urls = new Set([...before.keys(), ...after.keys()]);
  for (const url of urls) {
    const b = before.get(url) ?? null;
    const a = after.get(url) ?? null;
    const kind = classifyChange(b, a);
    counts[kind] += 1;

    if (kind === "unchanged") continue;

    const entry: PageChange = {
      url,
      kind,
      title: a?.title ?? b?.title ?? null,
      day: a?.day ?? b?.day ?? null,
    };
    if (kind === "changed" && !(b?.content_digest && a?.content_digest)) {
      entry.note =
        "one side has no content digest (crawled before comparison existed), so this difference is inferred from size and title";
    }
    if (kind === "unknown") {
      entry.note = "no content digest on either side; re-crawl to compare reliably";
    }
    changes.push(entry);
  }

  // Most interesting first: additions and removals are structural news, then
  // changes. Within a kind, keep the order stable so repeated calls agree.
  const order: Record<ChangeKind, number> = { added: 0, removed: 1, changed: 2, unknown: 3, unchanged: 4 };
  changes.sort((x, y) => order[x.kind] - order[y.kind] || x.url.localeCompare(y.url));

  const hasDigests = [...before.values(), ...after.values()].some((row) => row.content_digest !== null);

  return c.json({
    domain,
    from,
    to,
    counts,
    totalPages: { from: before.size, to: after.size },
    hasDigests,
    ...(hasDigests
      ? {}
      : {
          note:
            "Neither month has content digests, so 'changed' is inferred from size and title. Re-crawl to compare exactly.",
        }),
    changes,
  });
});

// ── The detail diff for one page ──────────────────────────────────────────────

compareRouter.get("/page", async (c) => {
  const userId = c.get("userId" as never) as string;

  const limit = await consumeRateLimit(c.env, userBucket(userId, "read"), "read");
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retryAfter: limit.retryAfter }, 429, {
      "Retry-After": String(limit.retryAfter),
    });
  }

  const domain = c.req.query("domain");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const url = c.req.query("url");
  if (!domain || !from || !to || !url) {
    return c.json({ error: "domain, from, to and url are required" }, 400);
  }
  if (!MONTH.test(from) || !MONTH.test(to)) {
    return c.json({ error: "from and to must be YYYY-MM" }, 400);
  }

  const owned = await c.env.DB.prepare(
    `SELECT id FROM domains WHERE domain = ? AND user_id = ? AND tracking_status != 'deleted'`,
  )
    .bind(domain, userId)
    .first<{ id: string }>();
  if (!owned) return c.json({ error: "Domain not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT day, r2_key, content_digest, title, bytes
     FROM snapshots
     WHERE domain = ? AND url = ? AND (day LIKE ? OR day LIKE ?)
     ORDER BY day`,
  )
    .bind(domain, url, `${from}-%`, `${to}-%`)
    .all<{ day: string; r2_key: string | null; content_digest: string | null; title: string | null; bytes: number | null }>();

  const all = rows.results ?? [];
  const beforeRow = all.find((r) => r.day.startsWith(from)) ?? null;
  const afterRow = [...all].reverse().find((r) => r.day.startsWith(to)) ?? null;

  if (!beforeRow && !afterRow) {
    return c.json({ error: "This page was not captured in either month" }, 404);
  }

  const kind = classifyChange(beforeRow, afterRow);

  const read = async (row: { r2_key: string | null } | null): Promise<{ text: string; available: boolean }> => {
    if (!row?.r2_key) return { text: "", available: false };
    const object = await c.env.STORAGE.get(row.r2_key);
    if (!object) return { text: "", available: false };
    const html = await object.text();
    return { text: extractIndexableText(html), available: true };
  };

  const [beforeText, afterText] = await Promise.all([read(beforeRow), read(afterRow)]);

  // A page whose blob has been purged cannot be diffed. Say which side is missing
  // rather than rendering an empty diff, which would read as "nothing changed".
  const unavailable: string[] = [];
  if (beforeRow && !beforeText.available) unavailable.push(from);
  if (afterRow && !afterText.available) unavailable.push(to);

  const diff = diffPageText(beforeText.text, afterText.text);

  return c.json({
    domain,
    url,
    from,
    to,
    kind,
    before: beforeRow
      ? { day: beforeRow.day, title: beforeRow.title, bytes: beforeRow.bytes, available: beforeText.available }
      : null,
    after: afterRow
      ? { day: afterRow.day, title: afterRow.title, bytes: afterRow.bytes, available: afterText.available }
      : null,
    summary: summariseDiff(diff),
    addedWords: diff.addedWords,
    removedWords: diff.removedWords,
    truncated: diff.truncated,
    segments: diff.segments,
    ...(unavailable.length > 0
      ? {
          unavailableMonths: unavailable,
          note:
            `The stored copy for ${unavailable.join(" and ")} has been removed by the post-serve purge, ` +
            `so this diff is incomplete. Re-crawl that month to compare it.`,
        }
      : {}),
  });
});
