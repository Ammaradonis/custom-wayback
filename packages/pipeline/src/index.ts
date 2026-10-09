/**
 * @custom-wayback/pipeline — runtime-agnostic ingestion logic.
 *
 * Same code, two runtimes: the local Node crawler (apps/crawler-local) and the
 * Cloudflare Queues consumer in the Worker (apps/api). Nothing here may import a Node
 * builtin, touch the filesystem, or reach for DOM/`process` — see env.d.ts for the
 * exact global surface this package is allowed to use.
 */

export * from './config.js';
export * from './head.js';
export * from './runtime.js';
export * from './selection.js';
export * from './text.js';
export * from './urlutil.js';
export * from './wayback.js';
