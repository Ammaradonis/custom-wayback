/**
 * DashboardPage — home screen of the app.
 *
 * Phase 3 changes:
 *  - Replace <input type="month"> with the MonthCalendar component.
 *  - Wire domains.coverage() to supply coverage dots.
 *  - Show StorageStatus panel.
 *  - Per-domain calendar state (no shared crawlMonth across domains).
 *  - Skeleton loaders matching the content shape.
 *
 * Phase 4 changes:
 *  - <CostPanel /> for the §11.5 cost/quota/throttle readout.
 *  - Live throttle ("resuming in Ns") and degradedReason in the crawl progress.
 *
 * Phase 5 changes (plan §15):
 *  - Top-bar links to /search and /compare.
 *  - <ExportPanel /> for "download this month as a static bundle".
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Columns3, ExternalLink, LogOut, Search, Share2, X } from "lucide-react";
import {
  domains,
  ingest,
  auth,
  manifests,
  clearToken,
  type DomainEntry,
  type IngestProgressEvent,
} from "@/lib/api.js";
import { MonthCalendar } from "@/components/MonthCalendar.js";
import { StorageStatus } from "@/components/StorageStatus.js";
import { CostPanel } from "@/components/CostPanel.js";
import { FIELD_CLASS } from "@/hooks/useSites.js";
import { fmtMonthLabel } from "@/lib/format.js";
import type { ShareTarget } from "@/components/ShareDialog.js";
import type { DayCoverage } from "@custom-wayback/shared";

/** Lazy: the export panel is below the fold and is not on every visit's path. */
const ExportPanel = lazy(() => import("@/components/ExportPanel.js"));
/**
 * Lazy: sharing is a deliberate action, so the dialog's code is fetched when the
 * button is tapped rather than shipped in the dashboard chunk.
 */
const ShareDialog = lazy(() =>
  import("@/components/ShareDialog.js").then((mod) => ({ default: mod.ShareDialog })),
);

/** The scope a share dialog opens with, remembered at the page level. */
type ShareRequest = ShareTarget | null;

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Re-render once a second while `active` is true so the throttle countdown
 * ("resuming in Ns", plan §12 rule 3) actually ticks down instead of freezing
 * at whatever the last SSE frame said.
 */
function useTick(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Math.floor(Date.now() / 1000);
}

// ── Per-domain state ─────────────────────────────────────────────────────────

interface DomainRowState {
  selectedDay: string | null;
  coverageYear: number;
  coverageMonth: number;
}

function defaultRowState(): DomainRowState {
  const now = new Date();
  return {
    selectedDay: null,
    coverageYear: now.getFullYear(),
    coverageMonth: now.getMonth() + 1,
  };
}

// ── DomainRow ────────────────────────────────────────────────────────────────

interface DomainRowProps {
  entry: DomainEntry;
  rowState: DomainRowState;
  onStateChange: (next: Partial<DomainRowState>) => void;
  onStartCrawl: (domainId: string, month: string) => void;
  onRemove: (domainId: string) => void;
  onShare: (target: ShareTarget) => void;
  isCrawling: boolean;
  navigate: (path: string) => void;
}

