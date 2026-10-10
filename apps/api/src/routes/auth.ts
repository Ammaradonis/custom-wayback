/**
 * Auth routes: register, login, logout, logout-all.
 *
 * POST /v1/auth/register  { email, password }
 * POST /v1/auth/login     { email, password }  → { token }
 * POST /v1/auth/logout    (Bearer)
 * POST /v1/auth/logout-all (Bearer)
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { RegisterSchema, LoginSchema } from "@custom-wayback/shared";
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  needsRehash,
  issueJwt,
  authenticateRequest,
  hashIp,
} from "../lib/auth.js";
import { ulid } from "../lib/ulid.js";
import { consumeRateLimit, ipBucket } from "../lib/ratelimit.js";
import type { Env } from "../env.js";

export const authRouter = new Hono<{ Bindings: Env }>();

/**
 * Throttle the auth surface by hashed IP.
 *
 * Registration and login are the only unauthenticated, CPU-expensive endpoints
 * we have — Argon2id is deliberately slow, which makes them the natural place
 * for someone to burn our CPU allotment. Keyed by IP hash so we never store a
 * raw address (see `hashIp`).
 */
authRouter.use("/*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = await consumeRateLimit(c.env, ipBucket(await hashIp(ip), "auth"), "auth");
  if (!limit.allowed) {
    return c.json(
      { error: "rate_limited", message: `Too many attempts. Try again in ${limit.retryAfter}s.`, retryAfter: limit.retryAfter },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }
  return next();
});

// ── Register ─────────────────────────────────────────────────────────────────

/**
 * Is self-registration open?
 *
 * The deployed Worker is reachable on a public `*.workers.dev` hostname, and
 * `POST /v1/auth/register` previously accepted anyone. That is not a cosmetic
 * issue: every account created can drive archive.org through the queue, fill D1
 * and R2, and spend the monthly budget — one curl away from a stranger.
 *
 * So registration is **closed unless explicitly opened**. Set `ALLOWED_EMAILS` to
 * a comma-separated list to permit exactly those addresses:
 *
 *   npx wrangler secret put ALLOWED_EMAILS      # or a plain var
 *
 * Default-closed is the right default here because the failure mode of forgetting
 * to configure it is "nobody can sign up", which you notice immediately, whereas
 * the failure mode of default-open is "somebody else is using your quota", which
 * you may never notice.
 *
 * This does not replace Cloudflare Access (plan.md §13), which would gate the
 * whole app rather than just sign-up. It removes the sharpest edge until that is
 * in place.
 */
function registrationPolicy(env: { ALLOWED_EMAILS?: string }): { open: boolean; allowed: string[] } {
  const raw = env.ALLOWED_EMAILS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { open: false, allowed: [] };
  }
  // `*` is the explicit "yes, anyone" escape hatch, so an open instance is a
  // deliberate choice rather than an unset variable.
  if (raw.trim() === "*") return { open: true, allowed: [] };
  const allowed = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  // A list of only separators (" , , ") permits nobody, not everybody.
  return { open: false, allowed };
}

authRouter.post("/register", zValidator("json", RegisterSchema), async (c) => {
  const { email, password } = c.req.valid("json");

  const policy = registrationPolicy(c.env);
  const normalized = email.toLowerCase();
  if (!policy.open && !policy.allowed.includes(normalized)) {
    // Deliberately vague, and deliberately the same response whether the list is
    // empty or the address is merely absent from it: a precise message would tell
    // a stranger which addresses are permitted.
    return c.json(
      {
        error: "registration_closed",
        message:
          "This instance is not accepting new accounts. The owner can allow an " +
          "address by setting ALLOWED_EMAILS.",
      },
      403,
    );
  }

  const existingUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ?",
  )
    .bind(normalized)
    .first();

  if (existingUser) {
    // Return 409 but don't leak whether the email exists via timing — hash anyway.
    await hashPassword(password);
    return c.json({ error: "Email already in use" }, 409);
  }
  const id = ulid();
  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)",
  )
    .bind(id, normalized, passwordHash, now)
    .run();

  return c.json({ ok: true }, 201);
});

// ── Login ────────────────────────────────────────────────────────────────────

authRouter.post("/login", zValidator("json", LoginSchema), async (c) => {
  const { email, password } = c.req.valid("json");

  const user = await c.env.DB.prepare(
    "SELECT id, password_hash, disabled FROM users WHERE email = ?",
  )
    .bind(email.toLowerCase())
    .first<{ id: string; password_hash: string; disabled: number }>();

  // Always do the same work, whether or not the account exists. A faster
  // "no such user" is a user-enumeration oracle.
  const validPassword = user
    ? await verifyPassword(user.password_hash, password)
    : await dummyVerify(password).then(() => false);

  if (!user || !validPassword || user.disabled) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const sessionId = ulid();
  const now = Math.floor(Date.now() / 1000);
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await hashIp(ip);

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, issued_at, expires_at, user_agent, ip_hash)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      sessionId,
      user.id,
      now,
      now + 60 * 60 * 24 * 7, // 7 days
      c.req.raw.headers.get("User-Agent")?.slice(0, 512) ?? null,
      ipHash,
    )
    .run();

  await c.env.DB.prepare(
    "UPDATE users SET last_login_at = ? WHERE id = ?",
  )
    .bind(now, user.id)
    .run();

  // Transparent password upgrade. If `PBKDF2_ITERATIONS` is ever raised, existing
  // records keep working and are re-hashed here, one login at a time — which is
  // what makes the cost a config change rather than a migration.
  if (needsRehash(user.password_hash)) {
    const upgraded = await hashPassword(password);
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(upgraded, user.id)
      .run();
  }

  const token = await issueJwt(user.id, sessionId, c.env.JWT_SECRET);
  return c.json({ token });
});

// ── Logout (current session) ─────────────────────────────────────────────────

authRouter.post("/logout", async (c) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const authHeader = c.req.raw.headers.get("Authorization") ?? "";
  const token = authHeader.slice(7);
  // We need the jti to revoke — re-parse without full verification since we
  // already authenticated above.
  try {
    const [, payloadB64] = token.split(".");
    if (!payloadB64) throw new Error("bad token");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as { jti: string };
    await c.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?",
    )
      .bind(Math.floor(Date.now() / 1000), payload.jti, userId)
      .run();
  } catch {
    // Best-effort.
  }
  return c.json({ ok: true });
});

// ── Logout-all ───────────────────────────────────────────────────────────────

authRouter.post("/logout-all", async (c) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(now, userId)
    .run();

  return c.json({ ok: true });
});
