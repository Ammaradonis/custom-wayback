/**
 * Auth utilities: password hashing, JWT issue/verify using HS256, and session
 * revocation via D1.
 *
 * Design notes:
 *  - Password hashing lives in `./password.ts` and uses PBKDF2-HMAC-SHA-256 via
 *    WebCrypto. Read that file's header before changing it: the short version is
 *    that `oslo/password`'s Argon2id is the better algorithm but ships native
 *    bindings that cannot be bundled into a Worker, so it is not usable here.
 *  - JWTs are short-lived (7 days) but immediately revocable via the sessions
 *    table in D1 (jti claim matched against sessions.id).
 *  - IP addresses are never stored raw — only sha256(ip) so we cannot
 *    re-identify users from the session table alone.
 */

import { hashPassword, verifyPassword, dummyVerify, needsRehash } from "./password.js";
import type { Env } from "../env.js";
import { JWT_ALGORITHM, JWT_TTL_SECONDS } from "@custom-wayback/shared";

// Re-exported so route handlers keep importing password concerns from one place.
export { hashPassword, verifyPassword, needsRehash, dummyVerify };

// ── JWT (HS256 via Web Crypto) ────────────────────────────────────────────────

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes =
    input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

interface JwtPayload {
  sub: string; // userId
  jti: string; // sessionId (ulid)
  iat: number;
  exp: number;
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueJwt(
  userId: string,
  sessionId: string,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: JWT_ALGORITHM, typ: "JWT" }),
    ),
  );
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: userId,
        jti: sessionId,
        iat: now,
        exp: now + JWT_TTL_SECONDS,
      } satisfies JwtPayload),
    ),
  );
  const signing = new TextEncoder().encode(`${header}.${payload}`);
  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, signing);
  return `${header}.${payload}.${base64url(sig)}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const key = await getSigningKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64url(sig),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return null;
  const claims = JSON.parse(
    new TextDecoder().decode(fromBase64url(payload)),
  ) as JwtPayload;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ── Session helpers ──────────────────────────────────────────────────────────

export async function hashIp(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns the userId if the JWT is valid and the session is not revoked.
 * Returns null otherwise.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return null;

  // Check session revocation in D1.
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM sessions WHERE id = ? AND user_id = ?",
  )
    .bind(claims.jti, claims.sub)
    .first<{ revoked_at: number | null }>();

  if (!row || row.revoked_at !== null) return null;
  return claims.sub;
}
