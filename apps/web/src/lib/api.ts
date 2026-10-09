/**
 * Typed API client. Reads the JWT from localStorage (key: "cw_token").
 * Never logs or exposes the token value.
 */

const BASE = "/v1";

function getToken(): string | null {
  return localStorage.getItem("cw_token");
}

export function setToken(token: string): void {
  localStorage.setItem("cw_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("cw_token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (resp.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }

  return resp.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  register: (email: string, password: string) =>
    request<{ ok: boolean }>("POST", "/auth/register", { email, password }),
  login: (email: string, password: string) =>
    request<{ token: string }>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),
  logoutAll: () => request<{ ok: boolean }>("POST", "/auth/logout-all"),
};

// ── Domains ───────────────────────────────────────────────────────────────────

export interface DomainEntry {
  id: string;
  domain: string;
  hostFilter: string | null;
  trackingStatus: string;
  addedAt: number;
  lastCrawledAt: number | null;
}

export const domains = {
  list: () => request<DomainEntry[]>("GET", "/domains"),
  add: (rawInput: string, budget?: Record<string, unknown>) =>
    request<{ id: string; domain: string }>("POST", "/domains", { rawInput, budget }),
  remove: (domainId: string) =>
    request<{ ok: boolean }>("DELETE", `/domains/${domainId}`),
  coverage: (domainId: string) =>
    request<string[]>("GET", `/domains/${domainId}/coverage`),
};

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface IngestJob {
  id: string;
  status: string;
  pagesTotal: number;
  pagesDone: number;
  assetsTotal: number;
  assetsDone: number;
  bytesStored: number;
  ia429Count: number;
  errorMessage: string | null;
}

export const ingest = {
  start: (domainId: string, month: string) =>
    request<{ id: string; status: string }>("POST", "/jobs", { domainId, month }),
  status: (ingestId: string) =>
    request<IngestJob>("GET", `/jobs/${ingestId}`),
  cancel: (ingestId: string) =>
    request<{ ok: boolean }>("DELETE", `/jobs/${ingestId}`),
  usage: () => request<{ month: string; usage: unknown[] }>("GET", "/jobs/usage"),
};

// ── SSE helper ────────────────────────────────────────────────────────────────

export function watchIngest(
  ingestId: string,
  onEvent: (ev: unknown) => void,
  onDone: () => void,
): () => void {
  const token = getToken();
  if (!token) return () => void 0;

  const url = `${BASE}/jobs/${ingestId}/events`;
  const es = new EventSource(url);

  es.onmessage = (e) => {
    const data = JSON.parse(e.data as string) as { type: string };
    onEvent(data);
    if (data.type === "done") {
      es.close();
      onDone();
    }
  };
  es.onerror = () => {
    es.close();
    onDone();
  };

  return () => es.close();
}
