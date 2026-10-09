/**
 * Minimal ULID generator using the Web Crypto API.
 * Format: 26-character Crockford base32 string, time-sortable.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const time = Date.now();
  const timeChars = encodeTime(time, 10);
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  const randomChars = encodeRandom(randomBytes, 16);
  return timeChars + randomChars;
}

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    str = (ENCODING[mod] ?? "0") + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(bytes: Uint8Array, len: number): string {
  let str = "";
  let bitsLeft = 0;
  let buffer = 0;
  let byteIdx = 0;
  for (let i = 0; i < len; i++) {
    if (bitsLeft < 5) {
      buffer = (buffer << 8) | (bytes[byteIdx++] ?? 0);
      bitsLeft += 8;
    }
    bitsLeft -= 5;
    str += ENCODING[(buffer >> bitsLeft) & 0x1f] ?? "0";
  }
  return str;
}
