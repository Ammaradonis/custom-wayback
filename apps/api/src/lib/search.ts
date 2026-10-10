/**
 * Cross-domain full-text search over crawled snapshots (plan.md §15).
 *
 * ## The interesting part is the query builder
 *
 * `snapshot_fts` is an FTS5 table and FTS5's `MATCH` takes a *query expression*,
 * not a search string. Handing it raw user input is wrong in two distinct ways:
 *
 *  1. **It breaks.** `iphone 15 pro` is fine, but `iphone (15` is a syntax error,
 *     `"unclosed` is a syntax error, and `AND` on its own is a syntax error. Every
 *     one of those is a 500 for the user.
 *  2. **It is an injection surface.** FTS5 columns can be addressed by name, so
 *     input like `text:secret` or `{title} : foo` lets a caller write parts of the
 *     query expression itself. It is not SQL injection — the statement is still
 *     parameterised — but it does let input change the *meaning* of the search.
 *
 * So every term is escaped as an FTS5 string literal (`"..."` with internal quotes
 * doubled) and joined with explicit operators. After that the input can only ever
 * be a sequence of terms, which is exactly the contract a search box should have.
 *
 * ## Why the query is scoped by a join rather than an owner column
 *
 * Ownership is a property of the domain, not of the document. `snapshot_fts` has
 * no `user_id` — the join through `snapshots` → `ingests` → `domains` applies the
 * ownership filter, so there is one source of truth for who may read what, and a
 * document can never be indexed with the wrong owner.
 */

import type { Env } from "../env.js";

/** Terms longer than this are almost certainly a paste, not a query. */
const MAX_TERM_LENGTH = 64;
/** A query with more terms than this is not a search, it is a document. */
const MAX_TERMS = 12;
/** Snippet length returned to the client. */
const SNIPPET_CHARS = 240;

/**
 * Options a caller may express in the query string. These are parsed *here*,
 * before escaping, so they can never be smuggled in as FTS5 syntax.
 */
export interface SearchOptions {
  /** Free text. */
  q: string;
  /** Restrict to one domain. */
  domain?: string;
  /** Restrict to one "YYYY-MM". */
  month?: string;
  /** Exact day "YYYY-MM-DD". */
  day?: string;
  limit: number;
  offset: number;
}

export interface SearchHit {
  domain: string;
  url: string;
  day: string;
  ts: string;
  title: string | null;
  /** BM25 relevance; lower is better in SQLite, negated here so higher is better. */
  score: number;
  snippet: string;
  /** Snapshot route, ready to open in the viewer. */
  route: string;
}

export interface SearchResponse {
  query: string;
  /** The escaped expression actually sent to FTS5 — shown so behaviour is explicable. */
  expression: string;
  total: number;
  hits: SearchHit[];
  tookMs: number;
}

/** Thrown for input we refuse to search on, so the route can return 400 not 500. */
export class SearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchInputError";
  }
}

