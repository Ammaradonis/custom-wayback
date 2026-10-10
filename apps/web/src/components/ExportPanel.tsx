/**
 * ExportPanel — a month of a site as a self-contained static bundle
 * (plan.md §15, "Snapshot export as a static ZIP").
 *
 * The product sentence: *"Hand a self-contained month of a site to a colleague, or
 * archive it yourself with no dependency on this tool."* Two consequences shape
 * this panel:
 *
 *  - **`missing` is displayed prominently whenever it is non-zero.** It is the
 *    number of pages the bundle could not include because their stored copy had
 *    already been purged (the post-serve purge is deliberate, see `ViewerPage`).
 *    Somebody is about to hand this file to another person; an export that is
 *    quietly partial is worse than one that says so.
 *  - **The build is polled, and a stalled build says so.** `GET /v1/export/:id`
 *    reports `building` while the Worker is still reading R2, so the panel polls
 *    while that is the status — and stops claiming progress after a bounded number
 *    of attempts rather than spinning behind a bar that will never move (§12
 *    rule 3: never a silent hang).
 *
 * History: the API has no "list my exports" route (it is not in the contract), so
 * the panel remembers the ids it started, in `localStorage`, and re-fetches each
 * one by id. A remembered export that has been deleted server-side drops out on
 * its own, and a `deleted` record is kept — it is the receipt that says the
 * artifact existed and was deliberately removed.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  exports as exportsApi,
  type ExportRecord,
  type ExportStatus,
} from "@/lib/api.js";
import { fmtBytes, fmtMonthLabel, fmtUnixTime } from "@/lib/format.js";
import {
  FIELD_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  crawledMonths,
  useSites,
} from "@/hooks/useSites.js";

const HISTORY_KEY = "cw_exports_v1";
/** Names of exports this browser started. Ids only; the ledger is the truth. */
const HISTORY_LIMIT = 20;
/** How many times we poll one build before telling the user it looks stalled. */
const POLL_SECONDS = 2.5;
const MAX_POLLS = 40;

const STATUS_STYLE: Record<ExportStatus, string> = {
  building: "border-border text-muted-foreground",
  ready: "border-success/40 text-success-foreground",
  failed: "border-danger/40 text-danger-foreground",
  deleted: "border-border text-muted-foreground",
};

// ── History (client-side only; the API exposes no list route) ────────────────

