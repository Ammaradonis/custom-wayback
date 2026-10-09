#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run crawl -- --domain=samsung.com --month=2024-03 [--max-pages=25]
 *   npm run crawl -- serve --port=8787
 *   npm run crawl -- stats --domain=samsung.com
 *
 * Requires: node >= 22.5 with --experimental-sqlite (wired up in package.json).
 */

import { UsageError, parseCrawlOptions, printUsage } from './config.ts';
import { createLogger, log, setLogLevel } from './logger.ts';
import { Crawler } from './orchestrator.ts';
import { formatBytes, formatDuration, renderReport, writeReport } from './report.ts';
import { startViewer } from './viewer.ts';
import { Ledger } from './db.ts';
import { ThrottleError } from './politeness.ts';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'crawl';
const flags = command === 'crawl' && argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;

function flagValue(name: string, fallback: string): string {
  const found = flags.find((a) => a.startsWith(`--${name}=`));
  if (found) return found.slice(name.length + 3);
  const idx = flags.indexOf(`--${name}`);
  if (idx >= 0 && flags[idx + 1]) return flags[idx + 1]!;
  return fallback;
}

function flagNumber(name: string, fallback: number): number {
  const raw = flagValue(name, String(fallback));
  const parsed = Number(raw);
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
    const sites = new Ledger(dbPath).db
      .prepare(`SELECT COUNT(*) AS n FROM snapshot`)
      .get() as { n: number };
    logger.info('ready', { pages: sites.n });
    log.info(`open ${url}`);
    log.info(`  it lists every ingested domain+month in the header picker`);
    log.info(`  deep link: ${url}?domain=samsung.com&month=2024-03&day=2024-03-15`);
    log.info('press Ctrl+C to stop');
    // Keep the process alive until interrupted.
    await new Promise<void>(() => {});
    return 0;
  }

  if (command === 'stats') {
    const outDir = flagValue('out', `${process.cwd()}/data`);
    const dbPath = flagValue('db', `${outDir}/ledger.db`);
    const ledger = new Ledger(dbPath);
    const domain = flagValue('domain', '');
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
    if (runs.length === 0) {
      log.info('no runs recorded yet');
      return 0;
    }
    log.info('recent runs', { count: runs.length });
    for (const run of runs) {
      const duration = run.finished_at ? formatDuration(run.finished_at - run.started_at) : 'running';
      process.stdout.write(
        `  ${run.domain.padEnd(20)} ${run.month}  ${run.mode.padEnd(7)} ${run.status.padEnd(9)} ` +
          `${String(run.pages_done).padStart(4)} pages  ${String(run.ia_requests).padStart(6)} req  ` +
          `${String(run.ia_429).padStart(3)} 429  ${formatBytes(run.bytes_stored).padStart(9)}  ${duration}\n`,
      );
    }
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
      log.error('nothing was ingested; check the domain/month and try --refresh');
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
          `This is the documented behaviour under high automated load (see plan.md section 12).\n` +
          `Options: wait and re-run (the survey and fetched pages are cached, so it resumes cheaply),\n` +
          `raise --min-delay-ms, or lower --max-pages.\n` +
          `URL: ${err.url}\n\n`,
      );
      process.exit(3);
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\ningest failed: ${message}\n\n`);
    process.exit(1);
  });
