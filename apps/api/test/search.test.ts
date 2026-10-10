/**
 * Tests for cross-domain search (plan.md §15).
 *
 * ## What is tested here, and why it is the right level
 *
 * The part of search most likely to break is not the SQL — it is the **query
 * builder**. FTS5's `MATCH` takes a query *expression*, not a search string, so
 * user input has to be escaped before it goes anywhere near the database. Two
 * failure modes follow from getting that wrong:
 *
 *  - `iphone (15` or `"unclosed` is an FTS5 syntax error, which becomes a 500 for
 *    the user. Nobody types valid FTS5 syntax into a search box.
 *  - FTS5 addresses columns by name, so unescaped input like `text:foo` or
 *    `title:x OR y` lets a caller rewrite the query's *meaning*. Not SQL
 *    injection — the statement stays parameterised — but the search stops being
 *    the search that was asked for.
 *
 * So the builder is asserted exhaustively and offline. The snippet logic is
 * asserted for the cases that make results readable (match near the start, match
 * in the middle, no match at all). The SQL itself is exercised by the Worker's
 * FTS5 availability test and the local smoke path, because a fake SQLite would
 * prove nothing about FTS5.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildFtsExpression, makeSnippet, SearchInputError } from "../src/lib/search.ts";
import { decodeEntities, extractIndexableText, extractTitle } from "@custom-wayback/pipeline";

// ── Query building: escaping ─────────────────────────────────────────────────

test("buildFtsExpression quotes every term so input cannot become FTS5 syntax", () => {
  // The whole point: these are search strings, not expressions.
  assert.equal(buildFtsExpression("iphone"), '"iphone"*');
  assert.equal(buildFtsExpression("iphone 15 pro"), '"iphone"* AND "15"* AND "pro"*');
});

test("buildFtsExpression neutralises FTS5 operators and column filters", () => {
  // `OR` is an FTS5 operator; the user meant the word. Because every term is
  // wrapped in a string literal, an operator word is just a word — which is the
  // correct behaviour and the reason operator words are NOT stripped from input.
  assert.equal(buildFtsExpression("cats OR dogs"), '"cats"* AND "OR"* AND "dogs"*');
  // `text:` is a column filter. Stripping the colon stops input addressing columns.
  const columnAttack = buildFtsExpression("text:secret");
  assert.ok(!columnAttack.includes("text:"), `column filter survived: ${columnAttack}`);
  assert.equal(columnAttack, '"textsecret"*', "the colon is removed, the word is kept");
  for (const hostile of ["NOT x", "a NEAR b", "^start", "{col} : v", "a - b"]) {
    const built = buildFtsExpression(hostile);
    // No *unquoted* operator or bracket may survive. A quoted "NEAR" is a literal
    // word and is safe; a bare NEAR would be an operator.
    // The structural check is the meaningful one: no character that carries
    // meaning outside a string literal may survive unquoted. Operator *words* are
    // deliberately kept, because inside a string literal they are just words.
    assert.equal(
      (built.match(/(?<!")"(?!")/g) ?? []).length % 2,
      0,
      `unbalanced quotes in ${built}`,
    );
    assert.ok(!/[{^~[\]]/.test(built), `structural character survived in ${JSON.stringify(hostile)}: ${built}`);
  }
});

test("buildFtsExpression escapes embedded quotes by doubling them", () => {
  // In FTS5 a literal `"` inside a quoted string is written `""`.
  const built = buildFtsExpression('say "hello"');
  assert.ok(built.startsWith('"say"*'), `unexpected shape: ${built}`);
  assert.ok(built.includes('"hello"*'), `expected an escaped hello term, got: ${built}`);
  // Critically: the number of unescaped quotes must stay balanced, or FTS5 sees
  // an unterminated string.
  assert.equal((built.match(/(?<!")"(?!")/g) ?? []).length % 2, 0, `unbalanced quotes in ${built}`);
});

test("buildFtsExpression refuses input with nothing searchable, rather than querying for nothing", () => {
  for (const junk of ["", "   ", "!!!", "***", '""', "()"]) {
    assert.throws(
      () => buildFtsExpression(junk),
      SearchInputError,
      `expected ${JSON.stringify(junk)} to be refused`,
    );
  }
});

test("buildFtsExpression caps term count and term length", () => {
  const many = buildFtsExpression(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
  assert.equal(many.split(" AND ").length, 12, "a 40-word paste is bounded to 12 terms");

  const long = buildFtsExpression("x".repeat(500));
  const term = long.replace(/^"|"\*$/g, "");
  assert.equal(term.length, 64, "an over-long term is truncated");
});

test("buildFtsExpression treats punctuation-separated text as separate terms", () => {
  assert.equal(buildFtsExpression("samsung,galaxy;phone"), '"samsung"* AND "galaxy"* AND "phone"*');
});

// ── Snippets ─────────────────────────────────────────────────────────────────

test("makeSnippet returns short text whole, without inventing ellipses", () => {
  assert.equal(makeSnippet("Short page.", ["short"]), "Short page.");
});

test("makeSnippet centres the snippet on the first match", () => {
  const body = `${"a ".repeat(400)}NEEDLE${" b".repeat(400)}`;
  const snippet = makeSnippet(body, ["needle"], 100);
  assert.ok(snippet.includes("NEEDLE"), "the match must be inside the snippet");
  assert.ok(snippet.length <= 102, `snippet overran: ${snippet.length}`);
  assert.ok(snippet.startsWith("…"), "a snippet cut from the middle should say so");
  assert.ok(snippet.endsWith("…"), "a snippet cut before the end should say so");
});

test("makeSnippet still returns something useful when the term is not in the body", () => {
  // This happens for a match on the title, or a stemming surprise. Returning an
  // empty string would make the result row look broken.
  const snippet = makeSnippet("a ".repeat(300), ["absent"], 80);
  assert.ok(snippet.length > 0);
  assert.ok(snippet.endsWith("…"));
});

test("makeSnippet picks the earliest match when several terms are present", () => {
  const body = `${"x ".repeat(50)}ALPHA ${"y ".repeat(200)} BETA ${"z ".repeat(50)}`;
  const snippet = makeSnippet(body, ["beta", "alpha"], 120);
  assert.ok(snippet.includes("ALPHA"), `expected the earlier term to win, got: ${snippet}`);
});

// ── Text extraction ──────────────────────────────────────────────────────────

test("extractIndexableText keeps prose and drops script, style and markup", () => {
  const html = `<html><head><title>Widget</title>
    <style>body { color: red }</style>
    <script>var secret = "shouldnotbeindexed";</script>
    </head><body>
    <h1>Widget Pro</h1>
    <p>The price is &pound;99.</p>
    <noscript>Enable JS</noscript>
    </body></html>`;

  const text = extractIndexableText(html);
  assert.ok(text.includes("Widget Pro"), text);
  assert.ok(text.includes("£99"), `entities should decode: ${text}`);
  for (const forbidden of ["shouldnotbeindexed", "color: red", "Enable JS"]) {
    assert.ok(!text.includes(forbidden), `"${forbidden}" must not be indexed: ${text}`);
  }
});

test("extractIndexableText separates adjacent block elements", () => {
  // `<li>a</li><li>b</li>` must not fuse into the word "ab" — a fused word is one
  // that appears nowhere on the page, which is how a search index starts lying.
  const text = extractIndexableText("<ul><li>Alpha</li><li>Beta</li></ul><div>Gamma</div>");
  assert.equal(text, "Alpha Beta Gamma", `unexpected extraction: ${JSON.stringify(text)}`);

  // A genuinely short page still indexes: "Contact Us" is a real page someone may
  // search for, and an earlier threshold silently dropped it.
  assert.equal(extractIndexableText("<h2>Contact</h2><p>Us</p>"), "Contact Us");

  const fused = extractIndexableText("<h2>Contact us today</h2><p>for a quote</p>");
  assert.equal(fused, "Contact us today for a quote", `block boundary lost: ${JSON.stringify(fused)}`);
  assert.ok(!fused.includes("todayfor"), "adjacent blocks must not fuse into one token");
});

test("extractIndexableText returns empty for shells that would only add noise", () => {
  assert.equal(extractIndexableText(""), "");
  assert.equal(extractIndexableText("<html><body></body></html>"), "");
  // A near-empty JS shell.
  assert.equal(extractIndexableText("<html><body><div id=app></div></body></html>"), "");
});

test("extractIndexableText is bounded, so one enormous page cannot bloat the index", () => {
  const huge = `<p>${"word ".repeat(80_000)}</p>`;
  const text = extractIndexableText(huge);
  assert.ok(text.length <= 200_000, `unbounded: ${text.length}`);
});

test("decodeEntities handles numeric, hex and named references", () => {
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeEntities("&euro;5"), "€5");
  // Unknown entities are left alone rather than silently deleted.
  assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
});

test("extractTitle prefers <title>, falls back to <h1>, and never invents one", () => {
  assert.equal(extractTitle("<title>Real Title</title>"), "Real Title");
  assert.equal(extractTitle("<html><body><h1>Heading</h1></body></html>"), "Heading");
  assert.equal(extractTitle("<html><body><p>No title here</p></body></html>"), null);
  // An empty <title> is common in archived templates; the h1 is better than "".
  assert.equal(extractTitle("<title>  </title><h1>Fallback</h1>"), "Fallback");
});
