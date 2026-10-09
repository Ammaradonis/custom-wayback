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
import { ingest } from "@/lib/api.js";
import { fmtMonthLabel, fmtMonthShort, fmtUsd } from "@/lib/format.js";
import {
  BudgetBlock,
  DomainRow,
  KindRow,
  QuotaBlock,
  Row,
  ThrottleBlock,
} from "@/components/CostPanelParts.js";

/** `"2026-01"` → `"2026-01-01"`, the value shape `<input type="month">` wants. */
function monthToInputValue(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : "";
}

/** `YYYY-MM` for "now", in UTC — the ledger's month key. */
function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last 13 months, newest first, for the picker's datalist. */
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
    <section className="rounded-lg border border-border p-4 space-y-4" aria-labelledby="cost-panel-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="cost-panel-h" className="text-base font-semibold">
          Cost &amp; politeness
        </h2>
        <input
          type="month"
          value={monthToInputValue(month)}
          max={monthToInputValue(options[0] ?? month)}
          list="cw-usage-months"
          onChange={(e) => {
            const next = e.target.value.slice(0, 7);
            if (/^\d{4}-\d{2}$/.test(next)) setMonth(next);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Usage month"
        />
        <datalist id="cw-usage-months">
          {options.map((m) => (
            <option key={m} value={monthToInputValue(m)}>
              {fmtMonthShort(m)}
            </option>
          ))}
        </datalist>
      </div>

      {isPending && <Skeleton />}

      {isError && (
        <details className="space-y-2">
          <summary className="text-sm text-muted-foreground cursor-pointer select-none">
            Usage unavailable — {error instanceof Error ? error.message : "API not reachable"}
          </summary>
          <p className="text-xs text-muted-foreground">
            Cost figures are never served from the service-worker cache, so this is a live read
            failure — not a stale number.
          </p>
          <button
            onClick={() => void refetch()}
            className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
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
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By kind
            </h3>
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
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By domain
            </h3>
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
