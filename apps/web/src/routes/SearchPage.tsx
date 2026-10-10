/**
 * SearchPage — full-text search across every crawled snapshot (plan.md §15,
 * "Full-text search across snapshots").
 *
 * URL: /search?q=…&domain=…&month=…&day=…
 *
 * Three things this page is careful about:
 *
 *  1. **The snippet is archived third-party text.** It is split into runs and
 *     rendered as React text nodes (`lib/highlight.ts`); no HTML from the API is
 *     ever interpreted.
 *  2. **`invalid_query` is help, not an error.** The API answers a nonsense query
 *     such as `***` with `400 {error:"invalid_query", message}` where the message
 *     was written for the person who typed it. It is shown beside the search box
 *     the way a form hint is shown, because "you typed only punctuation" is not a
 *     system failure.
 *  3. **An archive that is not indexed must say so.** Search over a corpus that
 *     was crawled before the index existed returns nothing, and "Nothing found"
 *     would be a lie about the archive's contents. The reindex action therefore
 *     reports its own numbers — including `skipped`, the pages whose stored copy
 *     was purged and can never be indexed — and loops, visibly, while
 *     `remaining > 0`.
 *
 * The filter state lives in the URL, so a search is shareable and the back button
 * is correct (plan §2.3, "State: URL-driven").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { ApiError, search, type ReindexProgress, type SearchHit } from "@/lib/api.js";
import { splitMatches } from "@/lib/highlight.js";
import { fmtMonthShort } from "@/lib/format.js";
import {
  FIELD_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  crawledMonths,
  useSites,
} from "@/hooks/useSites.js";

const PAGE_SIZE = 20;
/** Hard stop on the reindex loop, so a stuck `remaining` cannot spin forever. */
const MAX_BATCHES = 50;

/**
 * Run `message` through React as text, emphasising occurrences of `query`.
 *
 * Every piece is a text child of a `<mark>` or a fragment — never a string fed to
 * an HTML parser. This is the whole safety argument for rendering archived text.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const pieces = useMemo(() => splitMatches(text, query), [text, query]);
  return (
    <>
      {pieces.map((piece, i) =>
        piece.match ? (
          <mark
            key={i}
            className="rounded-sm bg-accent/25 px-0.5 text-foreground"
          >
            {piece.text}
          </mark>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/** A results row shaped like a result: title line, meta line, snippet lines. */
function HitSkeleton() {
  return (
    <li className="cw-panel space-y-2 p-4" aria-hidden>
      <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
      <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
      <div className="h-3 w-full rounded bg-muted animate-pulse" />
      <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
    </li>
  );
}

function HitRow({ hit, query }: { hit: SearchHit; query: string }) {
  // A null title is common (pages captured without one). Showing an empty line
  // would look like a broken row, so the URL stands in.
  const title = hit.title && hit.title.trim().length > 0 ? hit.title : hit.url;

  return (
    <li>
      <Link
        to={hit.route}
        className="cw-panel block space-y-1.5 p-4 transition-colors hover:border-ring hover:bg-muted/40"
      >
        <p className="line-clamp-2 font-medium leading-snug">
          <Highlighted text={title} query={query} />
        </p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="text-foreground">{hit.domain}</span> ·{" "}
          <span className="tabular-nums">{hit.day}</span>
        </p>
        <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground">
          <Highlighted text={hit.snippet} query={query} />
        </p>
      </Link>
    </li>
  );
}

/** The designed empty state, shown before a query and after an empty result. */
function EmptyState() {
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium">Search every capture you have</p>
      <p className="text-xs text-muted-foreground">
        Pages are indexed from the rewritten HTML the viewer serves, so a hit is
        exactly the text you will see. Try a product name, a price, or a phrase
        from a page you remember.
      </p>
    </div>
  );
}