/** Escape one term as an FTS5 string literal. */
function quoteTerm(term: string): string {
  // Inside an FTS5 string, a double quote is escaped by doubling it.
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Turn a user's search box text into an FTS5 prefix query.
 *
 * Every term becomes a quoted prefix (`"iphon"*`), so "iphon" matches "iphone"
 * while punctuation in the input cannot change the expression's shape. Terms are
 * ANDed: adding a word should narrow a search, which is what people expect.
 */
export function buildFtsExpression(raw: string): string {
  const terms = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    // Keep letters, numbers, and the few marks that appear inside real words
    // (C++, AT&T, 3.5mm, mother-in-law, don't). Everything else goes, which is
    // what stops `(`/`"`/`*`/`:` from reaching the FTS5 parser.
    .map((t) => t.replace(/[^\p{L}\p{N}+&.'_-]/gu, ""))
    // Leading and trailing marks are noise: `!!!` and `***` reduce to nothing and
    // are dropped rather than searched for.
    .map((t) => t.replace(/^[.'_-]+|[.'_-]+$/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS)
    .map((t) => (t.length > MAX_TERM_LENGTH ? t.slice(0, MAX_TERM_LENGTH) : t));

  if (terms.length === 0) {
    throw new SearchInputError(
      "Search needs at least one word containing a letter or number.",
    );
  }

  return terms.map((t) => `${quoteTerm(t)}*`).join(" AND ");
}

/**
 * Build a snippet around the first matching term.
 *
 * SQLite's own `snippet()` is available, but it returns FTS5's `>>>match<<<`
 * markers and we would rather control the presentation. Doing it here also means
 * one implementation for both the API and any future client-side rendering.
 */
export function makeSnippet(text: string, terms: string[], maxChars = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;

  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${flat.slice(0, maxChars - 1)}…`;

  // Aim for the match to sit a third of the way in, so there is context on both
  // sides rather than the match pinned to the left edge.
  const start = Math.max(0, at - Math.floor(maxChars / 3));
  const end = Math.min(flat.length, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

interface FtsRow {
  domain: string;
  url: string;
  day: string;
  ts: string;
  title: string | null;
  text: string;
  score: number;
}

/**
 * Run a search, scoped to the domains this user owns.
 *
 * Returns the total count as well as the page, because "412 results" is the thing
 * that tells you whether you have crawled enough of a site to answer your
 * question — and it is one cheap `COUNT(*)` next to the page query.
 */
export async function searchSnapshots(
  env: Env,
  userId: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  const started = Date.now();
  const expression = buildFtsExpression(options.q);
  const terms = expression
    .split(" AND ")
    .map((t) => t.replace(/^"|"\*$/g, "").replace(/""/g, '"'));

  const filters: string[] = ["d.user_id = ?"];
  const filterParams: unknown[] = [userId];

  if (options.domain) {
    filters.push("s.domain = ?");
    filterParams.push(options.domain);
  }
  if (options.day) {
    filters.push("s.day = ?");
    filterParams.push(options.day);
  } else if (options.month) {
    // Prefix match on the day column: "2024-03" matches every day in March.
    filters.push("s.day LIKE ?");
    filterParams.push(`${options.month}-%`);
  }

  const where = filters.join(" AND ");
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const offset = Math.max(options.offset, 0);

  // `bm25()` returns a negative score where more-negative is a better match, so
  // it is negated to make "higher is better" true for callers.
  const rows = await env.DB.prepare(
    `SELECT f.domain AS domain, f.url AS url, f.day AS day, f.ts AS ts,
            f.title AS title, f.text AS text,
            -bm25(snapshot_fts, 4.0, 10.0, 1.0) AS score
     FROM snapshot_fts f
     JOIN search_docs sd ON sd.snapshot_id = f.doc_id
     JOIN snapshots s ON s.id = sd.snapshot_id
     JOIN ingests i ON i.id = s.ingest_id
     JOIN domains d ON d.id = i.domain_id
     WHERE snapshot_fts MATCH ? AND ${where}
     ORDER BY score DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(expression, ...filterParams, limit, offset)
    .all<FtsRow>();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM snapshot_fts f
     JOIN search_docs sd ON sd.snapshot_id = f.doc_id
     JOIN snapshots s ON s.id = sd.snapshot_id
     JOIN ingests i ON i.id = s.ingest_id
     JOIN domains d ON d.id = i.domain_id
     WHERE snapshot_fts MATCH ? AND ${where}`,
  )
    .bind(expression, ...filterParams)
    .first<{ total: number }>();

  const hits: SearchHit[] = (rows.results ?? []).map((row) => ({
    domain: row.domain,
    url: row.url,
    day: row.day,
    ts: row.ts,
    title: row.title,
    score: row.score,
    snippet: makeSnippet(row.text ?? "", terms),
    route: `/a/${row.domain}/${row.day}${pathOf(row.url)}`,
  }));

  return {
    query: options.q,
    expression,
    total: countRow?.total ?? hits.length,
    hits,
    tookMs: Date.now() - started,
  };
}

/** Path (+ encoded query) of an absolute URL, for building a viewer route. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (!path.startsWith("/")) path = `/${path}`;
    const suffix = parsed.search ? `%3F${encodeURIComponent(parsed.search.slice(1))}` : "";
    return `${path}${suffix}`;
  } catch {
    return "/";
  }
}
