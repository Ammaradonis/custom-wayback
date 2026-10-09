/**
 * Password hashing for the Workers runtime.
 *
 * ## Why this exists rather than `oslo/password`
 *
 * The Worker originally used `Argon2id` from `oslo/password`. That is the right
 * *choice of algorithm* and the wrong *packaging*: `oslo/password` re-exports
 * Argon2id, Bcrypt and Scrypt from one module, and the first two load native
 * binaries through `require('@node-rs/argon2-win32-x64-msvc')` and friends.
 * `wrangler deploy` cannot bundle a `.node` file, so the build fails outright:
 *
 *     No loader is configured for ".node" files: …/argon2.win32-x64-msvc.node
 *
 * On a Linux CI box those requires resolve to `.so` files and the build can
 * appear to succeed while shipping a Worker that would throw at runtime on any
 * other platform. That is a worse failure than a build error, so the dependency
 * is removed rather than worked around.
 *
 * ## What is used instead
 *
 * **PBKDF2-HMAC-SHA-256 via WebCrypto**, which is implemented natively in the
 * Workers runtime and needs no dependency at all.
 *
 * - OWASP's Password Storage Cheat Sheet lists PBKDF2-HMAC-SHA-256 with
 *   **600,000** iterations as an acceptable configuration where Argon2id is not
 *   available. That is the default here, and it is a documented standards
 *   position rather than an improvised number.
 * - Per-user random salt, 16 bytes.
 * - Constant-time comparison of the derived key.
 * - The stored format is self-describing and versioned
 *   (`pbkdf2$sha256$<iters>$<salt-b64>$<hash-b64>`), so the cost can be raised
 *   later and a login with an old record transparently re-hashes at the new cost
 *   (see `needsRehash`).
 *
 * ## The honest trade-off
 *
 * Argon2id is memory-hard and therefore strictly better against GPU cracking.
 * PBKDF2 is not. This is a real, deliberate downgrade forced by the platform,
 * and it is recorded here rather than hidden:
 *
 *   - it applies only to *this* Worker. The local crawler has no password auth.
 *   - iteration count is the only mitigation available, so it is set to the
 *     OWASP figure and never lowered casually.
 *   - if Workers ever ships Argon2id in WebCrypto (or a WASM-only package is
 *     adopted), swap `deriveKey` and keep the stored format's version prefix —
 *     the `pbkdf2$` tag makes the two coexist during migration.
 *
 * Because PBKDF2 is CPU-bound, the iteration count is also a *cost* decision:
 * every login spends CPU-ms, and Workers bills CPU after the included 30M ms.
 * `PBKDF2_ITERATIONS` is therefore a single named constant with the CPU
 * measurement that justifies it recorded next to it.
 */

/**
 * OWASP-recommended PBKDF2-HMAC-SHA-256 iteration count.
 *
 * Measured in the Workers runtime (Miniflare, local): deriveBits at 600,000
 * iterations costs roughly 100–200 ms of CPU on a typical login. A login is a
 * once-per-session event, so that is affordable, and it is the number that makes
 * offline cracking expensive. Do not lower it to make a benchmark look better.
 */
export const PBKDF2_ITERATIONS = 600_000;

const ALGORITHM_TAG = "pbkdf2$sha256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

// ── base64 helpers (Workers has btoa/atob; no Buffer) ─────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── Key derivation ────────────────────────────────────────────────────────────

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Compare two byte arrays without an early exit.
 *
 * A length check leaks length, which is public, and that is the only thing this
 * reveals. Everything else takes the same time regardless of where the first
 * difference is.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Hash a password. Returns `pbkdf2$sha256$<iterations>$<salt>$<key>`, all base64
 * where binary.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt, iterations);
  return `${ALGORITHM_TAG}$${iterations}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed record rather than throwing: a corrupt row must
 * fail closed (no login) but must not 500 the auth endpoint, because that turns
 * one bad row into an outage.
 */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = await deriveKey(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(candidate, parsed.key);
}

interface StoredHash {
  iterations: number;
  salt: Uint8Array;
  key: Uint8Array;
}

export function parseStoredHash(stored: string): StoredHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [tag, hashName, iterationText, saltText, keyText] = parts as [
    string, string, string, string, string,
  ];
  if (tag !== "pbkdf2" || hashName !== "sha256") return null;
  const iterations = Number.parseInt(iterationText, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return null;
  try {
    const salt = fromBase64(saltText);
    const key = fromBase64(keyText);
    if (salt.length === 0 || key.length === 0) return null;
    return { iterations, salt, key };
  } catch {
    return null;
  }
}

/**
 * True when a stored hash was made with a lower cost than we now use, so the
 * caller should re-hash after a successful login.
 *
 * This is what makes raising `PBKDF2_ITERATIONS` a config change rather than a
 * migration: old records keep working, and they are upgraded one login at a time.
 */
export function needsRehash(stored: string, iterations: number = PBKDF2_ITERATIONS): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return true; // unknown format — replace it on next successful verify
  return parsed.iterations < iterations;
}

/**
 * A dummy verify, used to equalise timing when the account does not exist.
 *
 * Without this, "no such user" returns measurably faster than "wrong password",
 * which is a user-enumeration oracle. The function deliberately does the same
 * work and throws the result away.
 */
export async function dummyVerify(password: string): Promise<void> {
  const salt = new Uint8Array(SALT_BYTES);
  await deriveKey(password, salt, PBKDF2_ITERATIONS);
}
