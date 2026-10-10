/**
 * Verify that the semantic colour utilities the app uses actually exist in the
 * built stylesheet.
 *
 * WHY THIS EXISTS
 *
 * The bug this guards against produced a *successful* build. `vite build` exited
 * 0, the CSS bundled to 52 KB, gzipped fine, and precached into the service
 * worker — and contained not one rule for `bg-background`, `text-foreground`,
 * `border-border` or any of their 20-odd siblings, because the tokens were
 * declared in `@layer base` instead of `@theme`. Tailwind therefore never
 * registered them and never generated the utilities, and nothing failed loudly.
 *
 * A green build is not evidence that a stylesheet styles anything. This script is
 * the missing assertion: it derives the class list from the source, so a new
 * `bg-popover` in a component is checked on the next run without anyone
 * remembering to add it here.
 *
 * Usage: node scripts/verify-css.mjs [--keep]
 *   expects `dist/` to have been built (pnpm --filter @custom-wayback/web build)
 */

import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const srcRoot = join(webRoot, "src");
const distAssets = join(webRoot, "dist", "assets");

if (!existsSync(distAssets)) {
  console.error("FATAL: dist/assets not found. Build first:");
  console.error("  npx --no-install pnpm --filter @custom-wayback/web build");
  process.exit(2);
}

const cssFile = readdirSync(distAssets).find((f) => f.endsWith(".css"));
if (!cssFile) {
  console.error("FATAL: no .css emitted into dist/assets.");
  process.exit(2);
}
const css = readFileSync(join(distAssets, cssFile), "utf8");

// ── Walk the source for every utility class that references a theme token ────

/** Colour-carrying utility prefixes, including opacity (`/40`) and gradient stops. */
const PREFIXES = [
  "bg", "text", "border", "ring", "ring-offset", "fill", "stroke",
  "divide", "outline", "decoration", "shadow", "accent", "caret",
  "from", "via", "to", "placeholder",
];

/** Token names under the `--color-*` namespace that the app treats as semantic. */
const TOKENS = [
  "background", "foreground",
  "card", "card-foreground",
  "popover", "popover-foreground",
  "muted", "muted-foreground",
  "accent", "accent-foreground", "accent-soft",
  "border", "input", "ring",
  "success", "success-foreground",
  "warning", "warning-foreground",
  "danger", "danger-foreground",
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    // Only TS/TSX. Scanning the CSS files too was a self-inflicted false
    // positive: their comments *discuss* `bg-background` and `accent-foreground`
    // in prose, and the scanner cannot tell prose from a className. Utilities are
    // only ever authored in TSX, so that is the only place worth reading.
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Every `prefix-token` combination that appears in the source, reduced to the
 * shape Tailwind actually emits.
 *
 * Two normalisations matter, and both were bugs in the first draft of this file:
 *
 *  1. **Opacity modifiers fold into the base selector.** `bg-accent/40` does not
 *     emit a `.bg-accent/40` rule — it emits `.bg-accent\/40`, whose leading
 *     token is still `bg-accent`. Keying the check on `bg-accent` means one
 *     assertion covers every opacity step, which is the property that actually
 *     matters: if the token is registered, all of them exist.
 *
 *  2. **Variant prefixes are checked, not stripped.** `hover:bg-muted/40` emits
 *     `.hover\:bg-muted\/40:hover`, so the selector does begin with the variant.
 *     Keeping the prefix in the key means a variant that Tailwind *did* generate
 *     is not reported as missing.
 *
 * The trailing `(?![a-z-])` guard is the other half of normalisation 1: without
 * it, `bg-accent-foreground` also registers as `bg-accent`, and `text-muted` as
 * `text-muted-foreground` — phantom entries that can never be found in the CSS.
 */
const used = new Set();

// Longest token first, so `muted-foreground` wins over `muted` at the same
// position regardless of the order they are listed above.
const TOKENS_BY_LENGTH = [...TOKENS].sort((a, b) => b.length - a.length);

const classRe = new RegExp(
  `(?:^|[\\s"'\`])((?:[a-z-]+:)*)(${PREFIXES.join("|")})-(${TOKENS_BY_LENGTH.join("|")})(?![a-z-])`,
  "g",
);

// A tail guard alone is not enough: in `bg-accent-foreground`, the scanner also
// sees the suffix `accent-foreground` (with `accent` itself treated as a
// "prefix"), which is not a class anyone wrote. Reject any match glued to a
// preceding identifier character.
const precededByWordChar = /[A-Za-z0-9_-]$/;
const tailGlued = /^[A-Za-z0-9_-]/;

for (const file of walk(srcRoot)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(classRe)) {
    const start = m.index + m[0].length - `${m[1]}${m[2]}-${m[3]}`.length;
    if (start > 0 && precededByWordChar.test(text.slice(0, start))) continue;
    if (tailGlued.test(text.slice(m.index + m[0].length))) continue;
    used.add(`${m[1]}${m[2]}-${m[3]}`);
  }
}

if (used.size === 0) {
  console.error("FATAL: found no semantic utilities in src/ — the walker is broken.");
  process.exit(2);
}

// ── Check each one is a real selector in the emitted CSS ─────────────────────

/**
 * Tailwind writes `hover:` as `.hover\:`, `[` as `\[`, `/` as `\/` — so the
 * selector is the class name with every non-identifier character backslash-
 * escaped. Build that, then allow the compound suffix Tailwind appends
 * (`:hover`, `:focus-visible`, `[data-state=open]`, …).
 */
function selectorRe(cls) {
  const escaped = cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\\\${c}`);
  return new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`);
}

const missing = [];
const present = [];

for (const cls of [...used].sort()) {
  if (selectorRe(cls).test(css)) present.push(cls);
  else missing.push(cls);
}

// ── Also assert the theme variables themselves are emitted ───────────────────

const missingVars = [];
for (const token of TOKENS) {
  if (!css.includes(`--color-${token}:`)) missingVars.push(`--color-${token}`);
}
if (!css.includes("color-scheme:")) missingVars.push("color-scheme (native control theming)");

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`Stylesheet: dist/assets/${cssFile}  (${(css.length / 1024).toFixed(1)} KB)`);
console.log(`Semantic utilities found in source: ${used.size}`);
console.log(`  emitted      : ${present.length}`);
console.log(`  MISSING      : ${missing.length}`);
console.log(`Theme variables + color-scheme: ${missingVars.length === 0 ? "all present" : `${missingVars.length} MISSING`}`);

if (missing.length > 0) {
  console.error("\nThese classes are used in the app but have NO CSS rule behind them:");
  for (const cls of missing) console.error(`  ${cls}`);
}
if (missingVars.length > 0) {
  console.error("\nThese tokens never reached the stylesheet:");
  for (const v of missingVars) console.error(`  ${v}`);
}

const failed = missing.length > 0 || missingVars.length > 0;
console.log(
  `\n${failed ? "CSS VERIFY: FAILED — the app will render with dead classes." : "CSS VERIFY: all semantic utilities and tokens emitted"}`,
);
process.exit(failed ? 1 : 0);
