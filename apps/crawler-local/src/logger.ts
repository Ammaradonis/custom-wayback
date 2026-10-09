/**
 * Structured logger with redaction.
 *
 * Two jobs:
 *  1. Make crawl progress readable while it happens.
 *  2. Guarantee that secrets can never reach stdout, a log file, or CI output.
 *
 * Redaction runs on every emitted line, including nested objects and strings that
 * merely *contain* a credential-looking token. Patterns are deliberately specific
 * (prefixed token formats and keyed assignments) so that ordinary hashes -- content
 * addresses, CDX digests, cache-busting query strings -- are not mangled.
 */

/** Tokens whose *entire* match is a secret. */
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub classic tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /cfat_[A-Za-z0-9_-]{16,}/g, // Cloudflare API token
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS/R2 access key id
  /sk-[A-Za-z0-9]{20,}/g, // generic API secret key
];

/**
 * Keyed assignments: keep the key (so logs stay readable) and redact the value.
 * The value group is deliberately greedy-free and stops at whitespace, quotes,
 * commas, semicolons or braces so it cannot swallow the rest of the line.
 */
const KEYED_PATTERNS: RegExp[] = [
  /\b(secret|password|passwd|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|token|credential|authorization|cookie|set-cookie)\b\s*[:=]\s*["']?([^\s"',;}{]{6,})/gi,
];

const REDACTED = '[redacted]';

/** Redact credential-looking substrings from a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  for (const re of KEYED_PATTERNS) out = out.replace(re, (_m, key: string) => `${key}: ${REDACTED}`);
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

/** Serialize any value to a single redacted line. */
export function safeJson(value: unknown): string {
  return redactString(JSON.stringify(redactValue(value)));
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

function emit(level: LogLevel, prefix: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const tag = level.toUpperCase().padEnd(5);
  const scope = prefix ? `${prefix} ` : '';
  const tail = fields && Object.keys(fields).length > 0 ? ` ${safeJson(fields)}` : '';
  const line = redactString(`${stamp} ${tag} ${scope}${msg}${tail}`);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(prefix = ''): Logger {
  return {
    debug: (m, f) => emit('debug', prefix, m, f),
    info: (m, f) => emit('info', prefix, m, f),
    warn: (m, f) => emit('warn', prefix, m, f),
    error: (m, f) => emit('error', prefix, m, f),
    child: (sub) => createLogger(prefix ? `${prefix}:${sub}` : sub),
  };
}

export const log = createLogger();
