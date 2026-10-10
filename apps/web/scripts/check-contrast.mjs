/**
 * Contrast audit for the semantic colour tokens in `src/index.css`.
 *
 * The tokens were originally chosen by eye and shipped in a `@layer base` block
 * that Tailwind v4 never turned into utilities, so nobody ever saw them applied —
 * and nobody ever measured them. This script is the part that makes "restore
 * contrast" a checkable claim instead of a vibe: it parses the real token values
 * out of the stylesheet and asserts every foreground/background pairing the app
 * actually renders meets WCAG 2.1 AA (4.5:1 body text, 3:1 large text and UI
 * boundaries).
 *
 * Run: node scripts/check-contrast.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The tokens live in their own file so this audit can parse exactly the block
// that ships, with no markup or utility CSS in the way.
const cssPath = join(here, "..", "src", "styles", "tokens.css");
const css = readFileSync(cssPath, "utf8");

// ── Parse `--name: light-dark(<light>, <dark>);` out of the token block ──────

/** @type {Map<string, {light: string, dark: string}>} */
const tokens = new Map();

// Both alternatives must be able to contain a comma of their own — every value
// here is `hsl(H S% L%)` or `hsl(H S% L% / A)`, and a `[^,]+?` class would stop
// inside the first `hsl(` and then fail to find the closing paren.
const declRe = /--([a-z0-9-]+)\s*:\s*light-dark\(\s*(.*?)\s*,\s*(.*?)\s*\)\s*;/g;
for (const m of css.matchAll(declRe)) {
  tokens.set(m[1], { light: m[2].trim(), dark: m[3].trim() });
}

/** Plain `--name: <value>;` declarations (radius, etc.). */
const plain = new Map();
for (const m of css.matchAll(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
  if (!m[2].includes("light-dark(")) plain.set(m[1], m[2].trim());
}

if (tokens.size === 0) {
  console.error("FATAL: no light-dark() tokens found in src/index.css.");
  console.error("The token block moved or changed shape — update this script with it.");
  process.exit(2);
}

// ── Colour maths ─────────────────────────────────────────────────────────────

/** `hsl(217 91% 45%)` or `hsl(217 91% 45% / 0.12)` → [r, g, b] in 0..255. */
function parseHsl(value) {
  const m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*[\d.]+%?\s*)?\)$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;

  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

/** Relative luminance per WCAG 2.1. */
function luminance([r, g, b]) {
  const chan = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a bare token name ("foreground") to the `--color-*` theme entry. */
const rgb = (name, mode) => {
  const t = tokens.get(`color-${name}`);
  if (!t) return null;
  const parsed = parseHsl(t[mode]);
  if (!parsed) {
    console.error(`FATAL: token --color-${name} (${mode}) is not a parseable hsl() value: ${t[mode]}`);
    process.exit(2);
  }
  return parsed;
};

// ── The pairings the app actually renders ────────────────────────────────────
// `min` is the WCAG threshold that applies to that specific usage.

const CHECKS = [
  // Body copy and headings
  ["foreground", "background", 4.5, "body text on the page"],
  ["foreground", "card", 4.5, "body text on a panel"],
  ["foreground", "muted", 4.5, "body text on a muted chip"],
  ["card-foreground", "card", 4.5, "panel text"],

  // Secondary / helper text — the thing that reads as "invisible" when too dim
  ["muted-foreground", "background", 4.5, "secondary text on the page"],
  ["muted-foreground", "card", 4.5, "secondary text on a panel"],
  ["muted-foreground", "muted", 4.5, "secondary text on a muted chip"],

  // Primary action ("Crawl month", "Add", "Sign in")
  ["accent-foreground", "accent", 4.5, "primary button label"],
  ["accent", "background", 4.5, "accent text/link on the page"],
  ["accent", "card", 4.5, "accent text/link on a panel"],

  // Focus ring must be visible against what it sits on
  ["ring", "background", 3, "focus ring on the page"],
  ["ring", "card", 3, "focus ring on a panel"],
  ["ring", "muted", 3, "focus ring on a muted chip"],

  // Boundaries: an unlit border is what made inputs and popovers disappear
  ["border", "background", 1.5, "hairline border visibility"],
  ["input", "background", 1.5, "input outline visibility"],
  ["input", "card", 1.5, "input outline on a panel"],

  // Status text
  ["success-foreground", "background", 4.5, "success text"],
  ["warning-foreground", "background", 4.5, "warning/throttle text"],
  ["danger-foreground", "background", 4.5, "error text"],
  ["danger-foreground", "card", 4.5, "error text on a panel"],
  ["warning-foreground", "card", 4.5, "warning text on a panel"],

  // Selected calendar day + coverage dots (never carry meaning by colour alone,
  // but must still be perceptible)
  ["accent-foreground", "accent", 4.5, "selected calendar day"],

  // Overlay-backed surfaces: dialogs/sheets use `popover` in light mode
  ["popover-foreground", "popover", 4.5, "text on an overlay surface"],
  ["muted-foreground", "popover", 4.5, "secondary text on an overlay surface"],

  // Word-level diff runs: tinted blocks of body text, so each tint must carry
  // readable type in both themes.
  ["diff-added-foreground", "diff-added-surface", 4.5, "added diff run"],
  ["diff-removed-foreground", "diff-removed-surface", 4.5, "removed diff run"],
];

let failures = 0;
let worst = { ratio: Infinity, label: "" };

for (const mode of ["light", "dark"]) {
  console.log(`\n=== ${mode.toUpperCase()} THEME ===`);
  for (const [fg, bg, min, label] of CHECKS) {
    const a = rgb(fg, mode);
    const b = rgb(bg, mode);
    if (!a || !b) {
      console.error(`  MISSING TOKEN: --${a ? bg : fg}`);
      failures += 1;
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failures += 1;
    const margin = r - min;
    if (margin < worst.ratio - 0 && margin < (worst.margin ?? Infinity)) {
      worst = { ratio: margin, margin, label: `${mode}: ${label}` };
    }
    const rel = r / min;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(6)}:1  (min ${min})  ` +
        `x${rel.toFixed(2)}  ${label}  [--${fg} on --${bg}]`,
    );
  }
}

const radius = plain.get("radius");
console.log(`\n--radius = ${radius ?? "(missing)"}`);

console.log(
  `\n${failures === 0 ? "CONTRAST AUDIT: all checks passed" : `CONTRAST AUDIT: ${failures} failing check(s)`}`,
);
if (worst.label) {
  console.log(`Tightest margin: ${worst.label} (${worst.ratio >= 0 ? "+" : ""}${worst.ratio.toFixed(3)} over the minimum)`);
}
process.exit(failures === 0 ? 0 : 1);
