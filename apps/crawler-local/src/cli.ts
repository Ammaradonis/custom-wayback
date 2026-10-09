#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run crawl -- --domain=samsung.com --month=2024-03 --max-pages=25
 *   npm run serve -- --port=8787
 *   npm run stats
 *
 * Runtime: node >= 22.5 with --experimental-sqlite and --experimental-strip-types
 * (both wired up in package.json). The package uses explicit './x.ts' import
 * specifiers so Node strips types directly -- no bundler, no build step.
 */

import { UsageError, parseCrawlOptions, printUsage } from './config.ts';
import { createLogger, log, setLogLevel } from './logger.ts';
import { Crawler } from './orchestrator.ts';
import { formatBytes, formatDuration, renderReport, writeReport } from './report.ts';
import { startViewer } from './viewer.ts';
import { Ledger } from './db.ts';
import { ThrottleError } from './politeness.ts';

const argv = process.argv.slice(2);
const explicitCommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
const command = explicitCommand ?? 'crawl';
const flags = explicitCommand ? argv.slice(1) : argv;

function flagValue(name: string, fallback: string): string {
  const prefixed = flags.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const idx = flags.indexOf(`--${name}`);
  if (idx >= 0 && flags[idx + 1] && !flags[idx + 1]!.startsWith('--')) return flags[idx + 1]!;
  return fallback;
}

function flagNumber(name: string, fallback: number): number {
  const parsed = Number(flagValue(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<number> {
  if (flags.includes('--help') || flags.includes('-h') || command === 'help') {
    printUsage();
    return 0;
  }
  if (flags.includes('--verbose')) setLogLevel('debug');

  if (command === 'serve') {
    const outDir = flagValue('out', `${process.cwd()}/data`);
    const dbPath = flagValue('db', `${outDir}/ledger.db`);
    const port = flagNumber('port', 8787);
    const host = flagValue('host', '127.0.0.1');
    const logger = createLogger('serve');
    const url = await startViewer({ outDir, dbPath, port, host }, logger);

    const ledger = new Ledger(dbPath);
    const totals = ledger.db.prepare(`SELECT COUNT(*) AS n FROM snapshot`).get() as { n: number };
    const sites = ledger.db
      .prepare(
        `SELECT domain, substr(day,1,7) AS month, COUNT(*) AS pages FROM snapshot GROUP BY domain, month ORDER BY domain`,
      )
      .all() as { domain: string; month: string; pages: number }[];
    ledger.close();

    log.info('ready', { pages: totals.n });
    if (sites.length === 0) {
      log.warn('the ledger is empty — run an ingest first');
    } else {
      for (const s of sites) log.info(`  mirror: ${s.domain} ${s.month} (${s.pages} pages)`);
    }
    log.info(`open ${url}`);
    log.info(`deep link: ${url}?domain=${sites[0]?.domain ?? 'example.com'}&month=${sites[0]?.month ?? '2024-01'}`);
    log.info('press Ctrl+C to stop');
    await new Promise<void>(() => {});
    return 0;
  }

  if (command === 'stats') {
    const outDir = flagValue('out', `${process.cwd()}/data`);
    const dbPath = flagValue('db', `${outDir}/ledger.db`);
    const domain = flagValue('domain', '');
    const ledger = new Ledger(dbPath);
    const runs = ledger.db
      .prepare(
        `SELECT id, domain, month, mode, status, started_at, finished_at, pages_done, ia_requests, ia_429, bytes_stored
           FROM runs ${domain ? 'WHERE domain = ?' : ''} ORDER BY started_at DESC LIMIT 10`,
      )
      .all(...(domain ? [domain] : [])) as {
      id: string;
      domain: string;
      month: string;
      mode: string;
      status: string;
      started_at: number;
      finished_at: number | null;
      pages_done: number;
      ia_requests: number;
      ia_429: number;
      bytes_stored: number;
    }[];
    ledger.close();
    if (runs.length === 0) {
      log.info('no runs recorded yet');
      return 0;
    }
    process.stdout.write('\nrecent ingest runs\n\n');
    for (const run of runs) {
      const duration = run.finished_at ? formatDuration(run.finished_at - run.started_at) : 'running';
      process.stdout.write(
        `  ${run.domain.padEnd(18)} ${run.month}  ${run.mode.padEnd(7)} ${run.status.padEnd(8)} ` +
          `${String(run.pages_done).padStart(4)} pages  ${String(run.ia_requests).padStart(6)} req  ` +
          `${String(run.ia_429).padStart(3)} 429  ${formatBytes(run.bytes_stored).padStart(9)}  ${duration}\n`,
      );
    }
    process.stdout.write('\n');
    return 0;
  }

  if (command !== 'crawl') {
    log.error(`unknown command "${command}"`);
    printUsage();
    return 2;
  }

  const opts = parseCrawlOptions(flags);
  const crawler = new Crawler(opts, createLogger('crawl'));
  try {
    const report = await crawler.run();
    process.stdout.write(renderReport(report));
    writeReport(report, `${opts.outDir.replace(/\\/g, '/')}/meta/${opts.domain}/${opts.month}/report.json`);
    if (report.pages.rewritten === 0) {
      log.error('nothing was ingested; check the domain/month, or try --refresh');
      return 1;
    }
    return 0;
  } finally {
    crawler.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`\n${err.message}\n\n`);
      printUsage();
      process.exit(2);
    }
    if (err instanceof ThrottleError) {
      process.stderr.write(
        `\narchive.org throttled us (HTTP ${err.status}) even after backing off.\n` +
          `This is documented behaviour under high automated load (plan.md section 12).\n` +
          `Options: wait and re-run (a cached survey is reused, so it resumes cheaply),\n` +
          `raise --min-delay-ms, or lower --max-pages.\n` +
          `URL: ${err.url}\n\n`,
      );
      process.exit(3);
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\ningest failed: ${message}\n\n`);
    process.exit(1);
  });
