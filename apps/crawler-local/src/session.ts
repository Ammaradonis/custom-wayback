/**
 * Signing the crawler in to a deployed Custom Wayback, for `publish`.
 *
 *   npm run login -- --api=https://<your app>.workers.dev            (asks for email, password)
 *   npm run login -- --api=https://<your app>.workers.dev --token=…  (a token you already have)
 *
 * It signs in exactly as the web app does (`POST /v1/auth/login`) and keeps the session
 * token — valid for 7 days, revoked by "sign out everywhere" — in the data directory, which
 * is git-ignored. `CW_TOKEN` in the environment overrides the saved one, for scripts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export interface Session {
  api: string;
  token: string;
  email: string | null;
  savedAt: number;
}

export class SessionError extends Error {}

export function sessionPath(outDir: string): string {
  return join(outDir, 'publish-session.json');
}

/** `https://host` with no trailing slash; plain http only for this machine. */
export function normaliseApi(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SessionError(`--api must be the deployed app's address, e.g. https://custom-wayback-api.example.workers.dev (got "${raw}")`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new SessionError('--api must use https:// (http:// is accepted only for localhost)');
  }
  return url.origin;
}

export async function loadSession(outDir: string): Promise<Session | null> {
  try {
    const saved = JSON.parse(await readFile(sessionPath(outDir), 'utf8')) as Partial<Session>;
    if (typeof saved.api !== 'string' || typeof saved.token !== 'string') return null;
    return { api: saved.api, token: saved.token, email: saved.email ?? null, savedAt: saved.savedAt ?? 0 };
  } catch {
    return null;
  }
}

export async function saveSession(outDir: string, session: Session): Promise<string> {
  const path = sessionPath(outDir);
  await mkdir(dirname(path), { recursive: true });
  // Owner-only where the filesystem has such a thing; a bearer token is a password.
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** The session to publish with: `--token`/`CW_TOKEN` first, then the saved one. */
export async function resolveSession(outDir: string, apiFlag: string, tokenFlag: string): Promise<Session> {
  const token = tokenFlag || process.env.CW_TOKEN || '';
  const saved = await loadSession(outDir);
  const api = apiFlag ? normaliseApi(apiFlag) : saved?.api;
  if (!api) {
    throw new SessionError('not signed in: run npm run login -- --api=https://<your app>.workers.dev first');
  }
  if (token) return { api, token, email: null, savedAt: Date.now() };
  if (!saved || saved.api !== api) {
    throw new SessionError(`not signed in to ${api}: run npm run login -- --api=${api} first`);
  }
  return saved;
}

export async function login(api: string, email: string, password: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${api}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status === 401) throw new SessionError('that email and password were not accepted');
  if (!response.ok) throw new SessionError(`sign-in failed: HTTP ${response.status}`);
  const { token } = (await response.json()) as { token?: unknown };
  if (typeof token !== 'string' || token.length === 0) throw new SessionError('sign-in answered without a token');
  return token;
}

/** A token is good if an authenticated, read-only call accepts it. */
export async function verifyToken(api: string, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${api}/v1/precrawl?domain=example.com&month=2000-01`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  if (response.status === 401) throw new SessionError(`${api} did not accept that token`);
  if (!response.ok) throw new SessionError(`${api} answered HTTP ${response.status}; is --api the app's address?`);
}

/** Read a line from the terminal; with `hidden`, nothing typed is echoed. */
export async function prompt(question: string, hidden = false): Promise<string> {
  const { stdin, stdout } = process;
  if (!hidden || !stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new SessionError('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
