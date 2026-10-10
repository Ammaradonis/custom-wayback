/**
 * Page text extraction for full-text search (plan.md §15).
 *
 * ## What this is for
 *
 * "When did they change the price page?" — the marketing-research question the
 * whole tool exists to answer. Search has to index every snapshot ever crawled,
 * across domains and months, so the text is extracted **once, at ingest**, while
 * the bytes are in hand, and stored permanently.
 *
 * ## Why it must not read from R2 later
 *
 * The post-serve purge job deletes page blobs by design. A search that read
 * bodies out of R2 would silently lose results for every page already visited —
 * the archive would appear to shrink as you used it. So this runs at ingest and
 * the result is kept.
 *
 * ## Why it is pure
 *
 * This module takes the *serialised* HTML and returns text. It has no DOM, no
 * Node builtins, no `HTMLRewriter` — so it is testable directly in Node and usable
 * from both runtimes. The DOM-aware callers pass it `document.toString()`.
 *
 * The extractor is deliberately conservative: it prefers returning too little
 * over indexing markup or script bodies, because a search index full of
 * `function(e,t){...}` noise is worse than one that misses an obscure string.
 */

/** Elements whose contents are not prose and must never reach the index. */
const NON_CONTENT_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "head",
  "nav",
  "footer",
] as const;

/**
 * Tags after which a space is required, so `<li>a</li><li>b</li>` indexes as
 * "a b" and not "ab". Getting this wrong is how a search index develops words
 * that appear nowhere on the page.
 */
const BLOCK_TAGS = [
  "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section",
  "article", "header", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
  "figure", "figcaption", "form", "label", "option", "dt", "dd", "dl", "hr",
] as const;

const MAX_TEXT_CHARS = 200_000;

/** Strip every element (and its contents) whose text is not prose. */
export function stripNonContent(html: string): string {
  let out = html;
  for (const tag of NON_CONTENT_TAGS) {
    // Non-greedy, case-insensitive, and tolerant of attributes on the open tag.
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    out = out.replace(paired, " ");
    // Self-closing / void forms.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  // HTML comments can hold large commented-out markup blocks.
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  pound: "£",
  euro: "€",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
};

/**
 * Decode the entities that actually appear in archived marketing pages.
 *
 * Not a full HTML5 entity table on purpose: a complete implementation is several
 * thousand entries, and every one of them would ship to the Worker for a benefit
 * nobody can observe in search results. Numeric references *are* handled fully,
 * because they are common in template-generated markup and are cheap.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // Surrogate halves and control characters are not valid standalone text.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Collapse all whitespace runs to single spaces and trim. */
export function squeezeWhitespace(text: string): string {
  return text.replace(/[\s\u00a0\u200b]+/g, " ").trim();
}

/**
 * Visible text of an HTML document, ready to index.
 *
 * Returns "" for anything that is not plausibly HTML, so a caller can index
 * unconditionally without special-casing PDFs and images.
 */
export function extractIndexableText(html: string, maxChars = MAX_TEXT_CHARS): string {
  if (!html || html.length < 8) return "";

  let body = stripNonContent(html);

  // Separate block-level boundaries so adjacent block text does not fuse.
  for (const tag of BLOCK_TAGS) {
    body = body.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), " ");
  }

  // Drop every remaining tag. Anything left is text.
  body = body.replace(/<[^>]*>/g, " ");

  body = squeezeWhitespace(decodeEntities(body));

  // A page that yielded nothing is a redirect stub, an image-only page, or a
  // JS-only shell whose text never existed in the HTML. Indexing "" is pointless;
  // indexing a couple of words is not.
  //
  // The threshold is deliberately low. An earlier version used 24 characters,
  // which silently discarded genuinely short pages — a two-word "Contact Us" page
  // is a real page someone may search for. This only filters what has no content
  // at all.
  if (body.length === 0) return "";

  return body.length > maxChars ? body.slice(0, maxChars) : body;
}

/**
 * Best-effort page title from the serialised HTML.
 *
 * Falls back to the first `<h1>` because archived pages frequently have an empty
 * or template-placeholder `<title>`, and a search result with no title is
 * useless. Returns null when neither exists, rather than inventing one from the
 * URL — the UI can show the URL, and a fabricated title would be a lie.
 */
export function extractTitle(html: string): string | null {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (title?.[1]) {
    const cleaned = squeezeWhitespace(decodeEntities(title[1]));
    if (cleaned.length > 0) return cleaned.slice(0, 300);
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  if (h1?.[1]) {
    const cleaned = squeezeWhitespace(decodeEntities(h1[1].replace(/<[^>]*>/g, " ")));
    if (cleaned.length > 0) return cleaned.slice(0, 300);
  }
  return null;
}
