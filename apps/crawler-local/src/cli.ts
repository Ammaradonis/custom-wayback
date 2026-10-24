#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run crawl -- --domain=samsung.com --month=2024-03 --max-pages=25
 *   npm run serve -- --port=8787
 *   npm run stats
 *   npm run login -- --api=https://<your app>.workers.dev
 *   npm run publish -- --domain=samsung.com --month=2024-03
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
import { PublishError, publishMonth, type PublishResult } from './publish.ts';
import { SessionError, login, normaliseApi, prompt, resolveSession, saveSession, verifyToken, type Session } from './session.ts';
import { FsBlobStore } from './storage.ts';

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

  if (command === 'login') {
    const outDir = flagValue('out', `${process.cwd()}/data`);
    const apiFlag = flagValue('api', '');
    if (!apiFlag) throw new SessionError("--api is required: the deployed app's address, e.g. https://custom-wayback-api.example.workers.dev");
    const api = normaliseApi(apiFlag);
    const given = flagValue('token', process.env.CW_TOKEN ?? '');
    let session: Session;
    if (given) {
      await verifyToken(api, given);
      session = { api, token: given, email: null, savedAt: Date.now() };
    } else {
      const email = flagValue('email', '') || (await prompt('Email: '));
      const password = await prompt('Password: ', true);
      session = { api, token: await login(api, email, password), email, savedAt: Date.now() };
    }
    const path = await saveSession(outDir, session);
    log.info(`signed in to ${api}; the session is saved in ${path} and lasts 7 days`);
    return 0;
  }

  if (command === 'publish') {
    const opts = parseCrawlOptions(flags);
    const session = await resolveSession(opts.outDir, flagValue('api', ''), flagValue('token', ''));
    return publish(opts, session);
  }

  if (command !== 'crawl') {
    log.error(`unknown command "${command}"`);
    printUsage();
    return 2;
  }

  const opts = parseCrawlOptions(flags);
  // Checked before crawling, so a stale session fails in a second rather than after
  // an hour of polite fetching.
  const session = flags.includes('--publish')
    ? await resolveSession(opts.outDir, flagValue('api', ''), flagValue('token', ''))
    : null;
  const crawler = new Crawler(opts, createLogger('crawl'));
  try {
    const report = await crawler.run();
    process.stdout.write(renderReport(report));
    writeReport(report, `${opts.outDir.replace(/\\/g, '/')}/meta/${opts.domain}/${opts.month}/report.json`);
    if (report.pages.rewritten === 0) {
      log.error('nothing was ingested; check the domain/month, or try --refresh');
      return 1;
    }
  } finally {
    crawler.close();
  }
  return session ? publish(opts, session) : 0;
}

/** Upload the crawled month and say where to see it. */
async function publish(
  opts: { domain: string; month: string; outDir: string; dbPath: string },
  session: Session,
): Promise<number> {
  const logger = createLogger('publish');
  const ledger = new Ledger(opts.dbPath);
  let result: PublishResult;
  try {
    logger.info(`publishing ${opts.domain} ${opts.month} to ${session.api}`);
    result = await publishMonth(ledger, new FsBlobStore(opts.outDir), {
      api: session.api,
      token: session.token,
      domain: opts.domain,
      month: opts.month,
      log: logger,
    });
  } finally {
    ledger.close();
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  process.stdout.write(
    `\npublished ${plural(result.pages, 'page', 'pages')} and ${plural(result.assetsUploaded, 'new asset', 'new assets')} ` +
      `(${formatBytes(result.bytesUploaded)}); ${plural(result.assetsAlreadyThere, 'asset was', 'assets were')} already there.\n` +
      (result.assetsNotCrawled > 0
        ? `${plural(result.assetsNotCrawled, 'referenced file was', 'referenced files were')} never crawled; the viewer fetches those on demand.\n`
        : '') +
      'These pages are served from R2 and are never deleted after viewing.\n' +
      (result.firstRoute ? `open: ${session.api}${result.firstRoute}\n` : '') +
      '\n',
  );
  for (const failed of result.pagesFailed.slice(0, 10)) {
    log.warn(`not published: ${failed.url} (${failed.day}): ${failed.reason}`);
  }
  return result.pagesFailed.length > 0 ? 1 : 0;
}

/**
 * End the process with `code` by letting the event loop drain, not with `process.exit()`.
 *
 * On Windows, exiting while `fetch`'s connection pool is still closing a socket aborts
 * Node with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 127) — seen
 * on Node 24 right after `login`. Drained, the process ends cleanly within a moment; the
 * unref'd timer only fires if some handle never closes.
 */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

main()
  .then(finish)
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`\n${err.message}\n\n`);
      printUsage();
      return finish(2);
    }
    if (err instanceof SessionError || err instanceof PublishError) {
      process.stderr.write(`\n${err.message}\n\n`);
      return finish(err instanceof SessionError ? 2 : 1);
    }
    if (err instanceof ThrottleError) {
      process.stderr.write(
        `\narchive.org throttled us (HTTP ${err.status}) even after backing off.\n` +
          `This is documented behaviour under high automated load (plan.md section 12).\n` +
          `Options: wait and re-run (a cached survey is reused, so it resumes cheaply),\n` +
          `raise --min-delay-ms, or lower --max-pages.\n` +
          `URL: ${err.url}\n\n`,
      );
      return finish(3);
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\ningest failed: ${message}\n\n`);
    return finish(1);
  });
