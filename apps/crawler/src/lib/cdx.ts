/**
 * CDX survey: fetch all captures for (domain, month) with correct pagination,
 * day-bucketing, and best-capture selection (§6.2 of plan.md).
 *
 * Uses `collapse=timestamp:8` (one row per day per URL) to keep the response
 * small, then applies the §6.2 policy for "the one snapshot per day".
 */

import {
  CDX_BASE,
  type CdxRow,
  type DayBucket,
  CIRCUIT_BREAKER_THRESHOLD,
  BACKOFF_MAX_MS,
} from "@custom-wayback/shared";

interface CdxOptions {
  userAgent: string;
  /** "domain" | "host" | "prefix" | "exact" */
  matchType?: string;
  from: string; // YYYYMMDD
  to: string;   // YYYYMMDD
  limit?: number;
}

/** Fetch CDX rows for a domain+month with safe pagination. */
export async function surveyCdx(
  domain: string,
  opts: CdxOptions,
): Promise<CdxRow[]> {
  const rows: CdxRow[] = [];
  let resumeKey: string | undefined;
  let consecutive429 = 0;

  while (true) {
    const url = new URL(CDX_BASE);
    url.searchParams.set("url", domain);
    url.searchParams.set("matchType", opts.matchType ?? "domain");
    url.searchParams.set("from", opts.from);
    url.searchParams.set("to", opts.to);
    url.searchParams.set("filter", "statuscode:200");
    url.searchParams.set("filter", "mimetype:text/html");
    url.searchParams.set("collapse", "timestamp:8");
    url.searchParams.set(
      "fl",
      "timestamp,original,mimetype,statuscode,digest,length",
    );
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", String(opts.limit ?? 5000));
    url.searchParams.set("showResumeKey", "true");
    if (resumeKey) url.searchParams.set("resumeKey", resumeKey);

    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": opts.userAgent },
    });

    if (resp.status === 429 || resp.status === 503) {
      consecutive429++;
      if (consecutive429 >= CIRCUIT_BREAKER_THRESHOLD) {
        throw new Error(
          `CDX circuit breaker: ${consecutive429} consecutive 429s. Aborting.`,
        );
      }
      const delay = Math.min(1000 * 2 ** consecutive429, BACKOFF_MAX_MS) +
        Math.random() * 1000;
      console.warn(`[cdx] 429 received. Backing off ${Math.round(delay)}ms…`);
      await sleep(delay);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`CDX fetch failed: ${resp.status} ${resp.statusText}`);
    }
    consecutive429 = 0;

    const json = (await resp.json()) as string[][];
    if (!Array.isArray(json) || json.length < 2) break; // no more data

    // Row 0 is the header ["timestamp","original","mimetype","statuscode","digest","length"]
    const header = json[0] as string[];
    const dataRows = json.slice(1);

    // The last item may be the resume key (a plain string row).
    let nextResumeKey: string | undefined;
    const lastRow = dataRows.at(-1);
    if (lastRow && lastRow.length === 1) {
      nextResumeKey = lastRow[0];
      dataRows.pop();
    }

    for (const raw of dataRows) {
      const row: Record<string, string> = {};
      header.forEach((h, i) => {
        row[h] = raw[i] ?? "";
      });
      rows.push(row as unknown as CdxRow);
    }

    if (!nextResumeKey) break;
    resumeKey = nextResumeKey;

    // Small polite pause between pages.
    await sleep(300);
  }

  return rows;
}

/**
 * Group CDX rows into day buckets and apply the §6.2 best-capture policy:
 *  1. Prefer statuscode=200.
 *  2. Prefer largest length.
 *  3. Prefer latest timestamp (deterministic tie-break).
 */
export function bucketByDay(rows: CdxRow[]): Map<string, DayBucket> {
  const buckets = new Map<string, CdxRow[]>();

  for (const row of rows) {
    const day = row.timestamp.slice(0, 8); // YYYYMMDD → "YYYY-MM-DD"
    const dayKey = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    if (!buckets.has(dayKey)) buckets.set(dayKey, []);
    buckets.get(dayKey)!.push(row);
  }

  const result = new Map<string, DayBucket>();
  for (const [day, captures] of buckets) {
    const chosen = chooseCapture(captures);
    result.set(day, { day, captures, chosen });
  }
  return result;
}

function chooseCapture(captures: CdxRow[]): CdxRow {
  return [...captures].sort((a, b) => {
    // 1. Prefer 200 over anything else.
    const aIs200 = a.statuscode === "200" ? 1 : 0;
    const bIs200 = b.statuscode === "200" ? 1 : 0;
    if (aIs200 !== bIs200) return bIs200 - aIs200;
    // 2. Prefer larger length.
    const aLen = parseInt(a.length, 10) || 0;
    const bLen = parseInt(b.length, 10) || 0;
    if (aLen !== bLen) return bLen - aLen;
    // 3. Prefer latest timestamp.
    return b.timestamp.localeCompare(a.timestamp);
  })[0]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
