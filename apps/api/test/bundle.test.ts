/**
 * The export bundle format, tested where it can actually be tested.
 *
 * ## Why these tests are shaped the way they are
 *
 * The deliverable of this feature is a file that somebody else's computer can open
 * — after this Worker, this bucket and this repository are gone. So the tests that
 * matter are not "was the route called" but:
 *
 *   1. **Is it a zip?** Not "does our own reader read it": the exact 32-bit
 *      signatures at the exact offsets, the entry count and central-directory
 *      offset in the end-of-central-directory record, and an *independently
 *      written* CRC-32 agreeing with the one the writer produced. A zip only its
 *      author can read is not a zip.
 *   2. **Does every reference resolve to a file in the archive?** The stored HTML
 *      points at `/a/<domain>/<day>/<path>` and `/assets/<hh>/<hash>`, which exist
 *      only on our origin. If one survives, the bundle is broken for the person
 *      who receives it — and they are the one who cannot debug it.
 *   3. **Is it reproducible?** The same input has to produce the same bytes, or
 *      "did the export change?" is unanswerable and this format is untestable.
 *
 * Everything under test here is pure: bytes in, bytes out, no R2, no `fetch`, no
 * Worker runtime. That is the reason `lib/bundle.ts` exists as a separate module
 * from `routes/export.ts` at all.
 *
 * ## Two layers, on purpose
 *
 * A stored page is repointed at the bundle by `pageRewrites`/`rewriteValue`
 * (pure, tested directly); the result is applied to HTML by `HTMLRewriter` in the
 * route. Node has no `HTMLRewriter`, and the route's handlers are three lines each
 * that call the pure function and write the answer back — so `applyPlan` below
 * stands in for the rewriter the way `viewer.test.ts` stands in for it, walking
 * the same attributes and calling the *same* function. What that cannot prove is
 * that lol-html parses like this test does; that is `wrangler deploy --dry-run`'s
 * job, and the route is written to stay small enough for that division of labour
 * to be honest.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  INDEX_ENTRY,
  README_ENTRY,
  assetEntryName,
  buildIndexHtml,
  buildReadme,
  buildZip,
  buildZipStream,
  collectAssetHashes,
  countMissing,
  crc32,
  dosTimestamp,
  extractPageTitle,
  pageEntryName,
  pageRewrites,
  relativeHref,
  rewriteUrlsInText,
  rewriteValue,
  utf8,
  type PageLocation,
  type ZipEntry,
} from "../src/lib/bundle.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DOMAIN = "example.com";
const DAY = "2024-03-15";
const TS = "20240315120000";

/** A real SHA-256-shaped asset key: exactly 64 lowercase hex digits. */
const LOGO_HASH = hex64("ab", "c0de");
const LOGO_TOKEN = `/assets/${LOGO_HASH.slice(0, 2)}/${LOGO_HASH}`;

/** Build a 64-hex fixture key from a prefix and a suffix, padded in between. */
function hex64(prefix: string, suffix: string): string {
  const hash = prefix + "7".repeat(64 - prefix.length - suffix.length) + suffix;
  assert.equal(hash.length, 64, `fixture hash ${hash} is not 64 hex digits`);
  assert.match(hash, /^[0-9a-f]{64}$/);
  return hash;
}

const HOME_URL = `https://${DOMAIN}/`;
const ABOUT_URL = `https://${DOMAIN}/about`;
const PRODUCTS_URL = `https://${DOMAIN}/products/`;
const GONE_URL = `https://${DOMAIN}/pricing`;

const HOME_ENTRY = pageEntryName(DAY, HOME_URL);
const ABOUT_ENTRY = pageEntryName(DAY, ABOUT_URL);
const PRODUCTS_ENTRY = pageEntryName(DAY, PRODUCTS_URL);

/** The 16-hex digest `pageEntryName` puts in the filename. */
const HOME_DIGEST = "e0fbd8b4bbaf2b22";
const ABOUT_DIGEST = "309efa69a5a4ef39";

/** How a sibling page links to another page: relative to this page's directory. */
const ABOUT_HREF = relativeHref(HOME_ENTRY, ABOUT_ENTRY);
const PRODUCTS_HREF = relativeHref(HOME_ENTRY, PRODUCTS_ENTRY);

/**
 * A page as the ingest rewriter leaves it: an injected `<base href="/">`, links
 * rewritten to viewer routes, asset references rewritten to content-addressed
 * routes, and an external link the rewriter already made absolute.
 *
 * The 2024-03-16 link is the interesting one — a page captured on a day this
 * bundle does not contain has no file to point at, so it has to be left exactly
 * as it is rather than guessed at.
 */
function storedPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<base href="/">
<title>Example Domain — Home</title>
<link rel="stylesheet" href="${LOGO_TOKEN}">
<style>.hero { background-image: url('${LOGO_TOKEN}'); }</style>
</head>
<body>
<h1>Example Domain</h1>
<img src="${LOGO_TOKEN}" srcset="${LOGO_TOKEN} 1x, ${LOGO_TOKEN} 2x" alt="logo">
<a href="/a/${DOMAIN}/${DAY}/about">About us</a>
<a href="/a/${DOMAIN}/${DAY}/products/">Products</a>
<a href="/a/${DOMAIN}/2024-03-16/other">Tomorrow</a>
<a href="https://example.org/external">Elsewhere</a>
</body>
</html>`;
}

function locations(): PageLocation[] {
  return [
    { url: HOME_URL, entry: HOME_ENTRY },
    { url: ABOUT_URL, entry: ABOUT_ENTRY },
    { url: PRODUCTS_URL, entry: PRODUCTS_ENTRY },
  ];
}

/** A payload DEFLATE comfortably beats, and comfortably past a few KB. */
function bigPage(note: string): string {
  const row = `<tr><td>${note}</td><td>SKU-${note.length}</td><td>19.99</td></tr>\n`;
  return `<!DOCTYPE html><html><head><title>Products</title></head><body><table>${row.repeat(400)}</table></body></html>`;
}

function smallBundleEntries(): ZipEntry[] {
  return [
    { name: INDEX_ENTRY, bytes: utf8("<html><body>index</body></html>") },
    { name: README_ENTRY, bytes: utf8("readme\n") },
    { name: HOME_ENTRY, bytes: utf8("<html>home</html>") },
    { name: assetEntryName(LOGO_HASH), bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
  ];
}

/** Raw DEFLATE through the platform's compressor — the encoder the route passes. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (bytes.length < 128) return undefined;
  const stream = new Blob([bytes as unknown as ArrayBufferView]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return compressed.length > 0 && compressed.length < bytes.length ? compressed : undefined;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as ArrayBufferView]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── A ZIP reader that shares nothing with the writer ─────────────────────────
//
// Independent on purpose: it reads the file the way an unzipper does — from the
// end-of-central-directory record backwards — rather than trusting anything the
// writer happens to still have in memory.

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** The bytes exactly as stored (compressed when `method` is 8). */
  raw: Uint8Array;
  /** The bytes after decompression. */
  data: Uint8Array;
  dosTime: number;
  dosDate: number;
  flags: number;
}

interface Eocd {
  offset: number;
  count: number;
  size: number;
  centralOffset: number;
}

function findEocd(zip: Uint8Array): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) return at;
  }
  throw new Error("no end-of-central-directory record found");
}

function readEocd(zip: Uint8Array): Eocd {
  const offset = findEocd(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  return {
    offset,
    count: view.getUint16(offset + 10, true),
    size: view.getUint32(offset + 12, true),
    centralOffset: view.getUint32(offset + 16, true),
  };
}

async function readZip(zip: Uint8Array): Promise<ParsedEntry[]> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = readEocd(zip);
  const decoder = new TextDecoder();

  const entries: ParsedEntry[] = [];
  let at = eocd.centralOffset;
  for (let i = 0; i < eocd.count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, `central directory record ${i} has the wrong signature`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const dosTime = view.getUint16(at + 12, true);
    const dosDate = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));

    // The local header must agree with the central directory, because that is the
    // record an unzipper streams past when it extracts by walking forward.
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `${name}: local header signature`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    assert.equal(view.getUint16(localOffset + 8, true), method, `${name}: local and central methods differ`);
    assert.equal(view.getUint32(localOffset + 18, true), compressedSize, `${name}: local and central sizes differ`);
    assert.equal(decoder.decode(zip.subarray(localOffset + 30, localOffset + 30 + localNameLength)), name);

    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataAt, dataAt + compressedSize);
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      raw,
      data: method === 8 ? await inflateRaw(raw) : raw,
      dosTime,
      dosDate,
      flags,
    });

    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** CRC-32, written independently of the implementation under test. */
function referenceCrc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

// ── Stand-in for the rewriter in the route ───────────────────────────────────

/**
 * The attributes `rewritePageHtml` visits, in the order it visits them. If the
 * route learns a new one, this list is where a test notices it should too.
 */
const SINGLE_ATTRIBUTES = ["href", "src", "poster"] as const;
const SRCSET_ATTRIBUTE = "srcset";
const STYLE_ATTRIBUTE = "style";

interface Reference {
  attribute: string;
  value: string;
}

/** Every absolute reference on a page, wherever it hides. */
function referenceValues(html: string): Reference[] {
  const found: Reference[] = [];
  // The `<base>` element is not a reference to a file: its href sets the resolution
  // root for everything else on the page, so it is collected separately and left out
  // of the "does this point at a bundled entry" walk. Its own assertion is above.
  const body = html.replace(/<base[^>]*>/gi, "");
  for (const attribute of SINGLE_ATTRIBUTES) {
    for (const match of body.matchAll(new RegExp(`[\\s"']${attribute}\\s*=\\s*"([^"]*)"`, "gi"))) {
      if (match[1] !== undefined) found.push({ attribute, value: match[1] });
    }
  }
  for (const match of body.matchAll(new RegExp(`[\\s"']${SRCSET_ATTRIBUTE}\\s*=\\s*"([^"]*)"`, "gi"))) {
    for (const part of (match[1] ?? "").split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) found.push({ attribute: SRCSET_ATTRIBUTE, value: url });
    }
  }
  for (const match of body.matchAll(new RegExp(`[\\s"']${STYLE_ATTRIBUTE}\\s*=\\s*"([^"]*)"`, "gi"))) {
    for (const url of (match[1] ?? "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (url[1]) found.push({ attribute: STYLE_ATTRIBUTE, value: url[1] });
    }
  }
  for (const match of body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const url of (match[1] ?? "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (url[1]) found.push({ attribute: "style-block", value: url[1] });
    }
  }
  const base = /<base[^>]*\shref\s*=\s*"([^"]*)"/i.exec(html);
  if (base?.[1] !== undefined) found.push({ attribute: "base", value: base[1] });
  return found;
}

/**
 * Apply a plan the way the route's handlers do: the pure `rewriteValue` /
 * `rewriteUrlsInText` decide, and the answer is substituted into the markup.
 * `<base>` is handled by name, exactly as the route's own `base` handler does.
 */
function applyPlan(html: string, plan: ReturnType<typeof pageRewrites>): string {
  let out = html.replace(/(<base[^>]*?\shref\s*=\s*")([^"]*)(")/gi, (_all, before: string, _value: string, after: string) => {
    return `${before}${plan.base}${after}`;
  });

  for (const attribute of [...SINGLE_ATTRIBUTES, STYLE_ATTRIBUTE]) {
    const pattern = new RegExp(`([\\s"']${attribute}\\s*=\\s*")([^"]*)(")`, "gi");
    out = out.replace(pattern, (_all, before: string, value: string, after: string) => {
      if (attribute === STYLE_ATTRIBUTE) return `${before}${rewriteUrlsInText(value, plan)}${after}`;
      return `${before}${rewriteValue(plan, value) ?? value}${after}`;
    });
  }

  out = out.replace(
    /([\s"']srcset\s*=\s*")([^"]*)(")/gi,
    (_all, before: string, value: string, after: string) => {
      const next = value
        .split(",")
        .map((part) => {
          const [url, ...descriptor] = part.trim().split(/\s+/);
          if (!url) return part.trim();
          return [rewriteValue(plan, url) ?? url, ...descriptor].join(" ");
        })
        .join(", ");
      return `${before}${next}${after}`;
    },
  );

  out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_all, open: string, css: string, close: string) => {
    return `${open}${rewriteUrlsInText(css, plan)}${close}`;
  });
  return out;
}

/**
 * `href` resolved against the entry that contains it — the walk a browser does,
 * and the thing the bundle's portability claim rests on.
 */
function resolveAttribute(entry: string, value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return value;
  const segments = entry.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/** The 16-hex digest `pageEntryName` appends, recomputed from first principles. */
function hash16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

// ── 1. The container ─────────────────────────────────────────────────────────

test("a zip is a zip: signatures, counts, offsets and CRCs an independent reader agrees with", async () => {
  const entries = smallBundleEntries();
  const zip = await buildZip(entries);

  assert.deepEqual([...zip.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "local file header signature is PK\\x03\\x04");

  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = readEocd(zip);
  assert.deepEqual(
    [...zip.subarray(eocd.offset, eocd.offset + 4)],
    [0x50, 0x4b, 0x05, 0x06],
    "end-of-central-directory signature is PK\\x05\\x06",
  );
  assert.equal(eocd.count, entries.length, "the EOCD entry count is the number of entries written");
  assert.equal(view.getUint16(eocd.offset + 8, true), entries.length, "entries on this disk");
  assert.deepEqual(
    [...zip.subarray(eocd.centralOffset, eocd.centralOffset + 4)],
    [0x50, 0x4b, 0x01, 0x02],
    "the EOCD's central-directory offset points at a central directory header (PK\\x01\\x02)",
  );
  assert.equal(eocd.centralOffset + eocd.size, eocd.offset, "the central directory ends where the EOCD begins");
  assert.equal(eocd.offset, zip.length - 22, "a zip with no comment ends at its EOCD");

  // Parse our own output back out and check it against the input.
  const parsed = await readZip(zip);
  assert.deepEqual(
    parsed.map((entry) => entry.name),
    entries.map((entry) => entry.name),
    "entry names and order survive the round trip",
  );
  for (const [i, entry] of entries.entries()) {
    const read = parsed[i] as ParsedEntry;
    assert.equal(read.size, entry.bytes.length, `${read.name}: uncompressed size`);
    assert.equal(read.crc, referenceCrc32(entry.bytes), `${read.name}: CRC-32 matches an independent implementation`);
    assert.equal(read.crc, crc32(entry.bytes), `${read.name}: CRC-32 matches the writer's own`);
    assert.deepEqual([...read.data], [...entry.bytes], `${read.name}: contents round-trip byte for byte`);
    assert.equal(read.flags & 0x0800, 0x0800, `${read.name}: the UTF-8 name flag is set`);
  }
});

test("a deflated few-KB entry inflates back to the original, and a small one is stored", async () => {
  const body = utf8(bigPage("compression-candidate"));
  assert.ok(body.length > 4096, `the fixture must be more than a few KB, got ${body.length} bytes`);

  // Below the compression floor: a compressor is not even consulted, because for a
  // few hundred bytes the DEFLATE framing costs more than the entropy it saves.
  const tiny = new Uint8Array(64);
  for (let i = 0; i < tiny.length; i += 1) tiny[i] = (i * 37) % 256;

  const zip = await buildZip(
    [
      { name: "pages/example.com/2024-03-15/products.html", bytes: body },
      { name: "assets/ff/tiny", bytes: tiny },
    ],
    { deflate: deflateRaw },
  );

  const parsed = await readZip(zip);
  const page = parsed.find((entry) => entry.name.endsWith("products.html")) as ParsedEntry;
  const asset = parsed.find((entry) => entry.name.startsWith("assets/")) as ParsedEntry;

  assert.equal(page.method, 8, "a few-KB text page is DEFLATE-compressed (method 8)");
  assert.ok(page.compressedSize < page.size, `compression must shrink the entry (${page.compressedSize} < ${page.size})`);
  assert.equal(page.size, body.length);
  assert.equal(page.crc, referenceCrc32(body));
  assert.deepEqual([...page.data], [...body], "the inflated bytes are the original page");

  assert.equal(asset.method, 0, "an entry below the compression floor is stored (method 0)");
  assert.equal(asset.compressedSize, tiny.length);
  assert.deepEqual([...asset.data], [...tiny], "stored bytes are byte-identical");
});

test("buildZipStream emits the same archive as buildZip, in bounded pieces", async () => {
  const entries = smallBundleEntries();
  const oneShot = await buildZip(entries);

  const chunks: Uint8Array[] = [];
  for await (const chunk of buildZipStream(entries)) chunks.push(chunk);
  assert.ok(chunks.length >= 1, "the stream yields whole records");

  const streamed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    streamed.set(chunk, at);
    at += chunk.length;
  }
  assert.deepEqual([...streamed], [...oneShot], "streaming changes nothing about the bytes");

  const parsed = await readZip(streamed);
  assert.equal(parsed.length, entries.length);

  // Bounded memory is the reason this generator exists: a bundle big enough to
  // matter arrives in slices rather than as one buffer.
  const big: ZipEntry[] = [{ name: "big.bin", bytes: new Uint8Array(100 * 1024).fill(7) }];
  const bigChunks: Uint8Array[] = [];
  for await (const chunk of buildZipStream(big)) {
    bigChunks.push(chunk);
    assert.ok(chunk.length <= 64 * 1024, `a slice of ${chunk.length} bytes is not bounded`);
  }
  assert.ok(bigChunks.length > 1, "a 100 KB entry must be emitted in more than one slice");

  // The writer refuses to emit a member that could escape the archive.
  await assert.rejects(
    () => buildZip([{ name: "../escape.txt", bytes: utf8("no") }]),
    /unsafe zip entry name/,
  );
});

// ── 2. The links ─────────────────────────────────────────────────────────────

test("link rewriting: every /a/ and /assets/ reference becomes a file that is in the zip", () => {
  const plan = pageRewrites(DOMAIN, { url: HOME_URL, entry: HOME_ENTRY }, locations(), [LOGO_HASH]);
  assert.equal(plan.base, "./", "the injected base becomes a no-op inside the archive");

  const rewritten = applyPlan(storedPage(), plan);

  // The requirement, stated as an assertion. A viewer route may survive in exactly
  // one situation — a link to a day this bundle does not contain, which has no file
  // to point at — and the check below is written so that "one, and it is the known
  // one" fails just as loudly as "many".
  const survivors = [...rewritten.matchAll(/\/a\/[^\s"']*/g)].map((match) => match[0]);
  assert.deepEqual(
    survivors,
    [`/a/${DOMAIN}/2024-03-16/other`],
    `the only viewer route left may be the day the bundle does not hold, got: ${survivors.join(", ")}`,
  );
  assert.ok(!rewritten.includes(`/a/${DOMAIN}/${DAY}/`), "a link to a bundled day survived rewriting");
  assert.equal(rewritten.includes('<base href="/">'), false, "the ingest base tag must not keep its root-relative href");
  assert.ok(rewritten.includes('<base href="./">'), "the base is replaced, not merely dropped");

  // No absolute asset route survives, in any of the shapes it can take. The check
  // is for a *reference* — `/assets/…` at the start of a URL — because the rewritten
  // relative path legitimately ends with the same text. The viewer-route half of
  // this is covered by the `survivors` assertion above, which allows exactly the one
  // day the bundle does not hold.
  assert.equal(/(?:^|["'(=\s])\/assets\//m.test(rewritten), false, "an absolute asset route survived rewriting");
  assert.ok(
    rewritten.includes(`../../../${assetEntryName(LOGO_HASH)}`),
    "the asset reference should be a relative path into the bundle",
  );

  // Every reference the bundle owns resolves to an entry that exists — pages and
  // assets alike, which is the whole claim of a self-contained archive. Two kinds of
  // reference are excluded, and both are deliberate: a link out to the live internet
  // (which is not ours to bundle) and the one viewer route to a day this bundle does
  // not hold (which has no file to point at, so leaving it is the honest outcome).
  const entryNames = new Set([
    INDEX_ENTRY,
    README_ENTRY,
    HOME_ENTRY,
    ABOUT_ENTRY,
    PRODUCTS_ENTRY,
    assetEntryName(LOGO_HASH),
  ]);
  const owned = referenceValues(rewritten).filter(
    (ref) =>
      ref.attribute !== "base" &&
      !/^[a-z][a-z0-9+.-]*:/i.test(ref.value) &&
      !ref.value.startsWith(`/a/`),
  );
  assert.ok(owned.length >= 4, `expected several rewritten references, saw ${owned.length}`);
  for (const ref of owned) {
    const resolved = resolveAttribute(HOME_ENTRY, ref.value);
    assert.ok(entryNames.has(resolved), `${ref.attribute}="${ref.value}" resolves to "${resolved}", not in the bundle`);
  }

  // Specifically: page links point at pages, asset references at the asset.
  const hrefs = referenceValues(rewritten)
    .filter((ref) => ref.attribute === "href")
    .map((ref) => resolveAttribute(HOME_ENTRY, ref.value));
  assert.ok(hrefs.includes(ABOUT_ENTRY), `expected a link to ${ABOUT_ENTRY}, got ${hrefs.join(", ")}`);
  assert.ok(hrefs.includes(assetEntryName(LOGO_HASH)), "the stylesheet link points at the bundled asset");

  // A day the bundle does not hold, and an external link, are left exactly alone.
  assert.ok(
    rewritten.includes(`href="/a/${DOMAIN}/2024-03-16/other"`),
    "a link to a day the bundle does not hold must not be invented",
  );
  assert.ok(rewritten.includes('href="https://example.org/external"'), "an external link is untouched");
});

test("the base tag: relative references resolve from the page, not from the filesystem root", () => {
  // The failure this prevents, concretely. With `<base href="/">` a page extracted
  // to `C:\archive\` looks for its stylesheet at the root of the drive; with `./`
  // it looks next to itself. One of those works.
  const plan = pageRewrites(DOMAIN, { url: HOME_URL, entry: HOME_ENTRY }, locations(), [LOGO_HASH]);
  assert.equal(plan.base, "./");
  assert.equal(resolveAttribute(HOME_ENTRY, plan.assets.get(LOGO_TOKEN) as string), assetEntryName(LOGO_HASH));
  assert.equal(resolveAttribute(HOME_ENTRY, plan.links.get(`/a/${DOMAIN}/${DAY}/about`) as string), ABOUT_ENTRY);

  // And at depth, where a root-relative path is most obviously wrong. The page
  // entry here has six directories above it — `pages`, the host, the day, and the
  // three the URL asks for — so six `../` is the correct answer, and it is derived
  // from the entry rather than assumed. The point is that the count follows the
  // path: a hardcoded depth passes one case and breaks the next.
  const deepUrl = "https://www.example.com/a/b/c/page";
  const deepEntry = pageEntryName(DAY, deepUrl);
  assert.equal(deepEntry.split("/").length - 1, 6, "six directories above the file");
  const deepPlan = pageRewrites(DOMAIN, { url: deepUrl, entry: deepEntry }, [{ url: HOME_URL, entry: HOME_ENTRY }], [LOGO_HASH]);
  assert.equal(deepPlan.base, "./", "the base is relative to the page wherever the page is filed");

  const logoHref = deepPlan.assets.get(LOGO_TOKEN) as string;
  assert.equal(logoHref, relativeHref(deepEntry, assetEntryName(LOGO_HASH)));
  assert.equal(logoHref, `../../../../../../${assetEntryName(LOGO_HASH)}`, "six directories up to the zip root");
  assert.equal(resolveAttribute(deepEntry, logoHref), assetEntryName(LOGO_HASH));
  assert.equal(resolveAttribute(deepEntry, deepPlan.links.get(`/a/${DOMAIN}/${DAY}/`) as string), HOME_ENTRY);

  // The general rule, checked at three different depths so a hardcoded count
  // cannot pass: the prefix is one `../` per directory above the page, minus the
  // directories it shares with its target.
  const atDepth = (depth: number): { entry: string; href: string } => {
    const url = `https://${DOMAIN}/${"d/".repeat(depth)}leaf`;
    const entry = pageEntryName(DAY, url);
    return { entry, href: relativeHref(entry, assetEntryName(LOGO_HASH)) };
  };
  for (const depth of [0, 1, 4]) {
    const { entry, href } = atDepth(depth);
    const ups = href.split("/").filter((part) => part === "..").length;
    assert.equal(ups, entry.split("/").length - 1, `depth ${depth}: one ../ per directory above the page`);
    assert.equal(resolveAttribute(entry, href), assetEntryName(LOGO_HASH), `depth ${depth}: the href resolves back`);
  }

  // A page in the same directory as another needs no prefix at all — the case
  // that produces a stray `../` or a double slash when the arithmetic is sloppy.
  const sibling = relativeHref(HOME_ENTRY, ABOUT_ENTRY);
  assert.equal(sibling.includes(".."), false, `a sibling link needs no parent segments, got ${sibling}`);
  assert.equal(relativeHref(INDEX_ENTRY, `${INDEX_ENTRY}`), "index.html", "the root links to itself by name");
});

test("srcset candidates and a query-string route are both rewritten", () => {
  const searchUrl = `https://${DOMAIN}/search?q=shoes`;
  const searchEntry = pageEntryName(DAY, searchUrl);
  const plan = pageRewrites(DOMAIN, { url: HOME_URL, entry: HOME_ENTRY }, [{ url: searchUrl, entry: searchEntry }], [LOGO_HASH]);

  const candidates = `${LOGO_TOKEN} 1x, ${LOGO_TOKEN} 2x, https://cdn.example.org/x.png 3x`
    .split(",")
    .map((part) => {
      const [url, ...descriptor] = part.trim().split(/\s+/);
      if (!url) return part.trim();
      return [rewriteValue(plan, url) ?? url, ...descriptor].join(" ");
    })
    .join(", ")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0]);

  assert.equal(candidates[0], relativeHref(HOME_ENTRY, assetEntryName(LOGO_HASH)));
  assert.equal(candidates[1], candidates[0], "both density descriptors keep working");
  assert.equal(candidates[2], "https://cdn.example.org/x.png", "a third-party candidate is not ours to rewrite");

  // The ingest path percent-encodes the query into the path
  // (`/a/example.com/2024-03-15/search%3Fq%3Dshoes`), and some parsers decode it
  // before we ever see it. Both spellings have to find the same entry.
  const encoded = `/a/${DOMAIN}/${DAY}/search%3Fq%3Dshoes`;
  const decoded = `/a/${DOMAIN}/${DAY}/search?q=shoes`;
  assert.equal(rewriteValue(plan, encoded), relativeHref(HOME_ENTRY, searchEntry), "the encoded spelling maps");
  assert.equal(rewriteValue(plan, decoded), relativeHref(HOME_ENTRY, searchEntry), "the decoded spelling maps");

  // A URL nothing maps to is left alone rather than blanked.
  assert.equal(rewriteValue(plan, "https://cdn.example.org/x.png"), undefined);
  assert.equal(rewriteValue(plan, ""), undefined);
  assert.equal(rewriteValue(plan, null), undefined);
});

test("page entry names are readable, unique per URL, and safe to extract", () => {
  assert.equal(HOME_ENTRY, `pages/${DOMAIN}/${DAY}/index-${HOME_DIGEST}.html`);
  assert.equal(ABOUT_ENTRY, `pages/${DOMAIN}/${DAY}/about-${ABOUT_DIGEST}.html`);
  assert.equal(PRODUCTS_ENTRY, `pages/${DOMAIN}/${DAY}/products/index-${hash16(PRODUCTS_URL)}.html`);

  // A link inside a page points at a file, not at a directory: `file://` has no
  // index resolution, so `about/` from a sibling page would reach nothing.
  assert.equal(ABOUT_HREF, `about-${ABOUT_DIGEST}.html`);
  assert.equal(PRODUCTS_HREF, `products/index-${hash16(PRODUCTS_URL)}.html`);
  assert.equal(resolveAttribute(HOME_ENTRY, ABOUT_HREF), ABOUT_ENTRY);
  assert.equal(resolveAttribute(HOME_ENTRY, PRODUCTS_HREF), PRODUCTS_ENTRY);
  assert.equal(relativeHref(INDEX_ENTRY, HOME_ENTRY), HOME_ENTRY, "from the zip root, a page's own path is the href");

  // Two URLs that slugify identically must not collide, or one page silently
  // replaces the other inside the archive.
  assert.notEqual(pageEntryName(DAY, `https://${DOMAIN}/About`), pageEntryName(DAY, `https://${DOMAIN}/about`));

  // Nothing that could escape the archive, on any filesystem.
  for (const url of [
    `https://${DOMAIN}/../../etc/passwd`,
    `https://${DOMAIN}/a%2F..%2Fb`,
    `https://${DOMAIN}/weird:name?x=1`,
    "https://www.example.com/",
    `https://${DOMAIN}/${"segment/".repeat(40)}`,
    `https://${DOMAIN}/${"x".repeat(300)}`,
    "not a url at all",
  ]) {
    const entry = pageEntryName(DAY, url);
    assert.ok(!entry.startsWith("/"), `${entry} must be relative`);
    assert.ok(!entry.split("/").includes(".."), `${entry} must not contain a parent segment`);
    assert.ok(!/[<>:"|?*]/.test(entry), `${entry} must be extractable on Windows`);
    assert.ok(entry.length < 260, `${entry} (${entry.length} chars) must fit a filesystem path`);
    assert.ok(entry.endsWith(".html"), `${entry} must be an HTML file`);
  }
  assert.ok(pageEntryName(DAY, "https://www.example.com/").startsWith(`pages/www.example.com/${DAY}/`));
});

// ── 3. The two files at the root ─────────────────────────────────────────────

test("every bundle has an index.html and a README.txt, and the README says what is missing", async () => {
  const indexPages = [
    { day: DAY, url: HOME_URL, entry: HOME_ENTRY, title: "Example Domain" },
    { day: DAY, url: ABOUT_URL, entry: ABOUT_ENTRY },
  ];
  const indexHtml = buildIndexHtml({ domain: DOMAIN, month: "2024-03", pages: indexPages, assetCount: 1, missing: 2 });
  const readme = buildReadme({
    domain: DOMAIN,
    month: "2024-03",
    days: [DAY],
    pages: indexPages.length,
    assets: 1,
    missing: 2,
    firstTs: TS,
    lastTs: "20240315235959",
  });

  const parsed = await readZip(
    await buildZip([
      { name: INDEX_ENTRY, bytes: utf8(indexHtml) },
      { name: README_ENTRY, bytes: utf8(readme) },
      ...indexPages.map((page) => ({ name: page.entry, bytes: utf8("<html></html>") })),
    ]),
  );
  const names = parsed.map((entry) => entry.name);
  assert.ok(names.includes(INDEX_ENTRY), "the zip root has no index.html");
  assert.ok(names.includes(README_ENTRY), "the zip root has no README.txt");

  // The listing: dependency-free, and every link resolves to a bundled page.
  assert.ok(/^<!DOCTYPE html>/i.test(indexHtml));
  assert.equal(/<script/i.test(indexHtml), false, "the landing page must not need a script engine");
  assert.equal(/https?:\/\//i.test(indexHtml.replace(/<a href="[^"]*">/g, "")), false, "no CDN, no webfont, no framework");
  for (const page of indexPages) {
    assert.ok(
      indexHtml.includes(`href="${relativeHref(INDEX_ENTRY, page.entry)}"`),
      `the index does not link ${page.entry}`,
    );
    assert.ok(names.includes(page.entry));
  }
  assert.ok(indexHtml.includes(`${DAY}</h2>`) || indexHtml.includes(`>${DAY}<`), "the index lists the capture days");
  assert.ok(indexHtml.includes("2 page(s) captured in this month are not in this bundle"), "the index admits the gap");

  // The README: what it is, where it came from, what it holds, what is missing, and
  // the attribution plan.md §12 rule 7 asks for.
  for (const expected of [
    DOMAIN,
    "2024-03",
    DAY,
    "2024-03-15 12:00:00 UTC",
    "2024-03-15 23:59:59 UTC",
    "Pages in this bundle:       2",
    "Assets in this bundle:      1",
    "Pages missing (purged):     2",
    "INCOMPLETE — 2 page(s) missing",
    "Internet Archive Wayback Machine",
    "https://web.archive.org/web/*/example.com",
    "research and reference copy",
  ]) {
    assert.ok(readme.includes(expected), `the README does not mention ${JSON.stringify(expected)}`);
  }

  // A complete export says nothing about missing pages.
  const complete = buildReadme({ domain: DOMAIN, month: "2024-03", days: [DAY], pages: 2, assets: 1, missing: 0 });
  assert.equal(complete.includes("INCOMPLETE"), false);
  assert.ok(complete.includes("Capture timestamps:         not recorded"));

  // The capture's own title, for the listing, when the crawl recorded one.
  assert.equal(extractPageTitle("<html><head><title> A &amp; B </title></head></html>"), "A & B");
  assert.equal(extractPageTitle("<html><head></head></html>"), undefined);
});

// ── 4. Missing snapshots ─────────────────────────────────────────────────────

test("purged snapshots are excluded from the bundle and counted, not silently dropped", async () => {
  // The ledger tells two different stories, and the difference is the deliverable:
  // three URLs were captured, two still have bytes.
  const missing = countMissing({ total: 3, stored: 2 });
  assert.equal(missing, 1);
  assert.equal(countMissing({ total: 2, stored: 2 }), 0, "a complete month reports zero missing");
  assert.equal(countMissing({ total: 0, stored: 0 }), 0);
  // A stored count above the total is impossible, but must not produce a negative
  // "missing" that a caller then prints.
  assert.equal(countMissing({ total: 2, stored: 3 }), 0);

  // The route builds entries only from rows with `r2_key IS NOT NULL`, so the
  // purged URL never reaches the archive — while its count still reaches the
  // README and the landing page, which is where a reader notices its absence.
  const parsed = await readZip(
    await buildZip([
      {
        name: INDEX_ENTRY,
        bytes: utf8(
          buildIndexHtml({
            domain: DOMAIN,
            month: "2024-03",
            pages: [
              { day: DAY, url: HOME_URL, entry: HOME_ENTRY },
              { day: DAY, url: ABOUT_URL, entry: ABOUT_ENTRY },
            ],
            assetCount: 0,
            missing,
          }),
        ),
      },
      { name: README_ENTRY, bytes: utf8(buildReadme({ domain: DOMAIN, month: "2024-03", days: [DAY], pages: 2, assets: 0, missing })) },
      { name: HOME_ENTRY, bytes: utf8("<html>home</html>") },
      { name: ABOUT_ENTRY, bytes: utf8("<html>about</html>") },
    ]),
  );
  const names = parsed.map((entry) => entry.name);

  assert.deepEqual(
    names.filter((name) => name.startsWith("pages/")).sort(),
    [ABOUT_ENTRY, HOME_ENTRY],
    "a page whose blob was purged must not appear in the bundle",
  );
  assert.equal(names.includes(pageEntryName(DAY, GONE_URL)), false, "no entry may be fabricated for a purged page");

  const index = new TextDecoder().decode((parsed.find((entry) => entry.name === INDEX_ENTRY) as ParsedEntry).data);
  const readme = new TextDecoder().decode((parsed.find((entry) => entry.name === README_ENTRY) as ParsedEntry).data);
  assert.ok(index.includes("1 page(s) captured in this month are not in this bundle"));
  assert.ok(readme.includes("Pages missing (purged):     1"));
});

// ── 5. Determinism ───────────────────────────────────────────────────────────

test("the same input produces byte-identical bundles, so an export is reproducible", async () => {
  const plan = pageRewrites(DOMAIN, { url: HOME_URL, entry: HOME_ENTRY }, locations(), [LOGO_HASH]);
  const rewritten = applyPlan(storedPage(), plan);

  const entries: ZipEntry[] = [
    {
      name: INDEX_ENTRY,
      bytes: utf8(
        buildIndexHtml({
          domain: DOMAIN,
          month: "2024-03",
          pages: [
            { day: DAY, url: HOME_URL, entry: HOME_ENTRY },
            { day: DAY, url: ABOUT_URL, entry: ABOUT_ENTRY },
          ],
          assetCount: 1,
          missing: 0,
        }),
      ),
    },
    {
      name: README_ENTRY,
      bytes: utf8(buildReadme({ domain: DOMAIN, month: "2024-03", days: [DAY], pages: 2, assets: 1, missing: 0, firstTs: TS, lastTs: TS })),
    },
    { name: HOME_ENTRY, bytes: utf8(rewritten), dosTime: dosTimestamp(TS).time, dosDate: dosTimestamp(TS).date },
    {
      name: ABOUT_ENTRY,
      bytes: utf8(bigPage("deterministic")),
      dosTime: dosTimestamp("20240315093000").time,
      dosDate: dosTimestamp("20240315093000").date,
    },
    { name: assetEntryName(LOGO_HASH), bytes: new Uint8Array([1, 2, 3, 4, 5]) },
  ];

  const first = await buildZip(entries, { deflate: deflateRaw });
  const second = await buildZip(entries, { deflate: deflateRaw });
  assert.deepEqual([...first], [...second], "two builds of the same input differ");
  assert.ok(first.length > 0);

  // Nothing in the archive may record when it was built: a `Date.now()` mtime
  // would fail this assertion on the next run, which is exactly why the capture
  // timestamp is used instead — and why the empty case is a constant.
  assert.deepEqual(dosTimestamp(), { time: 0, date: (1 << 5) | 1 }, "the default timestamp is fixed, not 'now'");
  assert.deepEqual(dosTimestamp("not-a-timestamp"), dosTimestamp());

  const parsed = await readZip(first);
  const home = parsed.find((entry) => entry.name === HOME_ENTRY) as ParsedEntry;
  assert.deepEqual({ time: home.dosTime, date: home.dosDate }, dosTimestamp(TS), "a page's zip mtime is its capture time");
  assert.equal(dosTimestamp(TS).date, ((2024 - 1980) << 9) | (3 << 5) | 15, "2024-03-15 encodes correctly");
  assert.equal(dosTimestamp("19700101000000").date, dosTimestamp().date, "pre-1980 clamps to the DOS epoch");
  assert.equal(dosTimestamp("29991231235959").date, ((2107 - 1980) << 9) | (12 << 5) | 31, "post-2107 clamps too");
});

// ── 6. The collector that decides what the bundle contains ───────────────────

test("asset collection finds every reference an ingested page can carry, and dedupes it", () => {
  const other = hex64("cd", "beef");
  const html = `<link href="${LOGO_TOKEN}">
<img src="${LOGO_TOKEN}" srcset="/assets/${other.slice(0, 2)}/${other} 2x">
<style>.a{background:url(/assets/${other.slice(0, 2)}/${other})}</style>
<p>Text mentioning /assets/zz/not-a-hash and /assets/ab/short and nothing else.</p>`;

  const found = collectAssetHashes(html);
  assert.deepEqual([...found].sort(), [LOGO_HASH, other].sort(), "both real references, each once");
  assert.equal(found.size, 2, "a repeated reference is one entry");

  // The token shape is what makes a text scan safe: a near miss is not an asset,
  // and a page that mentions one in prose must not pull a file into the bundle.
  assert.equal(collectAssetHashes('<a href="/assets/ab/nothex">x</a>').size, 0);
  assert.equal(collectAssetHashes(`<p>assets/ab/${"a".repeat(64)}</p>`).size, 0, "no leading slash, no asset");
});