/** The reindex control and its running report. */
function ReindexPanel({ domain, month }: { domain: string; month: string }) {
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<ReindexProgress | null>(null);
  const [batches, setBatches] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!domain) return;
    setRunning(true);
    setBatches(0);
    setStatus(null);

    // Cumulative, because each response describes one batch. The user asked
    // "did my archive get indexed?" and the answer is a sum, not the last slice.
    let indexed = 0;
    let skipped = 0;
    let empty = 0;
    let remaining = 0;

    for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
      try {
        const res = await search.reindex({
          domain,
          ...(month ? { month } : {}),
        });
        if (!alive.current) return;

        indexed += res.indexed;
        skipped += res.skipped;
        empty += res.empty;
        remaining = res.remaining;
        setBatches(batch);
        setTotals({ indexed, skipped, empty, remaining, done: res.done });

        if (res.done || res.remaining === 0) {
          setStatus("Index is up to date for this scope.");
          break;
        }
      } catch (err) {
        if (!alive.current) return;
        // A 429 means the crawl budget is spent for now. Saying so, and inviting
        // another tap, is better than a spinner that never moves.
        const message =
          err instanceof ApiError && err.status === 429
            ? "Rate limit reached. Wait a moment, then tap Index again — the work already done is kept."
            : err instanceof Error
              ? err.message
              : "Reindex failed.";
        setStatus(message);
        break;
      }
    }

    if (alive.current) setRunning(false);
  }, [domain, month]);

  const hasNumbers = totals !== null;

  return (
    <section className="cw-panel space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Index this archive</h3>
          <p className="text-xs text-muted-foreground">
            Indexes stored pages that search cannot see yet — pages crawled before
            the index existed. It reads your own stored copies; archive.org is not
            contacted.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || !domain}
          className={`${PRIMARY_BUTTON_CLASS} flex-none`}
        >
          {running ? "Indexing…" : "Index this archive"}
        </button>
      </div>

      {!domain && (
        <p className="text-xs text-warning-foreground">
          Pick a domain first — the index is built per domain, so it needs to know
          which archive to work on.
        </p>
      )}

      {running && (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          Batch {batches}… {totals ? `${totals.indexed.toLocaleString()} pages indexed so far` : "starting"}
        </p>
      )}

      {hasNumbers && (
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-md border border-border bg-background p-2">
            <dt className="cw-label">Indexed</dt>
            <dd className="font-medium tabular-nums">{totals.indexed.toLocaleString()}</dd>
          </div>
          <div className="rounded-md border border-border bg-background p-2">
            <dt className="cw-label">Skipped</dt>
            <dd className="font-medium tabular-nums">{totals.skipped.toLocaleString()}</dd>
          </div>
          <div className="rounded-md border border-border bg-background p-2">
            <dt className="cw-label">No text</dt>
            <dd className="font-medium tabular-nums">{totals.empty.toLocaleString()}</dd>
          </div>
          <div className="rounded-md border border-border bg-background p-2">
            <dt className="cw-label">Remaining</dt>
            <dd className="font-medium tabular-nums">{totals.remaining.toLocaleString()}</dd>
          </div>
        </dl>
      )}

      {hasNumbers && totals.skipped > 0 && (
        <p className="text-xs text-warning-foreground">
          {totals.skipped.toLocaleString()}{" "}
          {totals.skipped === 1 ? "page" : "pages"} could not be indexed because
          {" "}their stored copy has been removed by the post-serve purge. They will
          not appear in search results unless the month is crawled again.
        </p>
      )}

      {hasNumbers && totals.empty > 0 && (
        <p className="text-xs text-muted-foreground">
          {totals.empty.toLocaleString()}{" "}
          {totals.empty === 1 ? "page" : "pages"} held no readable text (script-only
          shells, image-only pages), so there was nothing to index.
        </p>
      )}

      {hasNumbers && totals.remaining > 0 && !running && (
        <p className="text-xs text-warning-foreground">
          {totals.remaining.toLocaleString()} pages are still unindexed — tap Index
          again to continue where this run stopped.
        </p>
      )}

      {status && (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {status}
        </p>
      )}
    </section>
  );
}

