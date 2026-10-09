/**
 * Console report for a completed (or partial) ingest.
 *
 * This is the artefact the Phase 1 acceptance criteria ask for: pages, unique assets,
 * dedupe ratio, bytes, 429 count and wall time in one screen, so the cost and latency
 * estimates in plan.md section 11 can be replaced with measurements.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CrawlReport } from './orchestrator.ts';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const CYAN = '\u001b[36m';

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function paint(value: string, code: string): string {
  return useColor() ? `${code}${value}${RESET}` : value;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

interface Row {
  label: string;
  value: string;
  note?: string;
}

function table(title: string, rows: Row[]): string {
  const width = Math.max(...rows.map((r) => r.label.length), title.length);
  const lines = [paint(title, BOLD)];
  for (const row of rows) {
    const line = `  ${row.label.padEnd(width)}  ${row.value}`;
    lines.push(row.note ? `${line}  ${paint(row.note, DIM)}` : line);
  }
  return lines.join('\n');
}

export function renderReport(report: CrawlReport): string {
  const out: string[] = [];
  const clean = report.failures.length === 0 && !report.pages.overBudget && !report.survey.degraded;
  const header = clean
    ? paint('INGEST COMPLETE', `${BOLD}${GREEN}`)
    : paint('INGEST COMPLETE (with gaps)', `${BOLD}${YELLOW}`);

  out.push('');
  out.push(`${header}  ${paint(`${report.domain} · ${report.month}`, CYAN)}  mode=${report.mode}`);
  out.push(
    paint(
      `  ${report.pages.rewritten} pages · ${formatBytes(report.storage.blobBytes)} on disk · ` +
        `${formatDuration(report.wallClockMs)} · ${num(report.ia.attempts)} archive.org requests`,
      DIM,
    ),
  );
  out.push('');

  if (report.survey.degraded || report.survey.usedSeedFallback) {
    out.push(paint('  ! the CDX survey was incomplete for this run', `${BOLD}${YELLOW}`));
    if (report.survey.degradedReason) out.push(`    reason: ${report.survey.degradedReason}`);
    if (report.survey.usedSeedFallback) {
      out.push('    fell back to the Availability API for the seed URL (one page deep)');
    }
    if (report.survey.frontierNote) out.push(`    ${report.survey.frontierNote}`);
    out.push('    re-run with --refresh later; a complete survey is cached and reused');
    out.push('');
  }

  out.push(
    table('DAY POLICY  (one clean snapshot per day instead of every capture)', [
      {
        label: 'captures in the CDX index',
        value: num(report.survey.htmlRows),
        note: 'what the old calendar showed you',
      },
      {
        label: 'pageloads ingested',
        value: num(report.pages.rewritten),
        note: `${num(report.survey.distinctUrls)} distinct URLs`,
      },
      {
        label: 'captures collapsed away',
        value: num(report.survey.capturesDiscarded),
        note:
          report.survey.capturesConsidered > 0
            ? `${pct(report.survey.capturesDiscarded / Math.max(1, report.survey.capturesConsidered))} reduction`
            : undefined,
      },
      {
        label: 'deferred to on-demand',
        value: num(report.pages.skippedByBudget),
        note: 'over --max-pages; served on first visit in Phase 2',
      },
    ]),
  );
  out.push('');

  out.push(
    table('PAGES', [
      { label: 'fetched from archive.org', value: num(report.pages.fetched) },
      { label: 'rewritten and stored', value: num(report.pages.rewritten) },
      {
        label: 'failed',
        value: num(report.pages.failed),
        note: report.pages.failed > 0 ? 'see failures below' : undefined,
      },
      {
        label: 'html stored',
        value: formatBytes(report.pages.bytesStored),
        note: `avg ${formatBytes(report.pages.averageBytes)}/page (plus verbatim originals)`,
      },
      {
        label: 'titles extracted',
        value: `${num(report.pages.withTitle)}/${num(report.pages.rewritten)}`,
      },
    ]),
  );
  out.push('');

  out.push(
    table('ASSETS  (content-addressed, deduped across pages and days)', [
      { label: 'asset references on pages', value: num(report.assets.referenced) },
      { label: 'fetched', value: num(report.assets.fetched) },
      {
        label: 'resolved by per-URL lookup',
        value: num(report.assets.resolvedOnDemand),
        note: report.assets.resolvedOnDemand > 0 ? 'no domain survey was available' : undefined,
      },
      {
        label: 'unavailable',
        value: num(report.assets.failed + report.assets.missing),
        note: 'dead CDN or outside the surveyed window',
      },
      {
        label: 'skipped by extension',
        value: num(report.assets.skippedByExtension),
        note: 'video/archives excluded by policy',
      },
      {
        label: 'unique assets stored',
        value: num(report.assets.uniqueStored),
        note: `${num(report.assets.refs)} references`,
      },
      { label: 'bytes stored for assets', value: formatBytes(report.assets.storedBytes) },
      { label: 'bytes without dedupe', value: formatBytes(report.assets.naiveBytes) },
      {
        label: 'saved by dedupe',
        value: `${formatBytes(report.assets.dedupeSavedBytes)}  (${pct(report.assets.dedupeRatio)})`,
        note: `${num(report.assets.sharedAcrossPages)} assets used by >1 page`,
      },
    ]),
  );
  out.push('');

  out.push(
    table('LINKS', [
      { label: 'internal link edges', value: num(report.links.edges) },
      {
        label: 'resolved to a stored capture',
        value: num(report.links.resolved),
        note:
          report.links.edges > 0
            ? `${pct(report.links.resolved / report.links.edges)} of edges`
            : undefined,
      },
      { label: 'same day', value: num(report.links.sameDay) },
      {
        label: 'drifted to a nearby day',
        value: num(report.links.drifted),
        note: `max drift ${report.links.maxDriftDays} day(s)`,
      },
      {
        label: 'no capture in range',
        value: num(report.links.unresolved),
        note: 'marked data-cw-dead in the page',
      },
    ]),
  );
  out.push('');

  out.push(
    table('PAGE HYGIENE', [
      { label: 'tracking/ad scripts stubbed', value: num(report.pages.stubbedScripts) },
      { label: 'scripts served locally', value: num(report.pages.keptScripts) },
      { label: 'external links made safe', value: num(report.pages.externalLinks) },
      { label: 'dead links marked', value: num(report.pages.deadLinksFound) },
      {
        label: 'assets by role',
        value: report.byRole.map((r) => `${r.role}:${r.count}`).join('  ') || '—',
      },
    ]),
  );
  out.push('');

  const throttled = report.ia.throttled;
  out.push(
    table('ARCHIVE.ORG BUDGET', [
      { label: 'total requests', value: num(report.ia.attempts), note: `${report.archiveRequestsPerPage}/page` },
      {
        label: 'survey requests',
        value: num(report.ia.surveyRequests),
        note: `${formatDuration(report.survey.elapsedMs)} in the survey phase`,
      },
      { label: 'unique URLs fetched', value: num(report.ia.uniqueUrlsFetched) },
      { label: 'bytes pulled', value: formatBytes(report.ia.bytes) },
      {
        label: '429 / 503 responses',
        value: num(throttled),
        note: throttled > 0 ? 'backed off automatically; consider a larger --min-delay-ms' : 'none — polite rate held',
      },
      {
        label: 'timeouts',
        value: num(report.ia.timeouts),
        note: report.ia.timeouts > 0 ? 'archive.org responded slowly; see README' : undefined,
      },
      { label: 'observed request rate', value: `${report.ia.avgRequestsPerSecond}/s`, note: 'target: <= 1/s per host' },
      { label: 'wall clock', value: formatDuration(report.wallClockMs), note: `${report.wallClockPerPageMs} ms/page` },
    ]),
  );
  out.push('');

  const dayLines = report.byDay
    .map((d) => `  ${d.day}  ${String(d.pages).padStart(4)} pages  ${formatBytes(d.bytes).padStart(9)}`)
    .join('\n');
  if (dayLines) {
    out.push(paint('BY DAY', BOLD));
    out.push(dayLines);
    out.push('');
  }

  if (report.topAssets.length > 0) {
    out.push(paint('MOST-SHARED ASSETS (dedupe working as intended)', BOLD));
    for (const asset of report.topAssets.slice(0, 8)) {
      const label = (asset.url ?? asset.hash).slice(0, 72);
      out.push(
        `  ${String(asset.refCount).padStart(5)}x  ${formatBytes(asset.bytes).padStart(9)}  ` +
          `${asset.mime.padEnd(16)} ${label}`,
      );
    }
    out.push('');
  }

  if (report.failures.length > 0) {
    out.push(paint('FAILURES', `${BOLD}${RED}`));
    for (const failure of report.failures.slice(0, 12)) {
      out.push(`  ${failure.reason}  ${failure.url}`);
    }
    if (report.failures.length > 12) {
      out.push(paint(`  … and ${report.failures.length - 12} more (see manifest.json)`, DIM));
    }
    out.push('');
  }

  out.push(
    paint(
      `  storage: ${report.storage.outDir}\n` +
        `  next:    npm run serve   then open /?domain=${report.domain}&month=${report.month}`,
      DIM,
    ),
  );
  out.push('');
  return out.join('\n');
}

export function writeReport(report: CrawlReport, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
  } catch {
    /* report files are a convenience; never fail a crawl over one */
  }
}
