/**
 * Formatting helpers for the cost panel (plan.md §11.5).
 *
 * The whole point of the panel is that the numbers reconcile with the invoice,
 * so the rules are explicit:
 *  - Money is never rounded *up* into a lie: a non-zero amount below a cent
 *    renders "< $0.01", not "$0.00".
 *  - Counts and bytes go through `Intl`, so a phone in de-DE sees "1.234".
 */

/** `1234567` → `"1,234,567"` (locale-aware). */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/**
 * Money to 2 decimals, with a `< $0.01` floor for small non-zero amounts.
 *
 * A row that says `$0.00` when it actually cost something is exactly the kind
 * of lie this panel exists to prevent, so zero and near-zero are distinguished.
 */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return n < 0 ? "> -$0.01" : "< $0.01";
  return `$${n.toFixed(2)}`;
}

/** Binary byte formatting: B / KB / MB / GB / TB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${fmtCount(n)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Milliseconds as e.g. `"2 m 14 s"`, `"34 s"`, `"820 ms"`. */
export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (m > 0) parts.push(`${m} m`);
  if (s > 0 && h === 0) parts.push(`${s} s`);
  return parts.join(" ") || "0 s";
}

/** Unix seconds → local date-time, in the user's locale. */
export function fmtUnixTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** `"2026-01"` → `"January 2026"`, in the user's locale. */
export function fmtMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  const year = Number(y);
  const monthIndex = Number(m) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return month;
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `"2026-01"` → `"Jan 2026"`, for the compact month dropdown. */
export function fmtMonthShort(month: string): string {
  const [y, m] = month.split("-");
  const year = Number(y);
  const monthIndex = Number(m) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return month;
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
