/**
 * Cost monitoring and the budget guardrail (plan.md §11.5).
 *
 * The whole point of this module is that the number on the dashboard and the
 * number on the invoice are computed from the same measurements. So:
 *
 *  - Every metered action is recorded in `usage_ledger` as it happens
 *    (`ia_fetch`, `r2_put`, `bytes_stored`, `queue_op`, …). The queue consumer
 *    and the viewer both write here; nothing is estimated after the fact.
 *  - The unit prices live in `USAGE_PRICES` (packages/shared/src/constants.ts),
 *    copied from the vendor pricing pages cited in plan.md §11.1. Changing a
 *    price is a one-line edit and the dashboard follows.
 *  - `DEFAULT_MONTHLY_BUDGET_USD` is a hard guardrail: once the month's modelled
 *    cost crosses it, `POST /v1/jobs` is refused with the exact remaining figure.
 *
 * The honest caveat, stated in the UI as well: archive.org requests cost money
 * in *politeness* (wall-clock), not in dollars. They are tracked so you can see
 * the crawl budget being spent, but they are priced at zero.
 */

import type { Env } from "../env.js";
import {
  BUDGET_WARN_FRACTION,
  DEFAULT_MONTHLY_BUDGET_USD,
  PLAN_FLOOR_USD,
  USAGE_PRICES,
  type BudgetStatus,
  type CostLine,
  type DomainCost,
  type UsageReport,
} from "@custom-wayback/shared";

/** Kinds that are real money. Everything else is telemetry. */
const BILLABLE_KINDS = new Set([
  "worker_request",
  "worker_cpu_ms",
  "r2_class_a",
  "r2_class_b",
  "r2_put",
  "r2_get",
  "r2_delete",
  "bytes_stored",
  "queue_op",
  "d1_write",
]);

/**
 * Map a ledger `kind` onto a priced resource.
 * `r2_put`/`r2_get` are the crawler's names for R2 Class A/B operations.
 */
function priceKeyFor(kind: string): string {
  if (kind === "r2_put") return "r2_class_a";
  if (kind === "r2_get") return "r2_class_b";
  return kind;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface LedgerRow {
  domain: string | null;
  kind: string;
  total: number;
}

/**
 * Roll ledger rows into priced lines.
 *
 * Free allowances are applied per resource across the whole account, not per
 * domain — that is how Cloudflare actually bills — so a per-domain view shows
 * gross usage and the account-level total carries the deduction. Both are
 * returned; the dashboard labels them so the numbers reconcile.
 */
function priceRows(rows: LedgerRow[]): { lines: CostLine[]; totalUsd: number } {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = priceKeyFor(row.kind);
    totals.set(key, (totals.get(key) ?? 0) + row.total);
  }

  const lines: CostLine[] = [];
  let totalUsd = 0;

  for (const [key, units] of totals) {
    const price = USAGE_PRICES[key];
    if (!price) {
      lines.push({
        kind: key,
        unit: "units",
        units,
        billableUnits: 0,
        freeUnits: 0,
        costUsd: 0,
      });
      continue;
    }
    const billableUnits = Math.max(0, units - price.freeUnitsPerMonth);
    const costUsd = BILLABLE_KINDS.has(key) ? billableUnits * price.unitPriceUsd : 0;
    totalUsd += costUsd;
    lines.push({
      kind: key,
      unit: price.unit,
      units,
      billableUnits,
      freeUnits: Math.min(units, price.freeUnitsPerMonth),
      costUsd,
    });
  }

  lines.sort((a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind));
  return { lines, totalUsd };
}

export function budgetUsdFromEnv(env: Env): number {
  const raw = Number.parseFloat(env.MONTHLY_BUDGET_USD ?? "");
  return Number.isFinite(raw) ? raw : DEFAULT_MONTHLY_BUDGET_USD;
}

function budgetStatus(spentUsd: number, budgetUsd: number): BudgetStatus {
  if (!(budgetUsd > 0)) {
    return {
      state: "disabled",
      budgetUsd: 0,
      spentUsd,
      remainingUsd: Number.POSITIVE_INFINITY,
      fraction: 0,
      crawlsBlocked: false,
    };
  }
  const fraction = spentUsd / budgetUsd;
  const state: BudgetStatus["state"] = fraction >= 1 ? "exceeded" : fraction >= BUDGET_WARN_FRACTION ? "warn" : "ok";
  return {
    state,
    budgetUsd,
    spentUsd,
    remainingUsd: Math.max(0, budgetUsd - spentUsd),
    fraction,
    crawlsBlocked: state === "exceeded",
  };
}

/**
 * The full usage report, scoped to the domains a user owns.
 *
 * ## Why there is no month filter on the ledger
 *
 * `usage_ledger.month` is the month being *crawled* — "2024-01" for a January
 * 2024 snapshot — not the month the money was spent. Filtering the ledger on the
 * current calendar month therefore matches nothing in normal use and reports $0
 * spent forever, while the invoice says otherwise. That is the worst possible
 * failure for a cost dashboard, so the spend total deliberately covers the
 * account's whole usage history: for a personal tool that is exactly the number
 * you want against a monthly budget, and it cannot silently under-report.
 *
 * The `month` argument still scopes the *throttle telemetry*, where it means what
 * it says: which archived month's crawls were being throttled.
 */
