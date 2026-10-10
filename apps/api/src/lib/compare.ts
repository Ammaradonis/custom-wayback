/**
 * Month-to-month comparison (plan.md §15, "Diff two months").
 *
 * ## The shape of the problem
 *
 * "Compare two months" is really two questions, and they have very different
 * costs:
 *
 *  1. **Which pages changed?** Answering this by reading every page from R2 for
 *     both months costs one Class B read per page per month, and fails outright
 *     for any page the post-serve purge has deleted. Instead each crawl records a
 *     `content_digest` of the bytes it stored, so this question is two indexed
 *     reads and **no R2 traffic**.
 *  2. **How did this page change?** That needs the actual text, so it is answered
 *     on demand, one page at a time, only for pages already known to differ.
 *
 * ## Why the diff is word-level and not character-level
 *
 * Character diffs of HTML-derived prose are unreadable: one changed word marks up
 * half a sentence. Word diffs track the unit a person reads. But a naive
 * word-level LCS is O(n·m) in time and memory — two 50k-word pages would need
 * 2.5 billion cells and would kill a Worker.
 *
 * So the diff is **two-level**: sentences are diffed first (cheap, because there
 * are far fewer of them, and it also gives a genuinely useful reading order),
 * then only the sentence pairs that actually differ are word-diffed. Each word
 * diff is bounded, so a pathological page degrades to "this paragraph changed"
 * rather than to an OOM.
 */

/** One contiguous run of words that is the same in both versions. */
export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

export interface TextDiff {
  segments: DiffSegment[];
  /** Words added / removed, for the summary line. */
  addedWords: number;
  removedWords: number;
  /** True when the inputs were too large to diff exactly and were truncated. */
  truncated: boolean;
}

/** Above this many words per side, a word diff is abandoned for a summary. */
const MAX_DIFF_WORDS = 4_000;
/** Above this many sentences, sentence alignment is abandoned. */
const MAX_SENTENCES = 800;
/** How much of a page's text is compared at all. */
const MAX_TEXT_CHARS = 60_000;

/**
 * Split prose into sentences, keeping the terminating punctuation.
 *
 * Deliberately crude: abbreviations and decimals will occasionally split a
 * sentence that a human would not. That costs nothing here — a mis-split sentence
 * simply gets word-diffed, which produces the same visible result.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];
  const parts = normalized.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
  return (parts ?? [normalized]).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split into comparable word tokens, discarding punctuation-only noise. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 0);
}

/**
 * Longest-common-subsequence alignment of two string arrays.
 *
 * Returns index pairs `[i, j]` of matching elements, in order. Runs on sentences
 * or on words; the caller decides which, and the size guards are the caller's
 * responsibility because only it knows how large the input can get.
 *
 * Uses an `Int32Array` flat table rather than a nested array: at 800×800 that is
 * 2.5 MB instead of ~800 array objects, which is the difference between a Worker
 * that finishes and one that hits the memory limit.
 */
export function lcsAlign(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const width = m + 1;
  const table = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * width;
    const nextBase = (i + 1) * width;
    for (let j = m - 1; j >= 0; j--) {
      table[rowBase + j] =
        a[i] === b[j]
          ? (table[nextBase + j + 1] ?? 0) + 1
          : Math.max(table[nextBase + j] ?? 0, table[rowBase + j + 1] ?? 0);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Word-level diff of two runs of text, as ordered segments tagged same/added/removed.
 *
 * The output is ordered so a renderer can walk it once: unchanged runs interleave
 * with removals and additions.
 */
export function diffWords(before: string, after: string): { segments: DiffSegment[]; truncated: boolean } {
  const a = splitWords(before);
  const b = splitWords(after);

  if (a.length === 0 && b.length === 0) return { segments: [], truncated: false };
  if (a.length === 0) return { segments: [{ kind: "added", text: b.join(" ") }], truncated: false };
  if (b.length === 0) return { segments: [{ kind: "removed", text: a.join(" ") }], truncated: false };

  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return {
      segments: [
        { kind: "removed", text: a.join(" ") },
        { kind: "added", text: b.join(" ") },
      ],
      truncated: true,
    };
  }

  const pairs = lcsAlign(a, b);
  const segments: DiffSegment[] = [];

  const push = (kind: DiffSegment["kind"], words: string[]): void => {
    if (words.length === 0) return;
    const text = words.join(" ");
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text = `${last.text} ${text}`;
    else segments.push({ kind, text });
  };

  let ai = 0;
  let bi = 0;
  for (const [mi, mj] of pairs) {
    push("removed", a.slice(ai, mi));
    push("added", b.slice(bi, mj));
    push("same", [a[mi] as string]);
    ai = mi + 1;
    bi = mj + 1;
  }
  push("removed", a.slice(ai));
  push("added", b.slice(bi));

  return { segments, truncated: false };
}

/**
 * Diff two page texts, aligning at sentence level first.
 *
 * The two-level structure is what keeps this affordable: sentence alignment
 * identifies the paragraphs that changed, and only those get an exact word diff.
 * A page where one price changed therefore produces one short, precise diff
 * rather than a rewritten-looking whole page.
 */
export function diffPageText(beforeRaw: string, afterRaw: string): TextDiff {
  const before = beforeRaw.slice(0, MAX_TEXT_CHARS);
  const after = afterRaw.slice(0, MAX_TEXT_CHARS);
  const truncatedInput = beforeRaw.length > MAX_TEXT_CHARS || afterRaw.length > MAX_TEXT_CHARS;

  const beforeSentences = splitSentences(before);
  const afterSentences = splitSentences(after);

  if (beforeSentences.length > MAX_SENTENCES || afterSentences.length > MAX_SENTENCES) {
    const plain = diffWords(before, after);
    return {
      segments: plain.segments,
      addedWords: countWords(plain.segments, "added"),
      removedWords: countWords(plain.segments, "removed"),
      truncated: true,
    };
  }

  const pairs = lcsAlign(beforeSentences, afterSentences);
  const segments: DiffSegment[] = [];
  let truncated = truncatedInput;

  const emit = (kind: DiffSegment["kind"], text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text = `${last.text} ${trimmed}`;
    else segments.push({ kind, text: trimmed });
  };

  let ai = 0;
  let bi = 0;
  const flushChanged = (aEnd: number, bEnd: number): void => {
    const removedRun = beforeSentences.slice(ai, aEnd);
    const addedRun = afterSentences.slice(bi, bEnd);
    if (removedRun.length === 0 && addedRun.length === 0) return;

    // A one-for-one sentence replacement is the common case (a price, a date, a
    // product name) and deserves a word-level diff. A many-to-many change is a
    // restructure; reporting it as whole sentences is more honest than pretending
    // there is a word correspondence.
    if (removedRun.length === 1 && addedRun.length === 1) {
      const wordDiff = diffWords(removedRun[0] as string, addedRun[0] as string);
      for (const segment of wordDiff.segments) emit(segment.kind, segment.text);
      if (wordDiff.truncated) truncated = true;
    } else {
      emit("removed", removedRun.join(" "));
      emit("added", addedRun.join(" "));
    }
    ai = aEnd;
    bi = bEnd;
  };

  for (const [mi, mj] of pairs) {
    flushChanged(mi, mj);
    emit("same", beforeSentences[mi] as string);
    ai = mi + 1;
    bi = mj + 1;
  }
  flushChanged(beforeSentences.length, afterSentences.length);

  return {
    segments,
    addedWords: countWords(segments, "added"),
    removedWords: countWords(segments, "removed"),
    truncated,
  };
}

function countWords(segments: DiffSegment[], kind: DiffSegment["kind"]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.kind !== kind) continue;
    total += splitWords(segment.text).length;
  }
  return total;
}

