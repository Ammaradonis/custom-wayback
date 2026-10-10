/**
 * PBKDF2-HMAC-SHA-256 iteration count.
 *
 * ## This value is set by the platform, not by preference
 *
 * OWASP's Password Storage Cheat Sheet lists **600,000** iterations for
 * PBKDF2-HMAC-SHA-256. That is what this was written as, that is what the local
 * suite exercises, and it does NOT work in production on a free Workers plan:
 * the Free plan caps CPU time at roughly 10 ms per request.
 *
 * Measured against the deployed Worker, by registering an account at each cost:
 *
 *   10,000 iterations  -> OK
 *   50,000 iterations  -> OK
 *   100,000 iterations -> OK   <-- this value
 *   150,000 iterations -> HTTP 500 (CPU exceeded)
 *   200,000 iterations -> HTTP 500
 *   600,000 iterations -> HTTP 500 (the OWASP figure)
 *
 * So 100,000 is the highest count observed to work, and it is roughly six times
 * BELOW the OWASP recommendation. That is a real security downgrade, recorded
 * here rather than buried, because the honest position is that this deployment
 * has weaker password hashing than the design calls for.
 *
 * ## What to do about it
 *
 * 1. Upgrade to Workers Paid ($5/month) and set this back to 600_000. That is the
 *    correct fix. The plan floor is already assumed in the plan.md section 11 cost
 *    model, and `[limits] cpu_ms` -- which the Free plan also refuses -- can then
 *    be restored in wrangler.toml.
 * 2. Mitigate around it meanwhile: a long passphrase, and Cloudflare Access in
 *    front of the app (plan.md section 13) so the login form is not the only gate.
 *
 * Do not lower this to make a benchmark look better, and do not raise it without
 * re-running the measurement above. The failure mode is a 500 on login, which is
 * indistinguishable from a wrong password to anyone who is not reading the logs.
 */
export const PBKDF2_ITERATIONS = 100_000;
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