export async function buildUsageReport(
  env: Env,
  userId: string,
  month: string,
): Promise<UsageReport> {
  // Joined to `domains` rather than filtered through a subquery: the ledger has
  // no user_id column — usage is attributed by domain — so the join is what scopes
  // one user's spend to their own domains.
  const ledger = await env.DB.prepare(
    `SELECT u.domain AS domain, u.kind AS kind, SUM(u.value) AS total
     FROM usage_ledger u
     JOIN domains d ON d.domain = u.domain AND d.user_id = ?
     GROUP BY u.domain, u.kind`,
  )
    .bind(userId)
    .all<LedgerRow>();

  const rows = ledger.results ?? [];

  // Account-level pricing (free allowances applied once).
  const account = priceRows(rows);

  // Per-domain gross attribution — no free-allowance deduction, so the columns
  // add up to the account total before the allowance is subtracted.
  const perDomain = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = row.domain ?? "(shared)";
    const list = perDomain.get(key);
    if (list) list.push(row);
    else perDomain.set(key, [row]);
  }

  const throttleRows = await env.DB.prepare(
    `SELECT domain, status, wait_ms, created_at
     FROM throttle_events
     WHERE domain IN (SELECT domain FROM domains WHERE user_id = ?)
       AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 500`,
  )
    .bind(userId, monthToEpoch(month))
    .all<{ domain: string; status: number; wait_ms: number; created_at: number }>();

  const throttleByDomain = new Map<string, { events: number; waitMs: number }>();
  const byStatus: Record<string, number> = {};
  let throttleWaitMs = 0;
  let lastEventAt: number | null = null;
  for (const ev of throttleRows.results ?? []) {
    const agg = throttleByDomain.get(ev.domain) ?? { events: 0, waitMs: 0 };
    agg.events += 1;
    agg.waitMs += ev.wait_ms;
    throttleByDomain.set(ev.domain, agg);
    byStatus[String(ev.status)] = (byStatus[String(ev.status)] ?? 0) + 1;
    throttleWaitMs += ev.wait_ms;
    if (lastEventAt === null || ev.created_at > lastEventAt) lastEventAt = ev.created_at;
  }

  const byDomain: DomainCost[] = [];
  for (const [domain, domainRows] of perDomain) {
    const priced = priceRows(domainRows);
    const grossUsd = domainRows
      .filter((r) => BILLABLE_KINDS.has(priceKeyFor(r.kind)))
      .reduce((sum, r) => sum + r.total * (USAGE_PRICES[priceKeyFor(r.kind)]?.unitPriceUsd ?? 0), 0);
    const bytesStored = domainRows
      .filter((r) => r.kind === "bytes_stored")
      .reduce((sum, r) => sum + r.total, 0);
    const iaFetches = domainRows.filter((r) => r.kind === "ia_fetch").reduce((sum, r) => sum + r.total, 0);
    const throttle = throttleByDomain.get(domain) ?? { events: 0, waitMs: 0 };
    byDomain.push({
      domain,
      lines: priced.lines,
      totalUsd: grossUsd,
      bytesStored,
      iaFetches,
      throttleEvents: throttle.events,
      throttleWaitMs: throttle.waitMs,
    });
  }
  byDomain.sort((a, b) => b.totalUsd - a.totalUsd || a.domain.localeCompare(b.domain));

  // The plan floor is a real line item and belongs in the total; it is reported
  // separately so the dashboard can show "metered" next to "plan".
  const totalUsd = account.totalUsd + PLAN_FLOOR_USD;
  const budgetUsd = budgetUsdFromEnv(env);
  const budget = budgetStatus(totalUsd, budgetUsd);

  const quota = await crawlQuotaUsed(env, userId);

  return {
    month,
    generatedAt: Math.floor(Date.now() / 1000),
    totalUsd,
    planFloorUsd: PLAN_FLOOR_USD,
    meteredUsd: account.totalUsd,
    byKind: account.lines,
    byDomain,
    budget,
    quota,
    throttle: {
      events: throttleRows.results?.length ?? 0,
      byStatus,
      lastEventAt,
      totalWaitMs: throttleWaitMs,
    },
  };
}

function monthToEpoch(month: string): number {
  const [y, m] = month.split("-");
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, 1) / 1000);
}

async function crawlQuotaUsed(
  env: Env,
  userId: string,
): Promise<UsageReport["quota"]> {
  const limit = Number.parseInt(env.CRAWL_QUOTA_PER_DAY ?? "", 10) || 8;
  const now = new Date();
  const dayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  const resetsAt = dayStart + 86_400;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS used FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE d.user_id = ? AND i.started_at >= ?`,
  )
    .bind(userId, dayStart)
    .first<{ used: number }>();
  const used = row?.used ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt };
}

/**
 * Record one metered action. Batched by the caller where possible: D1 bills rows
 * written, and a crawler that writes one row per asset would spend more on
 * bookkeeping than on storage.
 */
export function usageStmt(
  env: Env,
  args: { domain: string | null; month: string; kind: string; value: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO usage_ledger (domain, month, kind, value, recorded_at) VALUES (?,?,?,?,?)`,
  ).bind(args.domain, args.month, args.kind, args.value, Math.floor(Date.now() / 1000));
}
