/**
 * ComparePage — diff two crawled months of one domain (plan.md §15, "Diff two
 * months"; the marketing-research use case).
 *
 * URL: /compare?domain=…&from=YYYY-MM&to=YYYY-MM
 *
 * The design rules that come from the API's own honesty:
 *
 *  - `note` is rendered prominently. It is the "digests are missing, so
 *    'changed' is inferred from size and title — re-crawl to compare exactly"
 *    warning, and a comparison that cannot be exact must say so (plan §2.3,
 *    "Errors are designed").
 *  - `unknown` is a first-class group, not a rounding error. "I did not look" is
 *    not "nothing changed", and the API refuses to conflate them.
 *  - **A per-page diff is fetched only when a row is opened.** The list is two
 *    indexed reads; the diff reads both versions out of R2 and runs a word-level
 *    diff. Fetching it for every row would make the list slow for no benefit.
 *  - `added` rows offer no diff. The page exists only in the later month, so
 *    there is nothing to compare it against; saying that is the honest UI.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import {
  compare,
  type ChangeKind,
  type CompareChange,
  type ComparePageDiff,
} from "@/lib/api.js";
import { fmtBytes, fmtMonthLabel, fmtMonthShort } from "@/lib/format.js";
import {
  FIELD_CLASS,
  crawledMonths,
  useSites,
} from "@/hooks/useSites.js";

/** Group order: structural news first, then edits, then the uncertain. */
const KIND_ORDER: ChangeKind[] = ["added", "removed", "changed", "unknown", "unchanged"];

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "Unchanged",
  unknown: "Unknown",
};

const KIND_STYLE: Record<ChangeKind, { chip: string; dot: string }> = {
  added: { chip: "border-success/40 text-success-foreground", dot: "bg-success" },
  removed: { chip: "border-danger/40 text-danger-foreground", dot: "bg-danger" },
  changed: { chip: "border-warning/40 text-warning-foreground", dot: "bg-warning" },
  unknown: { chip: "border-border text-muted-foreground", dot: "bg-muted-foreground" },
  unchanged: { chip: "border-border text-muted-foreground", dot: "bg-muted" },
};

/** A null title is normal; the URL is the honest fallback, never an empty row. */
function label(change: CompareChange): string {
  return change.title && change.title.trim().length > 0 ? change.title : change.url;
}

// ── Diff rendering ───────────────────────────────────────────────────────────

/**
 * Word-level diff, rendered in the order the API returned it.
 *
 * The segments are **not** concatenated into one string. Each run is its own
 * element so a one-word price change is visible at a glance rather than buried in
 * a wall of body text — which is the entire point of the feature. `ins` and `del`
 * are the semantically correct elements for an inserted and a deleted run, and
 * they carry no HTML from the archive: the text is a React child either way.
 */