function DomainRow({
  entry,
  rowState,
  onStateChange,
  onStartCrawl,
  onRemove,
  onShare,
  isCrawling,
  navigate,
}: DomainRowProps) {
  const { coverageYear, coverageMonth, selectedDay } = rowState;

  // Fetch coverage for the currently-visible month.
  const { data: coverageData, isLoading: coverageLoading } = useQuery<DayCoverage[]>({
    queryKey: ["coverage", entry.id, coverageYear, coverageMonth],
    queryFn: async () => {
      const yearMonthStr = `${coverageYear}-${String(coverageMonth).padStart(2, "0")}`;
      // The coverage endpoint returns string[] of days with captures for a
      // domain. We use the manifest endpoint to get richer DayCoverage data.
      // Fall back to the domains.coverage() array-of-day-strings format if
      // the manifest endpoint is unavailable.
      try {
        const manifest = await manifests.manifest(
          entry.domain,
          yearMonthStr,
        );
        // Aggregate page counts per day from the manifest.
        const countMap: Record<string, number> = {};
        for (const page of manifest.pages) {
          countMap[page.day] = (countMap[page.day] ?? 0) + 1;
        }
        return manifest.days.map((d) => ({
          day: d,
          captureCount: countMap[d] ?? 1,
        }));
      } catch {
        // Fallback: domains.coverage() returns day strings only.
        try {
          const days = await domains.coverage(entry.id);
          return days
            .filter((d) => d.startsWith(`${coverageYear}-${String(coverageMonth).padStart(2, "0")}`))
            .map((d) => ({ day: d, captureCount: 1 }));
        } catch {
          return [];
        }
      }
    },
    staleTime: 1000 * 60 * 5,
  });

  const coverage: DayCoverage[] = coverageData ?? [];

  const selectedMonth = selectedDay
    ? selectedDay.slice(0, 7)
    : `${coverageYear}-${String(coverageMonth).padStart(2, "0")}`;

  // The same query the calendar's dots come from, read as pages — so the share
  // dialog can name the page for the picked day without a second request.
  const { data: manifest } = useQuery({
    queryKey: ["manifest", entry.domain, selectedMonth],
    queryFn: () => manifests.manifest(entry.domain, selectedMonth),
    staleTime: 1000 * 60 * 5,
  });
  const manifestPages = manifest?.pages ?? [];

  return (
    <li className="cw-panel space-y-3 p-4">
      {/* Domain header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{entry.domain}</p>
          {entry.lastCrawledAt && (
            <p className="text-xs text-muted-foreground">
              Last crawled {new Date(entry.lastCrawledAt * 1000).toLocaleDateString()}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(entry.id)}
          className="cw-btn cw-btn-danger cw-btn-icon flex-none"
          aria-label={`Remove ${entry.domain}`}
          title={`Remove ${entry.domain}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* Picker + actions. Wraps on narrow screens so nothing is clipped. */}
      <div className="flex flex-wrap items-center gap-2">
        <MonthCalendar
          domain={entry.domain}
          selectedDay={selectedDay}
          coverage={coverage}
          isLoading={coverageLoading}
          onChange={(day) => onStateChange({ selectedDay: day })}
          onMonthChange={(y, m) => onStateChange({ coverageYear: y, coverageMonth: m })}
          initialYear={coverageYear}
          initialMonth={coverageMonth}
        />

        {/* Crawl month button */}
        <button
          type="button"
          onClick={() => onStartCrawl(entry.id, selectedMonth)}
          disabled={isCrawling}
          className="cw-btn cw-btn-primary"
        >
          {isCrawling ? "Crawling…" : "Crawl month"}
        </button>

        {/* Open viewer (only when a specific day is picked) */}
        {selectedDay && (
          <button
            type="button"
            onClick={() => navigate(`/a/${entry.domain}/${selectedDay}/`)}
            className="cw-btn cw-btn-secondary"
          >
            View <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}

        {/* Share this month, or the picked day's page (plan §15). */}
        <button
          type="button"
          onClick={() => {
            // The manifest for the visible month is already loaded for the
            // calendar, so the share dialog can be scoped to one page without a
            // second request: the shortest URL of the picked day is the page the
            // user is looking at. With no day picked, the link covers the month.
            const pages =
              selectedDay === null
                ? []
                : manifestPages
                    .filter((p) => p.day === selectedDay)
                    .sort((a, b) => a.url.length - b.url.length);
            const page = pages[0];
            onShare({
              domain: entry.domain,
              month: selectedMonth,
              ...(selectedDay ? { day: selectedDay } : {}),
              ...(page ? { url: page.url } : {}),
            });
          }}
          className="cw-btn cw-btn-secondary"
        >
          <Share2 className="h-3.5 w-3.5" aria-hidden />
          Share
        </button>
      </div>

      {/* What the buttons will act on. Without this the toolbar is a row of
        * unlabelled buttons and the user has to infer the scope from a date
        * button, which is exactly the ambiguity that made the old picker feel
        * broken. */}
      <p className="text-xs text-muted-foreground">
        {selectedDay
          ? `Selected ${selectedDay}`
          : `Month ${fmtMonthLabel(selectedMonth)} — no day selected`}
      </p>
    </li>
  );
}

// ── Crawl progress ───────────────────────────────────────────────────────────

/**
 * Live progress for the active crawl.
 *
 * A progress bar that silently stops moving is the failure mode plan §12 rule 3
 * exists to prevent, so an open circuit breaker is shown as an amber "resuming
 * in Ns" line that ticks down, and a degraded finish says why.
 */
function CrawlProgress({ job }: { job: IngestProgressEvent }) {
  const throttle = job.throttle;
  const tick = useTick(throttle?.active === true);
  const resumeIn =
    throttle?.active && throttle.resumeAt !== null
      ? Math.max(0, throttle.resumeAt - tick)
      : null;

  const pagesTotal = job.pagesTotal ?? 0;
  const pagesDone = job.pagesDone ?? 0;
  const pct = pagesTotal > 0 ? Math.round((pagesDone / pagesTotal) * 100) : 0;

  return (
    <>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          Status:{" "}
          <span className="text-foreground font-medium">
            {job.status ?? "—"}
          </span>
          {job.stage && <span className="text-muted-foreground"> · {job.stage}</span>}
          {(job.attempts ?? 0) > 1 && <span> · attempt {job.attempts}</span>}
        </p>
        <p>
          Pages: {pagesDone} / {pagesTotal}
        </p>
        <p>
          Assets: {job.assetsDone ?? 0} / {job.assetsTotal ?? 0}
        </p>
        <p>Stored: {fmt(job.bytesStored ?? 0)}</p>

        {/* Throttle state — never a silent hang (§12 rule 3). */}
        {throttle?.active === true && (
          <p className="text-warning-foreground" role="status" aria-live="polite">
            ⏸ {throttle.message ?? "archive.org is throttling us"}
            {resumeIn !== null && <> — resuming in {resumeIn}s</>}
          </p>
        )}
        {throttle?.active === false && (throttle.consecutive ?? 0) > 0 && (
          <p className="text-warning-foreground">
            {throttle.message ?? `${throttle.consecutive} throttle responses so far`}
          </p>
        )}
        {throttle?.active !== true && (job.ia429Count ?? 0) > 0 && (
          <p className="text-warning-foreground">
            ⚠ archive.org throttling detected ({job.ia429Count} 429s). Backing off…
          </p>
        )}

        {/* Degraded finish — say what was cut short and why. */}
        {job.degradedReason && (
          <p className="text-warning-foreground">Partial result: {job.degradedReason}</p>
        )}
      </div>

      {pagesTotal > 0 && (
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-500"
            role="progressbar"
            aria-label="Crawl progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </>
  );
}

// ── DashboardPage ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobDomainId, setActiveJobDomainId] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<IngestProgressEvent | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareRequest>(null);

  // Per-domain calendar/selection state.
  const [rowStates, setRowStates] = useState<Record<string, DomainRowState>>({});

  function getRowState(id: string): DomainRowState {
    return rowStates[id] ?? defaultRowState();
  }

  function setRowState(id: string, next: Partial<DomainRowState>) {
    setRowStates((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultRowState()), ...next },
    }));
  }

  const { data: domainList = [], isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: domains.list,
  });

  const addDomain = useMutation({
    mutationFn: (rawInput: string) => domains.add(rawInput),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["domains"] });
      setAddInput("");
      setAddError(null);
    },
    onError: (err: Error) => setAddError(err.message),
  });

  const removeDomain = useMutation({
    mutationFn: (id: string) => domains.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  const startCrawl = useMutation({
    mutationFn: ({ domainId, month }: { domainId: string; month: string }) =>
      ingest.start(domainId, month),
    onSuccess: (data, vars) => {
      setActiveJobId(data.id);
      setActiveJobDomainId(vars.domainId);
      setJobProgress(null);

      const es = new EventSource(`/v1/jobs/${data.id}/events`);
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as IngestProgressEvent;
        // The stream now opens with `{ type: "open" }`, which carries no
        // counters — keep the previous frame rather than blanking the panel.
        if (ev.type === "open") return;
        if (ev.type === "progress") setJobProgress(ev);
        if (ev.type === "done") {
          es.close();
          setActiveJobId(null);
          setActiveJobDomainId(null);
          void qc.invalidateQueries({ queryKey: ["domains"] });
          // The month's spend and quota just moved; refresh the cost panel too.
          void qc.invalidateQueries({ queryKey: ["usage"] });
          // Invalidate coverage caches for this domain.
          void qc.invalidateQueries({ queryKey: ["coverage", vars.domainId] });
        }
      };
      es.onerror = () => {
        es.close();
        setActiveJobId(null);
        setActiveJobDomainId(null);
      };
    },
  });

  async function handleLogout() {
    try { await auth.logout(); } catch { /* ignore */ }
    clearToken();
    navigate("/login");
  }

  // A share dialog left open over a domain that has just been removed would offer
  // to share something that no longer exists.
  useEffect(() => {
    if (shareTarget === null) return;
    if (!(domainList as DomainEntry[]).some((d) => d.domain === shareTarget.domain)) {
      setShareTarget(null);
    }
  }, [domainList, shareTarget]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* ── Top bar ──
        * The nav is the part that has to survive 320px. It wraps, and it is
        * allowed to shrink (`min-w-0`): a flex item's default `min-width: auto`
        * means it refuses to go below its content's intrinsic width, which pushed
        * the whole document to 345px on a 320px screen — and because a `fixed`
        * overlay sizes to the document's scroll width, that dragged the calendar's
        * bottom sheet out of alignment with it too. The labels drop below `sm`
        * and the icons carry accessible names, so nothing is lost. */}
      <header
        className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-background/85 px-4 py-2 backdrop-blur-md"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <span className="text-base font-semibold">Custom Wayback</span>
        <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Main">
          {/* Phase 5 surfaces (plan.md §15) — one tap from home (§2.3). */}
          <Link to="/search" className="cw-btn cw-btn-ghost px-2 sm:px-4" aria-label="Search snapshots">
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">Search</span>
          </Link>
          <Link to="/compare" className="cw-btn cw-btn-ghost px-2 sm:px-4" aria-label="Compare months">
            <Columns3 className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">Compare</span>
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="cw-btn cw-btn-ghost px-2 sm:px-4"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </nav>
      </header>

      <main
        className="mx-auto max-w-2xl space-y-8 px-4 py-6"
        style={{ paddingBottom: "calc(2rem + var(--sai-bottom))" }}
      >
        {/* ── Add domain ── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Track a domain</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addDomain.mutate(addInput);
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <label htmlFor="add-domain" className="sr-only">
              Domain or URL to track
            </label>
            <input
              id="add-domain"
              type="text"
              placeholder="samsung.com or https://www.apple.com/iphone"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              className={`${FIELD_CLASS} min-w-0 flex-1`}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="url"
              inputMode="url"
            />
            <button type="submit" disabled={addDomain.isPending} className="cw-btn cw-btn-primary">
              Add
            </button>
          </form>
          {addError && (
            <p className="text-sm text-danger-foreground" role="alert">
              {addError}
            </p>
          )}
        </section>

        {/* ── Domain list ── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Tracked domains</h2>

          {/* Skeletons while loading */}
          {isLoading && (
            <ul className="space-y-3">
              {[1, 2].map((i) => (
                <li key={i} className="h-28 rounded-lg bg-muted animate-pulse" />
              ))}
            </ul>
          )}

          {!isLoading && domainList.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No domains tracked yet. Add one above.
            </p>
          )}

          <ul className="space-y-3">
            {(domainList as DomainEntry[]).map((d) => (
              <DomainRow
                key={d.id}
                entry={d}
                rowState={getRowState(d.id)}
                onStateChange={(next) => setRowState(d.id, next)}
                onStartCrawl={(domainId, month) =>
                  startCrawl.mutate({ domainId, month })
                }
                onRemove={(id) => removeDomain.mutate(id)}
                onShare={setShareTarget}
                isCrawling={
                  (startCrawl.isPending || activeJobId !== null) &&
                  activeJobDomainId === d.id
                }
                navigate={navigate}
              />
            ))}
          </ul>
        </section>

        {/* ── Active job progress ── */}
        {activeJobId && (
          <section className="cw-panel space-y-3 p-4">
            <h2 className="text-sm font-semibold">Crawl in progress…</h2>
            {jobProgress && <CrawlProgress job={jobProgress} />}
          </section>
        )}

        {/* ── Cost & politeness (plan §11.5 / §12) ── */}
        <CostPanel />

        {/* ── Export a month as a static bundle (plan §15) ──
            Lazy: the panel is below the fold and most visits never open it, so
            its 10 KB stays out of the dashboard chunk and is fetched on demand. */}
        <Suspense
          fallback={
            <section className="cw-panel space-y-3 p-4">
              <div className="h-5 w-40 rounded bg-muted animate-pulse" />
              <div className="h-11 rounded bg-muted animate-pulse" />
              <p className="text-xs text-muted-foreground" role="status">
                Loading export tools…
              </p>
            </section>
          }
        >
          <ExportPanel />
        </Suspense>

        {/* ── Storage status ── */}
        <StorageStatus />
      </main>

      {/* ── Share links (plan §15) ── */}
      {shareTarget && (
        <Suspense fallback={null}>
          <ShareDialog
            open
            onOpenChange={(next) => {
              if (!next) setShareTarget(null);
            }}
            target={shareTarget}
          />
        </Suspense>
      )}
    </div>
  );
}