export default function SearchPage() {
  const { domainList, sites, isLoading: domainsLoading } = useSites();
  const [params, setParams] = useSearchParams();

  const urlQ = params.get("q") ?? "";
  const domain = params.get("domain") ?? "";
  const month = params.get("month") ?? "";
  const day = params.get("day") ?? "";

  const [draft, setDraft] = useState(urlQ);
  // Keep the box in step when the URL changes underneath us (back button, link).
  useEffect(() => setDraft(urlQ), [urlQ]);

  /**
   * Months that actually have captures, newest first.
   *
   * Derived from `/v1/sites`, which lists one row per (domain, month) the ledger
   * holds — so this is a coverage fact, not an invented list of 13 calendar
   * months that would mostly return nothing when picked.
   */
  const months = useMemo(() => crawledMonths(sites, domain || undefined), [sites, domain]);

  /**
   * Bounds for the day input, kept inside the selected month.
   *
   * A day filter is only meaningful inside a month, and letting the native picker
   * wander outside it produces a query that cannot match — an empty result the
   * user has no way to explain. `<input type="date">` also renders a real,
   * themed calendar icon now that `color-scheme` is set on :root, which it was
   * not before; without that it was an unreadable control on a dark canvas.
   */
  const dayBounds = useMemo(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return { min: undefined, max: undefined };
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = new Date(y, m, 0).getDate();
    return {
      min: `${month}-01`,
      max: `${month}-${String(last).padStart(2, "0")}`,
    };
  }, [month]);

  /** Merge filter changes into the URL — one writer, so nothing can diverge. */
  const setFilters = useCallback(
    (next: { q?: string; domain?: string; month?: string; day?: string }) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (value === undefined) continue;
            if (value === "") merged.delete(key);
            else merged.set(key, value);
          }
          return merged;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  // A day left over from a previously selected month can no longer match; drop it
  // rather than sending a filter that returns nothing for no visible reason.
  useEffect(() => {
    if (day && month && !day.startsWith(month)) setFilters({ day: "" });
  }, [month, day, setFilters]);

  const trimmedQuery = urlQ.trim();

  const {
    data,
    isPending,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
    isFetching,
  } = useInfiniteQuery({
    queryKey: ["search", trimmedQuery, domain, month, day],
    initialPageParam: 0,
    enabled: trimmedQuery.length > 0,
    // A 400 is a statement about the query, not a transient fault: retrying it
    // just repeats the same refusal.
    retry: 0,
    queryFn: ({ pageParam }) =>
      search.query({
        q: trimmedQuery,
        limit: PAGE_SIZE,
        offset: pageParam,
        ...(domain ? { domain } : {}),
        ...(month ? { month } : {}),
        ...(day ? { day } : {}),
      }),
    // The server reports the offset it answered with, so the next page starts
    // exactly where this one stopped — no client-side arithmetic to drift.
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.hits.length : undefined),
  });

  const first = data?.pages[0];
  const hits = useMemo(() => data?.pages.flatMap((page) => page.hits) ?? [], [data]);

  // 400 `invalid_query` is help text. Everything else is a real error.
  const invalidQuery =
    isError && error instanceof ApiError && error.status === 400
      ? error.message
      : null;
  const hardError = isError && invalidQuery === null;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header
        className="sticky top-0 z-10 border-b border-border bg-background/85 px-4 py-2 backdrop-blur-md"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <div className="mx-auto flex min-w-0 max-w-2xl items-center justify-between gap-3">
          <h1 className="truncate text-base font-semibold">
            Search<span className="hidden sm:inline"> snapshots</span>
          </h1>
          <Link to="/" className="cw-btn cw-btn-ghost shrink-0 px-2 sm:px-4" aria-label="Dashboard">
            <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl space-y-6 px-4 py-6"
        style={{ paddingBottom: "calc(2rem + var(--sai-bottom))" }}
      >
        {/* ── Query ── */}
        <section className="space-y-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFilters({ q: draft.trim() });
            }}
            className="flex gap-2"
            role="search"
          >
            <input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="price, “free shipping”, product name…"
              aria-label="Search all crawled snapshots"
              aria-invalid={invalidQuery !== null}
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="search"
              className={`${FIELD_CLASS} flex-1`}
            />
            <button type="submit" className={`${PRIMARY_BUTTON_CLASS} flex-none`}>
              Search
            </button>
          </form>

          {/* Help, not an error: the server wrote this sentence for the user. */}
          {invalidQuery && (
            <p className="text-xs text-muted-foreground" role="status">
              {invalidQuery}
            </p>
          )}
        </section>

        {/* ── Filters ──
          * Domain is the one real filter the API takes. Month and day used to be
          * native `<input type="month">` / `<input type="date">` controls, which
          * on a light-mode OS rendered against this app's dark canvas as
          * near-invisible boxes with an unreadable picker — the same failure as
          * the calendar. They are now selects over the months/days that actually
          * have captures, so every option is one that can return a result. */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="filter-domain" className="cw-label">
              Domain
            </label>
            <select
              id="filter-domain"
              value={domain}
              onChange={(e) => setFilters({ domain: e.target.value })}
              className={`${FIELD_CLASS} w-full`}
            >
              <option value="">All domains</option>
              {domainList.map((entry) => (
                <option key={entry.id} value={entry.domain}>
                  {entry.domain}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="filter-month" className="cw-label">
              Month
            </label>
            <select
              id="filter-month"
              value={month}
              onChange={(e) => setFilters({ month: e.target.value })}
              className={`${FIELD_CLASS} w-full`}
              disabled={months.length === 0}
            >
              <option value="">
                {months.length === 0 ? "No months crawled" : "Any month"}
              </option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {fmtMonthShort(m)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="filter-day" className="cw-label">
              Day
            </label>
            <input
              id="filter-day"
              type="date"
              value={day}
              min={dayBounds.min}
              max={dayBounds.max}
              disabled={month === ""}
              onChange={(e) => setFilters({ day: e.target.value })}
              className={`${FIELD_CLASS} w-full disabled:opacity-55`}
              aria-describedby={month === "" ? "filter-day-hint" : undefined}
            />
            {month === "" && (
              <p id="filter-day-hint" className="text-xs text-muted-foreground">
                Pick a month first.
              </p>
            )}
          </div>
        </section>

        {/* Active filter summary + a way out, so a filtered empty result is never
          * a mystery. */}
        {(domain || month || day) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Filtered to</span>
            {[domain, month, day].filter(Boolean).map((part) => (
              <span
                key={part}
                className="rounded-full border border-border bg-muted px-2 py-0.5 text-foreground"
              >
                {part}
              </span>
            ))}
            <button
              type="button"
              data-compact
              onClick={() => setFilters({ domain: "", month: "", day: "" })}
              className="rounded-lg px-2 py-1 font-medium text-accent hover:bg-muted"
            >
              Clear
            </button>
          </div>
        )}

        {/* ── Results ── */}
        {trimmedQuery.length === 0 && <EmptyState />}

        {trimmedQuery.length > 0 && isPending && (
          <ul className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <HitSkeleton key={i} />
            ))}
            <li className="sr-only" role="status">
              Searching…
            </li>
          </ul>
        )}

        {hardError && (
          <section
            className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-4"
            role="alert"
          >
            <p className="text-sm font-medium text-danger-foreground">
              {error instanceof Error ? error.message : "Search failed."}
            </p>
            <p className="text-xs text-muted-foreground">
              This is a live read — search results are never served from the
              service-worker cache, because a cached result is a claim about the
              archive's contents that may no longer be true.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className={SECONDARY_BUTTON_CLASS}
            >
              Retry
            </button>
          </section>
        )}

        {first && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                {first.total.toLocaleString()}{" "}
                {first.total === 1 ? "result" : "results"} in {Math.round(first.tookMs)} ms
              </p>
              {isFetching && !isFetchingNextPage && (
                <span className="text-xs text-muted-foreground">Refreshing…</span>
              )}
            </div>

            <details className="cw-panel px-4 py-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">
                Query as the index ran it
              </summary>
              <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">
                {first.expression}
              </p>
              <p className="mt-1 text-muted-foreground">
                FTS5 expression for “{first.query}”. Operators are escaped, so
                punctuation is searched literally.
              </p>
            </details>

            {hits.length === 0 ? (
              <div className="space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
                <p className="text-sm font-medium">No captured page matches that.</p>
                <p className="text-xs text-muted-foreground">
                  Pages crawled before the search index existed are invisible here
                  until they are indexed — use “Index this archive” below.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {hits.map((hit, i) => (
                  <HitRow key={`${hit.route}-${hit.ts}-${i}`} hit={hit} query={trimmedQuery} />
                ))}
              </ul>
            )}

            {hasNextPage && (
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className={`${SECONDARY_BUTTON_CLASS} w-full`}
              >
                {isFetchingNextPage
                  ? "Loading…"
                  : `Load ${Math.min(PAGE_SIZE, first.total - hits.length)} more`}
              </button>
            )}
          </>
        )}

        {/* ── Indexing ── */}
        <ReindexPanel domain={domain} month={month} />

        {domainsLoading && (
          <p className="text-xs text-muted-foreground" role="status">
            Loading domains…
          </p>
        )}
      </main>
    </div>
  );
}
