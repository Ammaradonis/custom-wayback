/**
 * CostPanel — the money and throttle surface for plan.md §11.5/§12.
 *
 * It is deliberately an honesty surface, not an error report:
 *  - metered and plan-floor costs are shown separately so the arithmetic can be
 *    checked against the invoice line by line;
 *  - sub-cent spend reads "< $0.01" rather than a reassuring "$0.00" (format.ts);
 *  - throttling is presented as good citizenship — archive.org asked us to slow
 *    down and we did — never as a failure.
 *
 * The presentational rows live in CostPanelParts.tsx to keep this file small.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { ingest } from "@/lib/api.js";
import { fmtMonthShort, fmtUsd } from "@/lib/format.js";
import { cn } from "@/lib/utils.js";
import {
  BudgetBlock,
  DomainRow,
  KindRow,
  QuotaBlock,
  Row,
  ThrottleBlock,
} from "@/components/CostPanelParts.js";

/** `YYYY-MM` for "now", in UTC — the ledger's month key. */
function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last 13 months, newest first, for the picker. */
function monthOptions(now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < 13; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-32 rounded bg-muted animate-pulse" />
      <div className="h-1.5 rounded-full bg-muted animate-pulse" />
      <div className="space-y-2">
        <div className="h-4 rounded bg-muted animate-pulse" />
        <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 rounded bg-muted animate-pulse" />
        ))}
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        Loading this month's usage…
      </p>
    </div>
  );
}

export function CostPanel() {
  const now = new Date();
  const options = monthOptions(now);
  const [month, setMonth] = useState(() => currentMonth(now));

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["usage", month],
    queryFn: () => ingest.usage(month),
    staleTime: 1000 * 60,
    // Don't retry aggressively — if the API is down, one quiet failure is enough.
    retry: 0,
  });

  return (
    <section className="cw-panel space-y-4 p-4" aria-labelledby="cost-panel-h">
      {/* Header wraps instead of squeezing: at 320px the title, the month picker
        * and the refresh button cannot share one row without the picker being
        * crushed to an unusable width. */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="cost-panel-h" className="flex-1 text-base font-semibold">
          Cost &amp; politeness
        </h2>

        <button
          type="button"
          onClick={() => void refetch()}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Refresh usage"
          title="Refresh usage"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden />
        </button>

        {/* A closed list of the months the ledger can answer for. The previous
          * `<input type="month">` leaned on a native picker whose contrast is
          * the platform's to decide — on a light-mode OS it rendered against this
          * app's dark canvas as an almost invisible control. */}
        <div className="flex items-center gap-2">
          <label htmlFor="usage-month" className="cw-label">
            Month
          </label>
          <select
            id="usage-month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="cw-field w-auto min-w-[9rem] py-1 text-xs"
            aria-label="Usage month"
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {fmtMonthShort(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isPending && <Skeleton />}

      {isError && (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm text-muted-foreground select-none">
            Usage unavailable — {error instanceof Error ? error.message : "API not reachable"}
          </summary>
          <p className="text-xs text-muted-foreground">
            Cost figures are never served from the service-worker cache, so this is a live read
            failure — not a stale number.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="cw-btn cw-btn-secondary"
          >
            Retry
          </button>
        </details>
      )}

      {data && (
        <>
          <BudgetBlock budget={data.budget} />

          {/* Metered vs plan, deliberately separate so the total is checkable. */}
          <div className="space-y-1.5">
            <Row label="Metered usage" value={fmtUsd(data.meteredUsd)} />
            <Row label="Plan floor" value={fmtUsd(data.planFloorUsd)} />
            <div className="border-t border-border pt-1.5">
              <Row label="Total modelled" value={fmtUsd(data.totalUsd)} />
            </div>
          </div>

          <div className="space-y-1">
            <h3 className="cw-label">By kind</h3>
            {data.byKind.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing metered in this month.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.byKind.map((line) => (
                  <KindRow key={line.kind} line={line} />
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="cw-label">By domain</h3>
            {data.byDomain.length === 0 ? (
              <p className="text-sm text-muted-foreground">No domains tracked yet.</p>
            ) : (
              <ul>
                {data.byDomain.map((entry) => (
                  <DomainRow key={entry.domain} entry={entry} />
                ))}
              </ul>
            )}
          </div>

          <QuotaBlock quota={data.quota} />
          <ThrottleBlock throttle={data.throttle} />

          <p className="text-xs text-muted-foreground">
            {isFetching
              ? "Refreshing…"
              : `Generated ${new Date(data.generatedAt * 1000).toLocaleString()}`}
            {" · "}
            {fmtMonthShort(data.month)} · modelled from the usage ledger, not an invoice.
          </p>
        </>
      )}
    </section>
  );
}