function SegmentDiff({ diff, queryDomain }: { diff: ComparePageDiff; queryDomain: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{diff.summary}</span>
        <span>{diff.addedWords.toLocaleString()} words added</span>
        <span>{diff.removedWords.toLocaleString()} words removed</span>
        <span className="tabular-nums">
          {diff.kind} · {queryDomain}
        </span>
      </div>

      {/* The two sides, with availability stated rather than assumed. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {([["From", diff.before], ["To", diff.after]] as const).map(([side, value]) => (
          <div key={side} className="space-y-1 rounded-md border border-border bg-background p-2 text-xs">
            <p className="cw-label">{side}</p>
            {value ? (
              <>
                <p className="truncate text-foreground">{value.title ?? "—"}</p>
                <p className="text-muted-foreground tabular-nums">
                  {value.day} · {value.bytes === null ? "size unknown" : fmtBytes(value.bytes)}
                </p>
                {!value.available && (
                  <p className="text-warning-foreground">Stored copy removed — not read.</p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">Not captured in this month.</p>
            )}
          </div>
        ))}
      </div>

      {diff.truncated && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning-foreground">
          This page was too large for an exact diff, so the comparison stops part
          way through. Treat it as a summary of the beginning of the page, not a
          complete change list.
        </p>
      )}

      {diff.note && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning-foreground">
          {diff.note}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success" /> added
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-danger" /> removed
        </span>
        <span>Segments are shown in document order.</span>
      </div>

      <div className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-card p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {diff.segments.map((segment, i) => {
          if (segment.kind === "added") {
            return (
              <ins
                key={i}
                className="rounded-sm bg-diff-added-surface px-1 text-diff-added-foreground no-underline"
                title="Added"
              >
                {segment.text}
              </ins>
            );
          }
          if (segment.kind === "removed") {
            return (
              <del
                key={i}
                className="rounded-sm bg-diff-removed-surface px-1 text-diff-removed-foreground line-through"
                title="Removed"
              >
                {segment.text}
              </del>
            );
          }
          return <span key={i}>{segment.text}</span>;
        })}
      </div>
    </div>
  );
}

/** Loaded on demand, for the one row the user opened. */
function PageDiff({ domain, from, to, url }: { domain: string; from: string; to: string; url: string }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["compare-page", domain, from, to, url],
    queryFn: () => compare.page({ domain, from, to, url }),
    retry: 0,
  });

  if (isPending) {
    return (
      <div className="space-y-2 border-t border-border px-3 py-3" aria-busy="true">
        <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
        <div className="h-24 w-full rounded bg-muted animate-pulse" />
        <p className="sr-only" role="status">
          Loading the page diff…
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <p className="border-t border-border px-3 py-3 text-xs text-danger-foreground" role="alert">
        {error instanceof Error ? error.message : "Could not load this diff."}
      </p>
    );
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <SegmentDiff diff={data} queryDomain={domain} />
    </div>
  );
}

// ── Change list ──────────────────────────────────────────────────────────────

interface RowProps {
  change: CompareChange;
  domain: string;
  from: string;
  to: string;
  open: boolean;
  onToggle: () => void;
}

function ChangeRow({ change, domain, from, to, open, onToggle }: RowProps) {
  const canDiff = change.kind === "changed";

  return (
    <li className="cw-panel overflow-hidden">
      {canDiff ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40"
        >
          <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${KIND_STYLE[change.kind].dot}`} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{label(change)}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {change.day ?? "day unknown"} · {change.url}
            </span>
            {change.note && (
              <span className="mt-1 block text-xs text-warning-foreground">{change.note}</span>
            )}
          </span>
          <span className="flex-none text-xs text-muted-foreground" aria-hidden>
            {open ? "−" : "+"}
          </span>
        </button>
      ) : (
        <div className="flex items-start gap-3 px-3 py-3">
          <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${KIND_STYLE[change.kind].dot}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{label(change)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {change.day ?? "day unknown"} · {change.url}
            </p>
            {change.kind === "added" && (
              <p className="mt-1 text-xs text-success-foreground">
                Added in {fmtMonthLabel(to)} — not present in {fmtMonthLabel(from)},
                so there is nothing to diff against.
              </p>
            )}
            {change.kind === "removed" && (
              <p className="mt-1 text-xs text-danger-foreground">
                Present in {fmtMonthLabel(from)} but not in {fmtMonthLabel(to)}.
              </p>
            )}
            {change.note && <p className="mt-1 text-xs text-warning-foreground">{change.note}</p>}
          </div>
        </div>
      )}

      {canDiff && open && (
        <PageDiff domain={domain} from={from} to={to} url={change.url} />
      )}
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ComparePage() {
  const { domainList, sites, isLoading } = useSites();
  const [params, setParams] = useSearchParams();

  const urlDomain = params.get("domain") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const selection = useMemo(() => ({ domain: urlDomain, from, to }), [urlDomain, from, to]);

  const [openUrl, setOpenUrl] = useState<string | null>(null);

  const domain = selection.domain;

  const monthsForDomain = useMemo(
    () => crawledMonths(sites, domain || undefined),
    [sites, domain],
  );

  /** Write through to the URL, so the comparison is shareable and back-able. */
  const setSelection = (next: { domain?: string; from?: string; to?: string }) => {
    setOpenUrl(null);
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
      { replace: true },
    );
  };

  // Default the pickers to the two most recent crawled months. Computed here
  // rather than inside an effect so it lands in the first render that has the
  // data: deriving during render and syncing to the URL once is safe because the
  // derived value is a pure function of the domain's crawled months.
  useEffect(() => {
    if (!domain || monthsForDomain.length === 0) return;
    const latest = monthsForDomain[0];
    const previous = monthsForDomain[1];
    if (latest === undefined || previous === undefined) return;
    if (from === latest && to === previous) return;
    if (from !== "" || to !== "") return;
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        merged.set("from", latest);
        merged.set("to", previous);
        return merged;
      },
      { replace: true },
    );
    // `setParams` is stable; re-running on its identity would defeat the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, monthsForDomain, from, to]);

  const canCompare =
    domain !== "" && from !== "" && to !== "" && from !== to && monthsForDomain.length >= 2;

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["compare", domain, from, to],
    queryFn: () => compare.months(domain, from, to),
    enabled: canCompare,
    retry: 0,
    staleTime: 1000 * 60 * 5,
  });

  const grouped = useMemo(() => {
    const groups = new Map<ChangeKind, CompareChange[]>();
    for (const change of data?.changes ?? []) {
      const bucket = groups.get(change.kind);
      if (bucket) bucket.push(change);
      else groups.set(change.kind, [change]);
    }
    return groups;
  }, [data]);

  const summaryChips: Array<{ kind: ChangeKind; value: number }> = data
    ? [
        { kind: "added", value: data.counts.added },
        { kind: "removed", value: data.counts.removed },
        { kind: "changed", value: data.counts.changed },
        { kind: "unknown", value: data.counts.unknown },
      ]
    : [];

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header
        className="sticky top-0 z-10 border-b border-border bg-background/85 px-4 py-2 backdrop-blur-md"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <div className="mx-auto flex min-w-0 max-w-2xl items-center justify-between gap-3">
          <h1 className="truncate text-base font-semibold">
            Compare<span className="hidden sm:inline"> months</span>
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
        {/* ── Pickers ──
          * From/To are selects over the months actually crawled for the chosen
          * domain, not native `<input type="month">` pickers. Two reasons: a
          * native month picker let you choose months that cannot be compared and
          * then silently did nothing, and as a native control it was themed by the
          * platform rather than the app. */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="cmp-domain" className="cw-label">
              Domain
            </label>
            <select
              id="cmp-domain"
              value={domain}
              onChange={(e) => setSelection({ domain: e.target.value, from: "", to: "" })}
              className={`${FIELD_CLASS} w-full`}
            >
              <option value="">Pick a domain…</option>
              {domainList.map((entry) => (
                <option key={entry.id} value={entry.domain}>
                  {entry.domain}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="cmp-from" className="cw-label">
              From
            </label>
            <select
              id="cmp-from"
              value={from}
              onChange={(e) => setSelection({ from: e.target.value })}
              className={`${FIELD_CLASS} w-full`}
              disabled={monthsForDomain.length === 0}
            >
              <option value="">{monthsForDomain.length === 0 ? "No months" : "Pick a month…"}</option>
              {monthsForDomain.map((m) => (
                <option key={m} value={m}>
                  {fmtMonthShort(m)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="cmp-to" className="cw-label">
              To
            </label>
            <select
              id="cmp-to"
              value={to}
              onChange={(e) => setSelection({ to: e.target.value })}
              className={`${FIELD_CLASS} w-full`}
              disabled={monthsForDomain.length === 0}
            >
              <option value="">{monthsForDomain.length === 0 ? "No months" : "Pick a month…"}</option>
              {monthsForDomain.map((m) => (
                <option key={m} value={m}>
                  {fmtMonthShort(m)}
                </option>
              ))}
            </select>
          </div>
        </section>

        {monthsForDomain.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {monthsForDomain.length} crawled {monthsForDomain.length === 1 ? "month" : "months"} for{" "}
            <span className="text-foreground">{domain}</span>:{" "}
            {monthsForDomain.map((m) => fmtMonthLabel(m)).join(", ")}.
          </p>
        )}

        {domain !== "" && monthsForDomain.length === 1 && (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            Only {fmtMonthLabel(monthsForDomain[0] ?? "")} has been crawled for this
            domain, so there is nothing to compare it with yet. Crawl a second month
            and the two most recent will be picked here automatically.
          </p>
        )}

        {domain === "" && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Pick a domain to see what changed between two crawled months.
          </p>
        )}

        {from !== "" && from === to && (
          <p className="text-xs text-warning-foreground" role="status">
            Pick two different months — comparing a month with itself has no answer.
          </p>
        )}

        {/* ── Result ── */}
        {canCompare && isPending && (
          <div className="space-y-3" aria-busy="true">
            <div className="flex gap-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-14 w-20 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
            ))}
            <p className="sr-only" role="status">
              Comparing the two months…
            </p>
          </div>
        )}

        {canCompare && isError && (
          <section className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-4" role="alert">
            <p className="text-sm font-medium text-danger-foreground">
              {error instanceof Error ? error.message : "Comparison failed."}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="cw-btn cw-btn-secondary"
            >
              Retry
            </button>
          </section>
        )}

        {data && (
          <>
            {/* The warning that stops "changed" from being read as exact. */}
            {data.note && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground" role="status">
                {data.note}
              </p>
            )}
            {!data.hasDigests && !data.note && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
                No content digests on either side, so differences are inferred rather
                than compared byte for byte.
              </p>
            )}

            <section className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {summaryChips.map((chip) => (
                  <div
                    key={chip.kind}
                    className={`rounded-lg border bg-card p-3 ${KIND_STYLE[chip.kind].chip}`}
                  >
                    <p className="cw-label text-current">{KIND_LABEL[chip.kind]}</p>
                    <p className="text-xl font-semibold tabular-nums">{chip.value.toLocaleString()}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
                <span>
                  {fmtMonthLabel(data.from)}: {data.totalPages.from.toLocaleString()} pages
                </span>
                <span>
                  {fmtMonthLabel(data.to)}: {data.totalPages.to.toLocaleString()} pages
                </span>
                <span>{data.counts.unchanged.toLocaleString()} unchanged</span>
              </div>

              <p className="text-xs text-muted-foreground">
                A page is compared using its last capture in each month. Open a{" "}
                <span className="font-medium text-warning-foreground">changed</span> row
                for the word-level diff; added and removed rows have only one side to show.
              </p>
            </section>

            {data.changes.length === 0 && (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Nothing changed between {fmtMonthLabel(data.from)} and{" "}
                {fmtMonthLabel(data.to)}: {data.counts.unchanged.toLocaleString()} pages
                are identical
                {data.hasDigests ? "" : " by size and title"}.
              </p>
            )}

            {KIND_ORDER.map((kind) => {
              const rows = grouped.get(kind);
              if (!rows || rows.length === 0) return null;
              return (
                <section key={kind} className="space-y-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <span className={`h-2 w-2 rounded-full ${KIND_STYLE[kind].dot}`} aria-hidden />
                    {KIND_LABEL[kind]}
                    <span className="font-normal tabular-nums text-muted-foreground">
                      {rows.length.toLocaleString()}
                    </span>
                  </h2>
                  <ul className="space-y-2">
                    {rows.slice(0, 200).map((change) => (
                      <ChangeRow
                        key={`${change.kind}-${change.url}`}
                        change={change}
                        domain={data.domain}
                        from={data.from}
                        to={data.to}
                        open={openUrl === change.url}
                        onToggle={() =>
                          setOpenUrl((prev) => (prev === change.url ? null : change.url))
                        }
                      />
                    ))}
                  </ul>
                  {rows.length > 200 && (
                    <p className="text-xs text-muted-foreground">
                      Showing the first 200 of {rows.length.toLocaleString()} rows in
                      this group.
                    </p>
                  )}
                </section>
              );
            })}
          </>
        )}

        {isLoading && <p className="text-xs text-muted-foreground" role="status">Loading domains…</p>}
      </main>
    </div>
  );
}