/**
 * A short, human-readable summary of a text diff, for the compare list.
 *
 * Reports both counts because "3 words changed" and "412 words removed" are very
 * different pieces of news, and a single magnitude would hide which one happened.
 */
export function summariseDiff(diff: TextDiff): string {
  const { addedWords, removedWords, truncated } = diff;
  if (addedWords === 0 && removedWords === 0) return "no textual change";
  const suffix = truncated ? " (page too large for an exact diff)" : "";
  if (removedWords > 0 && addedWords > 0) {
    return `${removedWords} word${removedWords === 1 ? "" : "s"} replaced by ${addedWords}${suffix}`;
  }
  if (addedWords > 0) return `${addedWords} word${addedWords === 1 ? "" : "s"} added${suffix}`;
  return `${removedWords} word${removedWords === 1 ? "" : "s"} removed${suffix}`;
}

/** How a page differs between two months. */
export type ChangeKind = "added" | "removed" | "changed" | "unchanged" | "unknown";

export interface PageChange {
  url: string;
  kind: ChangeKind;
  title: string | null;
  /** Present for `changed` once the detail diff has run. */
  summary?: string;
  addedWords?: number;
  removedWords?: number;
  /** Day of the later capture, for building a viewer route. */
  day: string | null;
  /** Set when kind is `changed` but no digest was available to prove it. */
  note?: string;
}

/**
 * Classify a pair of snapshots for the same URL in two months.
 *
 * ## The rule: only claim what the evidence supports
 *
 * Comparing digests is proof. Comparing size and title is a hint. The temptation
 * is to fall back to the hint and call it an answer — and that produces the two
 * worst possible outcomes for this feature:
 *
 *  - reporting `unchanged` when we simply did not look, so a real change is
 *    silently hidden; and
 *  - reporting `changed` because one side happens to have a digest and the other
 *    does not, so every page crawled before digests existed shows up as changed
 *    and the list becomes noise nobody reads.
 *
 * So `unknown` is returned whenever digests cannot be compared **and** size and
 * title give no positive evidence of a difference. It is a first-class outcome,
 * the API surfaces it with an explanation, and the fix is a re-crawl — which is
 * something the user can actually act on, unlike a wrong answer.
 */
export function classifyChange(
  before: { content_digest: string | null; title: string | null; bytes: number | null } | null,
  after: { content_digest: string | null; title: string | null; bytes: number | null; day: string } | null,
): ChangeKind {
  if (!before && !after) return "unchanged";
  if (!before) return "added";
  if (!after) return "removed";

  // Proof, when both sides recorded one.
  if (before.content_digest !== null && after.content_digest !== null) {
    return before.content_digest === after.content_digest ? "unchanged" : "changed";
  }

  // Otherwise: a positive difference in size or title is real evidence that the
  // rendered page differs, even without digests.
  if (before.bytes !== null && after.bytes !== null && before.bytes !== after.bytes) return "changed";
  if (before.title !== after.title) return "changed";

  // Neither proof nor evidence. Say so rather than guessing in either direction.
  return "unknown";
}