interface HistoryEntry {
  id: string;
  domain: string;
  month: string;
  createdAt: number;
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: HistoryEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (
        typeof entry["id"] === "string" &&
        typeof entry["domain"] === "string" &&
        typeof entry["month"] === "string"
      ) {
        out.push({
          id: entry["id"],
          domain: entry["domain"],
          month: entry["month"],
          createdAt: typeof entry["createdAt"] === "number" ? entry["createdAt"] : 0,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeHistory(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Private mode / quota: history is a convenience, never a requirement.
  }
}

/** When this export was created, whichever spelling the API used. */
function createdStamp(record: ExportRecord): number {
  return record.createdAt ?? record.created_at ?? 0;
}

/** The failure text, whichever spelling the API used. */
function errorText(record: ExportRecord): string | null {
  return record.error ?? record.error_message ?? null;
}

/**
 * One export row, refreshed while it is building.
 *
 * `enabled` stops an idle panel from polling; the attempt counter stops a build
 * that *never* reports a result from polling forever. The counter is bumped in the
 * effect rather than inside `queryFn`, so a request that fails counts as an attempt
 * too — otherwise a persistently failing export would poll until the tab closed.
 */
function useExportRecord(id: string | null, enabled: boolean) {
  const active = enabled && id !== null;
  const pollsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  if (pollsRef.current === 0 && active) pollsRef.current = 1;

  const query = useQuery({
    queryKey: ["export", id, attempt],
    enabled: active,
    retry: 0,
    staleTime: 0,
    queryFn: () => {
      if (id === null) throw new Error("No export id");
      return exportsApi.status(id);
    },
  });

  const status = query.data?.status;
  const stalled = active && pollsRef.current >= MAX_POLLS;

  useEffect(() => {
    if (!active || status !== "building" || stalled) return;
    const timer = window.setTimeout(() => {
      pollsRef.current += 1;
      setAttempt((n) => n + 1);
    }, POLL_SECONDS * 1000);
    return () => window.clearTimeout(timer);
  }, [active, status, stalled, query.dataUpdatedAt, attempt]);

  return { ...query, polls: pollsRef.current, stalled };
}

// ── Presentational pieces ────────────────────────────────────────────────────

function StatusChip({ status }: { status: ExportStatus }) {
  return (
    <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

/** The one warning this panel exists to make impossible to miss. */
function MissingNotice({ record }: { record: ExportRecord }) {
  if (record.missing <= 0) return null;
  return (
    <p
      className="rounded-md border border-warning/50 bg-warning/10 p-2 text-xs text-warning-foreground"
      role="status"
    >
      <strong className="font-semibold">
        Incomplete bundle: {record.missing.toLocaleString()}{" "}
        {record.missing === 1 ? "page" : "pages"} could not be included.
      </strong>{" "}
      Their stored copies were removed by the post-serve purge, so they are not in
      the zip. Crawl {fmtMonthLabel(record.month)} again to rebuild them.
    </p>
  );
}

/** pages / assets / bytes, plus `missing` when it is non-zero. */
function ExportNumbers({ record }: { record: ExportRecord }) {
  const stats: Array<[string, string]> = [
    ["Pages", record.pages.toLocaleString()],
    ["Assets", record.assets.toLocaleString()],
    ["Size", fmtBytes(record.bytes)],
  ];
  if (record.missing > 0) stats.push(["Missing", record.missing.toLocaleString()]);

  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {stats.map(([name, value]) => (
        <div
          key={name}
          className={`rounded-md border p-2 ${name === "Missing" ? "border-warning/50" : "border-border"}`}
        >
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{name}</dt>
          <dd className={`font-medium tabular-nums ${name === "Missing" ? "text-warning-foreground" : ""}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One history row: status, size, and the actions for that status. */
function HistoryRow({
  entry,
  poll,
  onDelete,
  onSelect,
}: {
  entry: HistoryEntry;
  /** False when the active panel already polls this same export. */
  poll: boolean;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { data, isPending, isError, error } = useExportRecord(entry.id, poll);
  const record = data;
  const gone = isError && error instanceof ApiError && error.status === 404;

  // A 404 means the record is gone server-side; the row is noise, so it is not
  // rendered. Any other error is shown, because a silent gap in a history list
  // reads as "it was never there". Every hook above runs before this return, so
  // the hook order is the same on every render either way.
  if (gone) return null;

  return (
    <li className="cw-panel space-y-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onSelect(entry.id)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium">
            {entry.domain} · {fmtMonthLabel(entry.month)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {record ? `created ${fmtUnixTime(createdStamp(record))}` : "loading…"}
          </span>
        </button>
        {record && <StatusChip status={record.status} />}
      </div>

      {isPending && <div className="h-10 rounded bg-muted animate-pulse" />}

      {isError && !gone && (
        <p className="text-xs text-danger-foreground">
          {error instanceof Error ? error.message : "Could not read this export."}
        </p>
      )}

      {record && (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {record.pages.toLocaleString()} pages · {record.assets.toLocaleString()} assets ·{" "}
            {fmtBytes(record.bytes)}
            {record.missing > 0 && (
              <span className="text-warning-foreground"> · {record.missing.toLocaleString()} missing</span>
            )}
          </p>
          {record.status === "failed" && errorText(record) && (
            <p className="text-xs text-danger-foreground">{errorText(record)}</p>
          )}
          {record.missing > 0 && <MissingNotice record={record} />}
          <div className="flex flex-wrap gap-2">
            {record.status === "ready" && (
              <a
                href={exportsApi.downloadUrl(record.id)}
                download
                className="cw-btn cw-btn-secondary"
              >
                Download zip
              </a>
            )}
            {record.status !== "deleted" && (
              <button
                type="button"
                onClick={() => onDelete(record.id)}
                className="h-11 rounded-md border border-border px-3 text-sm text-danger-foreground hover:text-danger-foreground transition-colors"
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ExportPanel() {
  return <ExportPanelInner />;
}

/** Default export so the dashboard can `lazy()` the panel without a wrapper. */
export default ExportPanel;

function ExportPanelInner() {
  const qc = useQueryClient();
  const { domainList, sites, isLoading } = useSites();

  const [domain, setDomain] = useState("");
  const [month, setMonth] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const monthsForDomain = useMemo(
    () => crawledMonths(sites, domain || undefined),
    [sites, domain],
  );

  // Default to the newest crawled month of the first tracked domain, once the
  // lists have arrived. Derived from data, so it never overrides a user choice.
  useEffect(() => {
    if (domain === "" && domainList.length > 0) {
      const first = domainList[0];
      if (first) setDomain(first.domain);
      return;
    }
    if (domain !== "" && month === "") {
      const latest = monthsForDomain[0];
      if (latest) setMonth(latest);
    }
  }, [domain, month, domainList, monthsForDomain]);

  const remember = (record: ExportRecord) => {
    setHistory((prev) => {
      const next = [
        { id: record.id, domain: record.domain, month: record.month, createdAt: createdStamp(record) },
        ...prev.filter((entry) => entry.id !== record.id),
      ].slice(0, HISTORY_LIMIT);
      writeHistory(next);
      return next;
    });
  };

  const startExport = useMutation({
    mutationFn: ({ domain: d, month: m }: { domain: string; month: string }) =>
      exportsApi.start(d, m),
    onSuccess: (record) => {
      setStartError(null);
      setSelectedId(record.id);
      remember(record);
      // Seed every attempt-variant of this export's key, so the row shows the
      // finished numbers the 202 body already carries instead of a spinner.
      qc.setQueriesData({ queryKey: ["export", record.id] }, record);
    },
    onError: (err: Error) => {
      // The API's 409/413 bodies carry a `message` written for this exact
      // situation ("all pages have already been removed", "over the ceiling"),
      // and `request` already prefers it.
      setStartError(err.message);
    },
  });

  const removeExport = useMutation({
    mutationFn: (id: string) => exportsApi.remove(id),
    onSuccess: (result, id) => {
      // `DELETE` keeps the record and flips its status. Patching the cache from
      // the response is immediate and cannot resurrect a stale `ready` row the way
      // a refetch of an old snapshot could. A partial key matches every attempt
      // variant of this export's entry.
      qc.setQueriesData({ queryKey: ["export", id] }, (previous: ExportRecord | undefined) =>
        previous
          ? { ...previous, status: (result.status as ExportStatus | undefined) ?? "deleted" }
          : previous,
      );
      void qc.invalidateQueries({ queryKey: ["export", id] });
    },
    onError: (err: Error) => setStartError(err.message),
  });

  const active = useExportRecord(selectedId, selectedId !== null);
  const activeRecord = active.data;

  return (
    <section className="cw-panel space-y-4 p-4" aria-labelledby="export-panel-h">
      <div>
        <h2 id="export-panel-h" className="text-base font-semibold">
          Export a month
        </h2>
        <p className="text-xs text-muted-foreground">
          A self-contained zip of every stored page and asset, with relative links,
          an index page and a README. It keeps working with no dependency on this
          app.
        </p>
      </div>

      {/* ── Scope ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="export-domain" className="cw-label">
            Domain
          </label>
          <select
            id="export-domain"
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setMonth("");
              setSelectedId(null);
            }}
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
          <label htmlFor="export-month" className="cw-label">
            Month
          </label>
          {/* Select, not `<input type="month">`: a bundle can only be built for a
            * month that was crawled, so offering any other month is offering an
            * action that cannot work. */}
          <select
            id="export-month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={`${FIELD_CLASS} w-full`}
            disabled={domain === "" || monthsForDomain.length === 0}
          >
            <option value="">
              {domain === ""
                ? "Pick a domain first"
                : monthsForDomain.length === 0
                  ? "Nothing crawled"
                  : "Pick a month…"}
            </option>
            {monthsForDomain.map((m) => (
              <option key={m} value={m}>
                {fmtMonthLabel(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {domain !== "" && monthsForDomain.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Crawled: {monthsForDomain.map((m) => fmtMonthLabel(m)).join(", ")}
        </p>
      )}

      <button
        type="button"
        onClick={() => startExport.mutate({ domain, month })}
        disabled={startExport.isPending || domain === "" || month === ""}
        className={`${PRIMARY_BUTTON_CLASS} w-full`}
      >
        {startExport.isPending ? "Building the bundle…" : "Build zip"}
      </button>

      {startExport.isPending && (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          Reading every stored page and asset for {fmtMonthLabel(month)}. A large
          month takes a little while; nothing is downloaded to your device until you
          ask for it.
        </p>
      )}

      {startError && (
        <p className="text-xs text-danger-foreground" role="alert">
          {startError}
        </p>
      )}

      {/* ── Active build ── */}
      {selectedId !== null && (
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          {active.isPending && (
            <div className="space-y-2" aria-busy="true">
              <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
              <div className="h-12 rounded bg-muted animate-pulse" />
              <p className="sr-only" role="status">
                Loading export status…
              </p>
            </div>
          )}

          {active.isError && (
            <p className="text-xs text-danger-foreground" role="alert">
              {active.error instanceof Error
                ? active.error.message
                : "Could not read the export status."}
            </p>
          )}

          {activeRecord && (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {activeRecord.domain} · {fmtMonthLabel(activeRecord.month)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {activeRecord.status === "building"
                      ? `Building… (checked ${active.polls}×)`
                      : `Finished ${fmtUnixTime(activeRecord.finishedAt ?? activeRecord.finished_at ?? null)}`}
                  </p>
                </div>
                <StatusChip status={activeRecord.status} />
              </div>

              {activeRecord.status === "building" && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                </div>
              )}

              {active.stalled && activeRecord.status === "building" && (
                <p className="text-xs text-warning-foreground" role="status">
                  This build has not reported a result after {MAX_POLLS} checks. It may
                  have been interrupted mid-request — the record stays here, and
                  starting the export again is safe and cheap to retry.
                </p>
              )}

              <ExportNumbers record={activeRecord} />

              {activeRecord.status === "failed" && errorText(activeRecord) && (
                <p className="text-xs text-danger-foreground" role="alert">
                  {errorText(activeRecord)}
                </p>
              )}

              <MissingNotice record={activeRecord} />

              <div className="flex flex-wrap gap-2">
                {activeRecord.status === "ready" && (
                  <a
                    href={exportsApi.downloadUrl(activeRecord.id)}
                    download
                    className="flex h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground"
                  >
                    Download zip
                  </a>
                )}
                {activeRecord.status !== "deleted" && (
                  <button
                    type="button"
                    onClick={() => removeExport.mutate(activeRecord.id)}
                    disabled={removeExport.isPending}
                    className={`${SECONDARY_BUTTON_CLASS} text-danger-foreground`}
                  >
                    Delete bundle
                  </button>
                )}
                {activeRecord.status === "deleted" && (
                  <p className="text-xs text-muted-foreground">
                    The artifact was removed from storage. The record is kept so you can
                    see it existed; build it again any time.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── History ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Past exports</h3>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Exports you start from this device are listed here, with their status and
            completeness.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                poll={entry.id !== selectedId}
                onDelete={(id) => removeExport.mutate(id)}
                onSelect={(id) => setSelectedId(id)}
              />
            ))}
          </ul>
        )}
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground" role="status">
          Loading domains…
        </p>
      )}
    </section>
  );
}
