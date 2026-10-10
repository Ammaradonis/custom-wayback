/**
 * Term highlighting for archived text (search snippets).
 *
 * Two rules, both non-negotiable:
 *
 *  1. **No HTML is produced here.** `splitMatches` returns a flat array of
 *     `{ text, match }` runs, so a caller renders React elements and the archived
 *     page's own text — which is third-party content and may well contain
 *     `<script>` — is never anything but text. Raw-HTML injection is not used
 *     anywhere in this app, and this is the function that would tempt it.
 *  2. **Every run of the input survives.** The pieces concatenate back to exactly
 *     the string that came in — no trimming, no case-folding, no re-ordering.
 *
 * The input to `highlightTerms` is user input, so it is treated as a literal:
 * `c++` searches for `c++`, it does not throw.
 */

/** One run of text, flagged when it is one of the asked-for terms. */
export interface HighlightPiece {
  text: string;
  match: boolean;
}

/** Escape a string so it can only ever match itself inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * The terms worth emphasising.
 *
 * Single characters are dropped: highlighting every "a" makes a snippet
 * unreadable and hides the term the user actually typed. Purely punctuated
 * fragments are dropped for the same reason.
 */
export function highlightTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.trim().split(/\s+/)) {
    // Strip the syntax FTS5 gives meaning to, so the *displayed* emphasis tracks
    // the words the user meant rather than the operators they may have typed.
    const term = raw.replace(/^["'*(\-+]+/, "").replace(/["'*)]+$/, "");
    if (term.length < 2) continue;
    if (!WORD.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * Split `text` into runs, flagging every occurrence of any term in `query`.
 *
 * Word-boundary anchored on both sides, so searching "art" does not light up
 * "start". When no term applies the whole string is returned as one plain piece,
 * which is the common case and costs one regex test.
 *
 * `value.lastIndex` is reset before the scan because `exec` on a `/g/` regex is
 * stateful, and a shared module-level regex would otherwise skip matches on
 * alternate calls.
 */
export function splitMatches(text: string, query: string): HighlightPiece[] {
  const terms = highlightTerms(query);
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }];

  let pattern: RegExp;
  try {
    pattern = new RegExp(
      `\\b(?:${terms.map(escapeRegExp).join("|")})\\b`,
      "giu",
    );
  } catch {
    // A construct the engine refuses (surrogate edge cases) is not worth
    // failing a search over: render the snippet unemphasised instead.
    return [{ text, match: false }];
  }

  const pieces: HighlightPiece[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  let hit = pattern.exec(text);
  while (hit !== null) {
    const start = hit.index;
    const matched = hit[0];
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), match: false });
    pieces.push({ text: matched, match: true });
    cursor = start + matched.length;
    // A zero-length match cannot advance the scan; guard rather than spin.
    if (matched.length === 0) pattern.lastIndex += 1;
    hit = pattern.exec(text);
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), match: false });

  return pieces.length > 0 ? pieces : [{ text, match: false }];
}
