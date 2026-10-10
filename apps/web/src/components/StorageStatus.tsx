/**
 * StorageStatus — displays device cache size and persistent-storage status.
 *
 * Shows:
 *  - Archive cache bytes used by the SW LRU (≤ 25 MB).
 *  - Total browser quota / usage for this origin.
 *  - A "Request persistent storage" button on Android (iOS ignores it).
 *
 * Per plan §9.2: "Request persistent storage when available … and degrade
 * silently when unsupported."
 */

import { RefreshCw } from "lucide-react";
import { useStorage } from "@/hooks/useStorage.js";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

export function StorageStatus() {
  const {
    quota,
    usage,
    archiveBytes,
    archiveEntries,
    isPersistent,
    requestPersist,
    refresh,
  } = useStorage();

  const archiveMB = archiveBytes / (1024 * 1024);
  const archivePct = Math.min(100, (archiveMB / 25) * 100);
  const hasSwController =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    navigator.serviceWorker.controller !== null;

  return (
    <details className="cw-panel text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 select-none">
        <span className="font-medium">Device cache</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {hasSwController
            ? `${fmtBytes(archiveBytes)} / 25 MB`
            : "SW not active yet"}
        </span>
      </summary>

      <div className="space-y-3 border-t border-border px-4 pt-3 pb-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Archive pages {hasSwController ? `(${archiveEntries} entries)` : ""}
          </span>
          <button
            type="button"
            data-compact
            onClick={refresh}
            className="cw-btn cw-btn-ghost cw-btn-icon"
            aria-label="Refresh storage stats"
            title="Refresh storage stats"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {/* Archive cache bar */}
        {hasSwController ? (
          <>
            <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{fmtBytes(archiveBytes)}</span>
              <span>25 MB cap</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${archivePct}%` }}
                role="progressbar"
                aria-label="Archive cache used"
                aria-valuenow={Math.round(archivePct)}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Service worker not yet controlling this page. Reload once after first install.
          </p>
        )}

        {/* Origin quota */}
        <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>Origin storage</span>
          <span>
            {fmtBytes(usage)} / {fmtBytes(quota)}
          </span>
        </div>

        {/* Persistent storage */}
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            Persistent:{" "}
            <span
              className={
                isPersistent ? "font-medium text-success-foreground" : "font-medium text-warning-foreground"
              }
            >
              {isPersistent ? "granted" : "not granted"}
            </span>
          </span>
          {!isPersistent && (
            <button
              type="button"
              data-compact
              onClick={() => void requestPersist()}
              className="cw-btn cw-btn-secondary h-8 min-h-8 px-2 text-xs"
            >
              Request
            </button>
          )}
        </div>
        {!isPersistent && (
          <p className="text-xs text-muted-foreground">
            iOS evicts non-persistent storage after 7 days of inactivity.
          </p>
        )}
      </div>
    </details>
  );
}
