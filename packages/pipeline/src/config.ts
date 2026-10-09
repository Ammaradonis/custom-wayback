/**
 * Shared configuration helpers: month ranges and registrable domains.
 *
 * Extracted from apps/crawler-local/src/config.ts so both ingestion runtimes agree on
 * what "--month=2024-03" means and on what a domain is. The CLI argument parser stays
 * in that package: it needs `process.cwd()`.
 *
 * Errors here are plain `Error`s, not the CLI's `UsageError`, so this module stays
 * free of any local error type. `apps/crawler-local/src/config.ts` re-wraps
 * `parseMonth` so a bad `--month` still raises the `UsageError` that cli.ts matches on
 * to print usage and exit 2. Message text is byte-identical either way.
 */

/** Public suffixes we treat as two labels, so "example.co.uk" is one registrable domain. */
const TWO_LEVEL_TLDS = new Set(['co.uk', 'com.au', 'co.jp', 'com.br', 'co.kr', 'com.cn', 'co.in']);

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * Validate `YYYY-MM` and produce the inclusive CDX timestamp range for that month
 * (`from`/`to`, 14 digits) plus its first and last calendar day (`YYYY-MM-DD`).
 */
export function parseMonth(month: string): { from: string; to: string; firstDay: string; lastDay: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`--month must be YYYY-MM (got "${month}")`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`--month has an invalid month: "${month}"`);
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDate = new Date(Date.UTC(year, mon, 0));
  return {
    from: `${year}${pad(mon)}01000000`,
    to: `${year}${pad(mon)}${pad(lastDate.getUTCDate())}235959`,
    firstDay: `${year}-${pad(mon)}-01`,
    lastDay: `${year}-${pad(mon)}-${pad(lastDate.getUTCDate())}`,
  };
}
