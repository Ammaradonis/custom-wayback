/**
 * Archive.org authentication — "S3-like" keys, sent as `Authorization: LOW key:secret`.
 *
 * ## Why this exists
 *
 * Anonymous archive.org traffic is rate-limited **per IP address**. A Worker has no stable
 * IP: it egresses from whatever Cloudflare edge node handles the request, so a crawl's
 * requests look like a crowd of unrelated clients, and archive.org's limiter reacts to the
 * noisiest of them. Measured on 2026-10-24, a single crawl of one homepage collected
 * **12 backoff events and 8 circuit-breaker trips** — it never stored a page.
 *
 * Archive.org tracks authenticated requests **per account** rather than per IP, which is
 * exactly the identity a distributed crawl lacks. The scheme is theirs, not a workaround:
 * the same `LOW <access>:<secret>` header is what the official `internetarchive` library
 * and the Save Page Now API send, and the keys come from the account profile
 * (`https://archive.org/account/s3.php`).
 *
 * ## What is deliberately *not* implemented from `edge-cases.txt`
 *
 * That note also lists proxy rotation, Tor, TLS-fingerprint spoofing (`curl_cffi`) and
 * BitTorrent. Those are not implemented, and not because they are hard:
 *
 *  - **Proxy rotation / Tor** evades a limit rather than answering it, and it would push
 *    the cost onto archive.org and onto strangers' exit nodes to serve one user's crawl.
 *    This project's whole premise is a polite client (plan §12); quietly becoming a
 *    different client per request is the opposite of that promise.
 *  - **TLS fingerprint spoofing** cannot work here: Workers do not expose the TLS stack,
 *    so there is nothing to spoof.
 *  - **BitTorrent** applies to bulk *item* downloads, not to fetching individual web
 *    captures, which is all this app does.
 *  - **Session cookies from an account password** would mean storing a password that
 *    unlocks the whole account. Keys are revocable and scoped; a password is not. If the
 *    session-cookie path is ever needed, it should be a cookie obtained out of band.
 *
 * So: authenticate first, stay slow and jittered second (`applyThrottle`), and treat 429
 * as an instruction rather than an obstacle.
 */

/** The bindings this module needs. Both are optional so the app boots without them. */
export interface ArchiveAuthEnv {
  ARCHIVE_S3_ACCESS_KEY?: string;
  ARCHIVE_S3_SECRET_KEY?: string;
}

/**
 * Headers that authenticate a request to archive.org, or `{}` when unconfigured.
 *
 * Both halves are required: archive.org rejects a bare key, and sending half of a pair
 * would turn every request into an authenticated *failure* instead of anonymous success.
 * Values are trimmed because a secret pasted through a shell often carries a newline,
 * and a trailing newline inside an `Authorization` header is a hard error in the fetch
 * API rather than a silent mismatch.
 */
export function archiveAuthHeaders(env: ArchiveAuthEnv): Record<string, string> {
  const access = env.ARCHIVE_S3_ACCESS_KEY?.trim();
  const secret = env.ARCHIVE_S3_SECRET_KEY?.trim();
  if (!access || !secret) return {};
  return { Authorization: `LOW ${access}:${secret}` };
}

/** How requests are being attributed, for `/v1/health` and degraded messages. */
export function archiveAuthMode(env: ArchiveAuthEnv): "authenticated" | "anonymous" {
  return Object.keys(archiveAuthHeaders(env)).length > 0 ? "authenticated" : "anonymous";
}

/**
 * Is this URL an archive.org host that should carry credentials?
 *
 * The keys are for archive.org only. Sending them to any other host — an archived site's
 * own origin, a redirect target, a CDN — would leak a credential to a third party, so
 * every caller gates on this rather than attaching headers unconditionally.
 */
export function isArchiveHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "archive.org" ||
      host.endsWith(".archive.org") ||
      host === "web.archive.org" ||
      host.endsWith(".web.archive.org")
    );
  } catch {
    return false;
  }
}

/** Archive auth plus a caller's own headers, only for archive.org URLs. */
export function archiveHeadersFor(url: string, env: ArchiveAuthEnv, extra: Record<string, string> = {}): Record<string, string> {
  return isArchiveHost(url) ? { ...archiveAuthHeaders(env), ...extra } : { ...extra };
}
