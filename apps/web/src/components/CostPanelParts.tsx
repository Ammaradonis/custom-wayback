/**
 * Presentational rows for <CostPanel> (plan.md §11.5).
 *
 * Split out of CostPanel.tsx to keep each file small; these components hold no
 * state and no data fetching, so they are trivially reusable and reviewable.
 *
 * Money formatting rule (the reason this panel exists): a non-zero amount below
 * a cent reads "< $0.01", never "$0.00".
 */

import type { BudgetStatus, CostLine, DomainCost, UsageReport } from "@/lib/api.js";
import { fmtBytes, fmtCount, fmtDurationMs, fmtUsd } from "@/lib/format.js";

// ── Budget state presentation ────────────────────────────────────────────────

const BUDGET_STYLES: Record<BudgetStatus["state"], { bar: string; text: string }> = {
  ok: { bar: "bg-accent", text: "text-muted-foreground" },
  warn: { bar: "bg-amber-400", text: "text-amber-300" },
  exceeded: { bar: "bg-red-500", text: "text-red-400" },
  disabled: { bar: "bg-muted-foreground", text: "text-muted-foreground" },
};

/** One `label … value` line, right-aligned and tabular so columns line up. */
export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-right">{value}</span>
    </div>
  );
}

// ── Budget ───────────────────────────────────────────────────────────────────

export function BudgetBlock({ budget }: { budget: BudgetStatus }) {
  const style = BUDGET_STYLES[budget.state];
  const pct = Math.max(0, Math.min(100, Math.round(budget.fraction * 100)));

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Budget</span>
        <span className={`font-medium tabular-nums ${style.text}`}>
          {budget.state === "disabled"
            ? `${fmtUsd(budget.spentUsd)} spent`
            : `${fmtUsd(budget.spentUsd)} / ${fmtUsd(budget.budgetUsd)}`}
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${style.bar}`}
          role="progressbar"
          aria-label="Monthly budget used"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${pct}% of the monthly budget`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {budget.state === "disabled" && (
        <p className="text-xs text-muted-foreground">
          No budget is set, so spend is not capped. Set{" "}
          <code className="rounded bg-muted px-1">MONTHLY_BUDGET_USD</code> on the API worker to
          enforce one.
        </p>
      )}

      {budget.state === "warn" && (
        <p className="text-xs text-amber-300">
          {pct}% of the monthly budget is spent — {fmtUsd(budget.remainingUsd)} left.
        </p>
      )}

      {budget.state === "exceeded" && (
        <p className="text-xs text-red-400">
          Budget exhausted: {fmtUsd(budget.spentUsd)} of {fmtUsd(budget.budgetUsd)}.
          {budget.crawlsBlocked && (
            <>
              {" "}
              <strong className="font-semibold">New crawls are refused</strong> until the month
              rolls over or <code className="rounded bg-muted px-1">MONTHLY_BUDGET_USD</code> is
              raised on the API worker.
            </>
          )}
        </p>
      )}

      {budget.state === "ok" && (
        <p className="text-xs text-muted-foreground">
          {fmtUsd(budget.remainingUsd)} of {fmtUsd(budget.budgetUsd)} left this month.
        </p>
      )}
    </div>
  );
}

// ── Per-kind ─────────────────────────────────────────────────────────────────

/** `"bytes_stored"` → `"bytes stored (bytes)"`, so a row names kind and unit. */
function prettyKind(kind: string, unit: string): string {
  return `${kind.replace(/_/g, " ")} (${unit})`;
}

export function KindRow({ line }: { line: CostLine }) {
  const perUnit = line.units > 0 ? line.costUsd / line.units : 0;
  return (
    <li className="py-1.5 space-y-0.5 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate">{prettyKind(line.kind, line.unit)}</span>
        <span className="tabular-nums text-right">{fmtUsd(line.costUsd)}</span>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {fmtCount(line.units)} used · {fmtCount(line.freeUnits)} free allowance
        {line.billableUnits > 0 && <> · {fmtCount(line.billableUnits)} billable</>}
        {perUnit > 0 && <> · {fmtUsd(perUnit)}/unit</>}
      </p>
    </li>
  );
}

// ── Per-domain ───────────────────────────────────────────────────────────────

export function DomainRow({ entry }: { entry: DomainCost }) {
  const label = entry.domain === "(shared)" ? "shared / platform" : entry.domain;
  return (
    <li className="py-2 space-y-1 border-b border-border last:border-b-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate font-medium">{label}</span>
        <span className="tabular-nums">{fmtUsd(entry.totalUsd)}</span>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {fmtBytes(entry.bytesStored)} stored · {fmtCount(entry.iaFetches)} archive.org fetches
        {entry.throttleEvents > 0 && (
          <>
            {" · "}
            {fmtCount(entry.throttleEvents)}{" "}
            {entry.throttleEvents === 1 ? "throttle event" : "throttle events"}
          </>
        )}
      </p>
    </li>
  );
}

// ── Quota ────────────────────────────────────────────────────────────────────

export function QuotaBlock({ quota }: { quota: UsageReport["quota"] }) {
  const pct =
    quota.limit > 0
      ? Math.max(0, Math.min(100, Math.round((quota.used / quota.limit) * 100)))
      : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Crawls today</span>
        <span className="font-medium tabular-nums">
          {fmtCount(quota.used)} / {fmtCount(quota.limit)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          role="progressbar"
          aria-label="Daily crawl quota used"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${quota.used} of ${quota.limit} crawls used today`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {quota.remaining > 0 ? `${fmtCount(quota.remaining)} left today` : "No crawls left today"}
        {" · resets "}
        {new Date(quota.resetsAt * 1000).toLocaleString()}
      </p>
    </div>
  );
}

// ── Throttle ─────────────────────────────────────────────────────────────────

export function ThrottleBlock({ throttle }: { throttle: UsageReport["throttle"] }) {
  const statuses = Object.entries(throttle.byStatus).sort(([, a], [, b]) => b - a);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">archive.org throttling</span>
        <span className="font-medium tabular-nums">{fmtCount(throttle.events)}</span>
      </div>

      {throttle.events === 0 ? (
        <p className="text-xs text-muted-foreground">
          archive.org has not throttled us this month.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Waited {fmtDurationMs(throttle.totalWaitMs)} in total
          {statuses.length > 0 && (
            <>
              {" · "}
              {statuses.map(([status, count]) => `${status}×${fmtCount(count)}`).join(", ")}
            </>
          )}
        </p>
      )}

      {throttle.events > 0 && throttle.lastEventAt !== null && (
        <p className="text-xs text-muted-foreground">
          Last throttled {new Date(throttle.lastEventAt * 1000).toLocaleString()}. Backing off on
          request is the polite answer, not a fault (plan §12).
        </p>
      )}
    </div>
  );
}
