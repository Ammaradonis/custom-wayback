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
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
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
import type { DayCoverage } from "@custom-wayback/shared";

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
  isCrawling: boolean;
  navigate: (path: string) => void;
}

function DomainRow({
  entry,
  rowState,
  onStateChange,
  onStartCrawl,
  onRemove,
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

  return (
    <li className="rounded-lg border border-border p-4 space-y-3">
      {/* Domain header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{entry.domain}</p>
          {entry.lastCrawledAt && (
            <p className="text-xs text-muted-foreground">
              Last crawled {new Date(entry.lastCrawledAt * 1000).toLocaleDateString()}
            </p>
          )}
        </div>
        <button
          onClick={() => onRemove(entry.id)}
          className="h-9 w-9 flex-none rounded-md text-muted-foreground hover:text-red-400 transition-colors"
          aria-label={`Remove ${entry.domain}`}
        >
          ✕
        </button>
      </div>

      {/* Calendar picker */}
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
          onClick={() => onStartCrawl(entry.id, selectedMonth)}
          disabled={isCrawling}
          className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:opacity-50 transition-opacity"
        >
          {isCrawling ? "Crawling…" : "Crawl month"}
        </button>

        {/* Open viewer (only when a specific day is picked) */}
        {selectedDay && (
          <button
            onClick={() => navigate(`/a/${entry.domain}/${selectedDay}/`)}
            className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            View ↗
          </button>
        )}
      </div>
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
          <p className="text-amber-300" role="status" aria-live="polite">
            ⏸ {throttle.message ?? "archive.org is throttling us"}
            {resumeIn !== null && <> — resuming in {resumeIn}s</>}
          </p>
        )}
        {throttle?.active === false && (throttle.consecutive ?? 0) > 0 && (
          <p className="text-amber-300/80">
            {throttle.message ?? `${throttle.consecutive} throttle responses so far`}
          </p>
        )}
        {throttle?.active !== true && (job.ia429Count ?? 0) > 0 && (
          <p className="text-yellow-400">
            ⚠ archive.org throttling detected ({job.ia429Count} 429s). Backing off…
          </p>
        )}

        {/* Degraded finish — say what was cut short and why. */}
        {job.degradedReason && (
          <p className="text-amber-300">Partial result: {job.degradedReason}</p>
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

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* ── Top bar ── */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-4 py-3 backdrop-blur-sm"
        style={{ paddingTop: "calc(0.75rem + var(--sai-top))" }}
      >
        <span className="font-semibold text-base">Custom Wayback</span>
        <button
          onClick={handleLogout}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-8 space-y-8"
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
            className="flex gap-2"
          >
            <input
              type="text"
              placeholder="samsung.com or https://www.apple.com/iphone"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              className="flex-1 h-11 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="url"
              inputMode="url"
            />
            <button
              type="submit"
              disabled={addDomain.isPending}
              className="h-11 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground disabled:opacity-50 transition-opacity"
            >
              Add
            </button>
          </form>
          {addError && (
            <p className="text-sm text-red-400" role="alert">{addError}</p>
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
          <section className="rounded-lg border border-border p-4 space-y-3">
            <h2 className="font-semibold text-sm">Crawl in progress…</h2>
            {jobProgress && <CrawlProgress job={jobProgress} />}
          </section>
        )}

        {/* ── Cost & politeness (plan §11.5 / §12) ── */}
        <CostPanel />

        {/* ── Storage status ── */}
        <StorageStatus />
      </main>
    </div>
  );
}
