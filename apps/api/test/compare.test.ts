/**
 * Tests for month-to-month comparison (plan.md §15, "Diff two months").
 *
 * ## What is tested here
 *
 * The comparison feature splits into a cheap question ("which pages changed?") and
 * an expensive one ("how did this page change?"). The cheap one is digest
 * equality — one line, and wrong only if the digest is taken of the wrong thing.
 * The expensive one is a diff, and a diff is where the subtle bugs live:
 *
 *  - The two-level structure (sentences, then words inside changed sentences) is
 *    what keeps this affordable in a Worker. If it silently degrades to a whole-
 *    page word diff, a large page becomes O(n·m) and the request dies.
 *  - The size guards are the difference between "a bounded, honest summary" and a
 *    killed isolate. They must actually fire.
 *  - `classifyChange` must never report `unchanged` when it simply does not know.
 *    A confident "nothing changed" that is really "I did not look" is worse than
 *    no answer, because someone will act on it.
 *
 * All pure, so all of it is asserted offline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChange,
  diffPageText,
  diffWords,
  lcsAlign,
  splitSentences,
  splitWords,
  summariseDiff,
} from "../src/lib/compare.ts";

// ── Splitting ────────────────────────────────────────────────────────────────

test("splitSentences keeps terminating punctuation and drops empty fragments", () => {
  assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  assert.deepEqual(splitSentences("  spaced   out  "), ["spaced out"]);
  assert.deepEqual(splitSentences(""), []);
  // A trailing fragment with no terminator is still a sentence.
  assert.deepEqual(splitSentences("Complete. Incomplete"), ["Complete.", "Incomplete"]);
  // A closing quote after the terminator belongs to the sentence, not the next one.
  assert.deepEqual(splitSentences('He said "stop." Then left.'), ['He said "stop."', "Then left."]);
});

test("splitWords drops whitespace-only tokens", () => {
  assert.deepEqual(splitWords("  a   b\tc\n"), ["a", "b", "c"]);
  assert.deepEqual(splitWords("   "), []);
});

// ── LCS alignment ────────────────────────────────────────────────────────────

test("lcsAlign finds the longest common subsequence as index pairs", () => {
  assert.deepEqual(lcsAlign(["a", "b", "c"], ["a", "b", "c"]), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(lcsAlign(["a", "b", "c"], ["a", "c"]), [[0, 0], [2, 1]]);
  assert.deepEqual(lcsAlign(["x"], ["y"]), []);
  assert.deepEqual(lcsAlign([], ["y"]), []);
  assert.deepEqual(lcsAlign(["y"], []), []);
});

test("lcsAlign handles a realistic insertion without misaligning the tail", () => {
  const before = ["The", "price", "is", "ninety", "nine", "pounds"];
  const after = ["The", "price", "is", "now", "ninety", "nine", "pounds"];
  const pairs = lcsAlign(before, after);
  assert.deepEqual(pairs, [[0, 0], [1, 1], [2, 2], [3, 4], [4, 5], [5, 6]]);
});

test("lcsAlign survives inputs large enough to matter, without exploding memory", () => {
  // 600×600 is well past the point where a naive nested-array implementation
  // becomes a memory problem in a Worker; the flat Int32Array is why this passes.
  const a = Array.from({ length: 600 }, (_, i) => `w${i % 50}`);
  const b = Array.from({ length: 600 }, (_, i) => `w${(i + 7) % 50}`);
  const pairs = lcsAlign(a, b);
  assert.ok(pairs.length > 0, "a large alignment should still find common ground");
  for (let i = 1; i < pairs.length; i++) {
    assert.ok(pairs[i]![0] > pairs[i - 1]![0] && pairs[i]![1] > pairs[i - 1]![1], "pairs must increase in both axes");
  }
});

// ── Word diff ────────────────────────────────────────────────────────────────

test("diffWords marks replaced words as removed then added, keeping the rest as same", () => {
  const { segments } = diffWords("the price is 99 pounds", "the price is 89 pounds");
  assert.deepEqual(segments, [
    { kind: "same", text: "the price is" },
    { kind: "removed", text: "99" },
    { kind: "added", text: "89" },
    { kind: "same", text: "pounds" },
  ]);
});

test("diffWords handles pure insertion and pure removal", () => {
  const inserted = diffWords("one two", "one brand new two");
  assert.deepEqual(inserted.segments, [
    { kind: "same", text: "one" },
    { kind: "added", text: "brand new" },
    { kind: "same", text: "two" },
  ]);

  const removed = diffWords("one brand new two", "one two");
  assert.deepEqual(removed.segments, [
    { kind: "same", text: "one" },
    { kind: "removed", text: "brand new" },
    { kind: "same", text: "two" },
  ]);
});

test("diffWords on identical text produces a single same segment", () => {
  assert.deepEqual(diffWords("nothing changed here", "nothing changed here").segments, [
    { kind: "same", text: "nothing changed here" },
  ]);
});

test("diffWords handles empty sides rather than producing a confusing empty diff", () => {
  assert.deepEqual(diffWords("", "brand new content").segments, [{ kind: "added", text: "brand new content" }]);
  assert.deepEqual(diffWords("old content", "").segments, [{ kind: "removed", text: "old content" }]);
  assert.deepEqual(diffWords("", "").segments, []);
});

test("diffWords refuses to explode on enormous inputs and says it gave up", () => {
  const huge = Array.from({ length: 5_000 }, (_, i) => `w${i}`).join(" ");
  const other = Array.from({ length: 5_000 }, (_, i) => `x${i}`).join(" ");
  const result = diffWords(huge, other);
  assert.equal(result.truncated, true, "a 5000-word diff must be abandoned, not attempted");
  assert.equal(result.segments.length, 2, "and reported as a wholesale replacement");
});

// ── Page-level diff ──────────────────────────────────────────────────────────

test("diffPageText isolates a one-word change inside one sentence", () => {
  const before = "Welcome to our shop. The Widget Pro costs 99 pounds today. Shipping is free.";
  const after = "Welcome to our shop. The Widget Pro costs 89 pounds today. Shipping is free.";
  const diff = diffPageText(before, after);

  assert.equal(diff.truncated, false);
  assert.equal(diff.addedWords, 1);
  assert.equal(diff.removedWords, 1);

  // The unchanged sentences must be reported as unchanged, not re-emitted as a
  // wall of text — that is the whole benefit of aligning sentences first.
  const same = diff.segments.filter((s) => s.kind === "same").map((s) => s.text).join(" ");
  assert.ok(same.includes("Welcome to our shop."), `expected the opener to be unchanged: ${same}`);
  assert.ok(same.includes("Shipping is free."), `expected the closer to be unchanged: ${same}`);

  const added = diff.segments.filter((s) => s.kind === "added").map((s) => s.text).join(" ");
  assert.equal(added, "89", "only the price should be reported as added");
});

test("diffPageText reports an added paragraph as added, not as a rewrite", () => {
  const before = "First paragraph.";
  const after = "First paragraph. A newly added second paragraph.";
  const diff = diffPageText(before, after);
  assert.equal(diff.removedWords, 0);
  assert.ok(diff.addedWords >= 5, `expected the new paragraph to count as added: ${diff.addedWords}`);
});

test("diffPageText reports a restructure as whole sentences rather than inventing a mapping", () => {
  // Two sentences become one different sentence. There is no word correspondence
  // worth claiming, so both sides are reported wholesale.
  const before = "Alpha beta. Gamma delta.";
  const after = "Something entirely else.";
  const diff = diffPageText(before, after);
  assert.ok(diff.removedWords > 0 && diff.addedWords > 0);
  assert.ok(
    diff.segments.some((s) => s.kind === "removed") && diff.segments.some((s) => s.kind === "added"),
    "a restructure must show both sides",
  );
});

test("diffPageText bounds a page too large for an exact diff", () => {
  const sentence = "This is a sentence with a reasonable number of words in it. ";
  const before = sentence.repeat(900);
  const after = `${sentence.repeat(899)}A different closing sentence appears here.`;
  const diff = diffPageText(before, after);
  assert.equal(diff.truncated, true, "900 sentences exceeds the sentence budget, so the diff must degrade");
  assert.ok(diff.segments.length > 0, "a degraded diff must still say something");
});

test("diffPageText marks truncated input when a page exceeds the character cap", () => {
  const before = "word ".repeat(20_000);
  const after = "word ".repeat(19_999);
  const diff = diffPageText(before, after);
  assert.equal(diff.truncated, true);
});

// ── Summaries ────────────────────────────────────────────────────────────────

test("summariseDiff distinguishes replacement, addition, removal and no-op", () => {
  assert.equal(summariseDiff(diffPageText("a b c", "a b c")), "no textual change");
  assert.match(summariseDiff(diffPageText("the price is 99", "the price is 89")), /1 word replaced by 1/);
  assert.match(summariseDiff(diffPageText("one", "one two")), /1 word added/);
  assert.match(summariseDiff(diffPageText("one two", "one")), /1 word removed/);
});

test("summariseDiff says so when the diff was abandoned", () => {
  const huge = Array.from({ length: 5_000 }, (_, i) => `w${i}`).join(" ");
  const summary = summariseDiff(diffPageText(huge, "short"));
  assert.match(summary, /too large for an exact diff/);
});

// ── Classification: the honesty-critical part ────────────────────────────────

test("classifyChange reports added, removed and changed from digests", () => {
  const digestA = { content_digest: "aaa", title: "A", bytes: 10 };
  const digestB = { content_digest: "bbb", title: "B", bytes: 20 };

  assert.equal(classifyChange(digestA, digestB), "changed");
  assert.equal(classifyChange(digestA, { ...digestA, day: "2024-03-01" }), "unchanged");
  assert.equal(classifyChange(null, { ...digestA, day: "2024-03-01" }), "added");
  assert.equal(classifyChange(digestA, null), "removed");
});

test("classifyChange never claims a difference it cannot evidence", () => {
  // Identical size and title, but no digests: the honest answer is 'unknown'.
  const noDigest = { content_digest: null, title: "Same", bytes: 100 };
  assert.equal(
    classifyChange(noDigest, { ...noDigest, day: "2024-03-01" }),
    "unknown",
    "absent evidence must not be reported as 'nothing changed'",
  );

  // A digest on only one side proves nothing about the other, and size and title
  // agree — so this is still 'unknown'. Reporting it as 'changed' would flood the
  // list with every page crawled before digests existed.
  assert.equal(
    classifyChange(noDigest, { content_digest: "bbb", title: "Same", bytes: 100, day: "2024-03-01" }),
    "unknown",
    "one digest is not evidence of a change",
  );

  // But a different size or title IS positive evidence, digests or not.
  assert.equal(
    classifyChange(noDigest, { content_digest: null, title: "Same", bytes: 999, day: "2024-03-01" }),
    "changed",
    "a size difference is evidence even without digests",
  );
  assert.equal(
    classifyChange(noDigest, { content_digest: null, title: "Different", bytes: 100, day: "2024-03-01" }),
    "changed",
    "a title difference is evidence even without digests",
  );
});

test("classifyChange with one digest present falls back rather than trusting it", () => {
  // One side has a digest, the other does not. Digest equality is unknowable, so
  // size+title decide, and equal-size/equal-title means 'unknown'.
  const withDigest = { content_digest: "aaa", title: "T", bytes: 50 };
  const without = { content_digest: null, title: "T", bytes: 50 };
  assert.equal(classifyChange(withDigest, { ...without, day: "2024-03-01" }), "unknown");
  assert.equal(
    classifyChange(withDigest, { content_digest: null, title: "T2", bytes: 50, day: "2024-03-01" }),
    "changed",
  );
});
