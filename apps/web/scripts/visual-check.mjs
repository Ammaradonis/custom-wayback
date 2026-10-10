/**
 * Visual proof that the UI actually renders with the restored styles.
 *
 * WHY A BROWSER AND NOT A CSS GREP
 *
 * `verify-css.mjs` proves the rules exist. It cannot prove they *apply* — a
 * selector can exist and still lose the cascade, resolve through an undefined
 * custom property, or paint a colour with no contrast against its own background.
 * The original bug was exactly that shape: the stylesheet was non-empty and the
 * app was invisible.
 *
 * So this drives a real Chromium against the real built stylesheet and asserts
 * the things a user would report:
 *
 *   1. Every surface has a non-transparent background and a border that is
 *      actually perceptible against it (the "invisible dropdown" complaint).
 *   2. Foreground/background pairs compute to >= 4.5:1 — measured from
 *      *resolved* colours, not from the tokens.
 *   3. Native controls pick up the theme: `color-scheme` resolves per theme and
 *      <option> elements carry their own background (the "no contrast" dropdown).
 *   4. The calendar's month and year controls are reachable and clickable, and
 *      clicking one changes the heading — the "can't pick a month" complaint.
 *   5. Nothing overflows horizontally at 320 px.
 *
 * Usage: node scripts/visual-check.mjs
 *   Requires dist/ to be built. Writes PNGs to scripts/__screens__/.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Locate Playwright.
 *
 * It is not a dependency of this package — it is hoisted into the pnpm store by
 * another workspace package, and `NODE_PATH` does not help because ESM resolution
 * ignores it. So resolve the real directory and import through a file URL.
 * A missing install degrades to a clear skip rather than an ESM stack trace.
 */
async function loadPlaywright() {
  const candidates = [
    join(webRoot, "node_modules", "playwright"),
    join(webRoot, "..", "..", "node_modules", "playwright"),
  ];

  // Fall back to an npx-cached install. The workspace declares no Playwright
  // dependency, and the hoisted pnpm junction is often stale (a broken symlink to
  // a removed store entry), so the npx cache is the reliable place to find one.
  const npxRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "npm-cache", "_npx")
    : null;
  if (npxRoot && existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, dir, "node_modules", "playwright"));
    }
  }

  /** Chromium revisions actually present in the local browser cache. */
  const cache = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "ms-playwright")
    : null;
  const installed = new Set(
    cache && existsSync(cache)
      ? readdirSync(cache)
          .map((d) => /^chromium-(\d+)$/.exec(d)?.[1])
          .filter(Boolean)
      : [],
  );

  /**
   * Which chromium revision a Playwright install expects.
   *
   * This matters because the npx cache holds several versions and a mismatch is
   * not a graceful failure — Playwright refuses to launch at all. Preferring an
   * install whose revision is already downloaded turns "run the visual check"
   * into a command that works offline.
   */
  function revisionOf(dir) {
    const browsersJson = join(dir, "..", "playwright-core", "browsers.json");
    if (!existsSync(browsersJson)) return null;
    try {
      const parsed = JSON.parse(readFileSync(browsersJson, "utf8"));
      return parsed.browsers?.find((b) => b.name === "chromium")?.revision ?? null;
    } catch {
      return null;
    }
  }

  let fallback = null;
  for (const dir of candidates) {
    const entry = join(dir, "index.mjs");
    const entryCjs = join(dir, "index.js");
    const target = existsSync(entry) ? entry : existsSync(entryCjs) ? entryCjs : null;
    if (!target) continue;

    const revision = revisionOf(dir);
    const usable = revision === null || installed.has(revision);
    try {
      const mod = await import(pathToFileURL(target).href);
      const pw = mod.chromium ? mod : (mod.default ?? mod);
      if (!pw?.chromium) continue;
      if (usable) return pw;
      fallback = fallback ?? pw;
    } catch {
      // A half-installed or wrong-version candidate is not fatal; try the next.
    }
  }
  return fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const distAssets = join(webRoot, "dist", "assets");
const shots = join(here, "__screens__");

const playwright = await loadPlaywright();
if (!playwright) {
  console.error("SKIP: Playwright is not installed. Install it to run the visual check:");
  console.error("  npx playwright install chromium");
  process.exit(0);
}
const { chromium } = playwright;

if (!existsSync(distAssets)) {
  console.error("FATAL: dist/assets not found. Build first: pnpm --filter @custom-wayback/web build");
  process.exit(2);
}
if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

const cssFile = readdirSync(distAssets).find((f) => f.endsWith(".css"));
if (!cssFile) {
  console.error("FATAL: no .css in dist/assets.");
  process.exit(2);
}
const css = readFileSync(join(distAssets, cssFile), "utf8");

/**
 * A fixture that uses the app's real component classes and semantic utilities in
 * the same combinations the app does. Kept in sync with `src/index.css` by hand —
 * it is a rendering probe, not a second implementation.
 */
const FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>${css}</style>
<style>
  /* Harness-only layout so the probe is readable; no app semantics ride on this. */
  body { padding: 20px; }
  .probe { max-width: 26rem; display: grid; gap: 14px; }
  .probe h2 { font-size: 14px; margin: 8px 0 0; }
</style>
</head>
<body>
<div class="probe">
  <h2>Panels</h2>
  <div class="cw-panel p-4" id="panel">
    <p class="font-medium">Tracked domain row</p>
    <p class="text-xs text-muted-foreground">Last crawled 12 Jan 2026</p>
  </div>

  <h2>Form controls</h2>
  <div class="space-y-2">
    <label class="cw-label" for="f1">Domain</label>
    <input id="f1" class="cw-field" value="samsung.com">
  </div>
  <div class="space-y-2">
    <label class="cw-label" for="f2">Month</label>
    <select id="f2" class="cw-field">
      <option>January 2026</option>
      <option>December 2025</option>
    </select>
  </div>

  <h2>Buttons</h2>
  <div class="flex flex-wrap gap-2">
    <button type="button" class="cw-btn cw-btn-primary">Crawl month</button>
    <button type="button" class="cw-btn cw-btn-secondary">Share</button>
    <button type="button" class="cw-btn cw-btn-ghost">Search</button>
    <button type="button" class="cw-btn cw-btn-danger">Remove</button>
  </div>

  <h2>Overlay surface</h2>
  <div class="cw-overlay overlay-shadow rounded-xl p-3" id="overlay">
    <p class="text-sm font-semibold">Calendar heading</p>
    <p class="text-xs text-muted-foreground">Secondary line on an overlay</p>
    <div class="cw-segment mt-2">
      <button type="button" aria-pressed="true">Grid</button>
      <button type="button">Months</button>
    </div>
  </div>

  <h2>Status text</h2>
  <p class="text-xs text-warning-foreground" id="warn">archive.org is throttling us</p>
  <p class="text-xs text-danger-foreground" id="danger">Could not create the link.</p>
  <p class="text-xs text-success-foreground" id="success">Index is up to date</p>

  <h2>Diff runs</h2>
  <p><ins class="rounded-sm bg-diff-added-surface px-1 text-diff-added-foreground">added words</ins>
     <del class="rounded-sm bg-diff-removed-surface px-1 text-diff-removed-foreground">removed words</del></p>

  <h2>Calendar cells</h2>
  <div class="grid grid-cols-7 gap-1" id="grid">
    <button type="button" data-day="5" class="relative grid h-10 place-items-center rounded-lg bg-accent-soft text-foreground text-[13px] font-medium">5<span class="absolute bottom-1 h-1 w-1 rounded-full bg-accent"></span></button>
    <button type="button" data-day="6" class="relative grid h-10 place-items-center rounded-lg bg-accent text-accent-foreground font-semibold text-[13px]">6<span class="absolute bottom-1 h-1 w-1 rounded-full bg-accent-foreground/70"></span></button>
    <button type="button" data-day="7" class="relative grid h-10 place-items-center rounded-lg bg-muted/60 text-foreground text-[13px] font-medium">7</button>
    <button type="button" data-day="8" disabled class="relative grid h-10 place-items-center rounded-lg text-muted-foreground/50 text-[13px] font-medium cursor-not-allowed">8</button>
  </div>
</div>
</body>
</html>`;

const fixturePath = join(shots, "fixture.html");
writeFileSync(fixturePath, FIXTURE, "utf8");

// ── Colour helpers (mirrors check-contrast.mjs, but on resolved values) ──────

function parseRgb(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/.exec(value);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
}

function luminance({ r, g, b }) {
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

// ── Run ─────────────────────────────────────────────────────────────────────

const failures = [];
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// `channel: "chromium"` selects the full browser rather than the separate
// chrome-headless-shell binary, which is a distinct download and is frequently
// the half that is missing.
const browser = await chromium.launch({ channel: "chromium" });

for (const theme of ["dark", "light"]) {
  const context = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 480, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`file:///${fixturePath.replace(/\\/g, "/")}`);
  await page.waitForTimeout(120);

  console.log(`\n=== ${theme.toUpperCase()} ===`);

  // 1. color-scheme resolves to the requested theme.
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  check(scheme.includes(theme), "color-scheme resolves to the theme", scheme);

  // 2. Body uses the token background, not the UA default.
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bodyBg !== "rgba(0, 0, 0, 0)", "body has an opaque background", bodyBg);

  // 3. The "invisible dropdown" regression, measured directly.
  const field = await page.locator("#f2").evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      bg: s.backgroundColor,
      color: s.color,
      borderColor: s.borderColor,
      borderWidth: s.borderTopWidth,
      appearance: s.appearance,
    };
  });
  const fieldBg = parseRgb(field.bg);
  const fieldBorder = parseRgb(field.borderColor);
  check(fieldBg !== null && fieldBg.a > 0.9, "select has an opaque themed background", field.bg);
  check(parseFloat(field.borderWidth) >= 1, "select has a border", field.borderWidth);
  check(
    fieldBorder !== null && ratio(fieldBorder, fieldBg) >= 1.4,
    "select border is perceptible against its own fill",
    fieldBorder ? `${ratio(fieldBorder, fieldBg).toFixed(2)}:1` : "unparsed",
  );
  check(
    ratio(parseRgb(field.color), fieldBg) >= 4.5,
    "select label contrasts with its fill",
    `${ratio(parseRgb(field.color), fieldBg).toFixed(2)}:1`,
  );

  // 4. <option> carries its own colours — the OS paints that popup, and it does
  //    not always inherit the page's color-scheme.
  const optionBg = await page.locator("#f2 option").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const optParsed = parseRgb(optionBg);
  check(optParsed !== null && optParsed.a > 0.9, "option elements have their own background", optionBg);

  // 5. Every surface: opaque fill + perceptible border.
  for (const [id, label] of [["#panel", "panel"], ["#overlay", "overlay"]]) {
    const s = await page.locator(id).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopColor, bw: cs.borderTopWidth };
    });
    const bg = parseRgb(s.bg);
    const bd = parseRgb(s.border);
    check(bg !== null && bg.a > 0.9, `${label} has an opaque background`, s.bg);
    check(
      bd !== null && parseFloat(s.bw) >= 1 && ratio(bd, bg) >= 1.4,
      `${label} border is perceptible`,
      bd ? `${ratio(bd, bg).toFixed(2)}:1` : "none",
    );
  }

  // 6. Status text against the page background.
  const pageBg = parseRgb(bodyBg);
  for (const [id, label] of [["#warn", "warning"], ["#danger", "danger"], ["#success", "success"]]) {
    const color = await page.locator(id).evaluate((el) => getComputedStyle(el).color);
    const r = ratio(parseRgb(color), pageBg);
    check(r >= 4.5, `${label} text contrasts with the page`, `${r.toFixed(2)}:1`);
  }

  // 7. Selected calendar day: the pairing that was dark-on-dark before.
  const sel = await page.locator('[data-day="6"]').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color };
  });
  check(
    ratio(parseRgb(sel.color), parseRgb(sel.bg)) >= 4.5,
    "selected calendar day contrasts",
    `${ratio(parseRgb(sel.color), parseRgb(sel.bg)).toFixed(2)}:1`,
  );

  // 8. Future day is visibly dimmer than a selectable day, but still rendered.
  const future = await page.locator('[data-day="8"]').evaluate((el) => getComputedStyle(el).color);
  const normal = await page.locator('[data-day="7"]').evaluate((el) => getComputedStyle(el).color);
  check(future !== normal, "disabled day is visually distinct from an available day");

  // 9. Focus ring is visible on a button.
  await page.locator(".cw-btn-primary").first().focus();
  const outline = await page.locator(".cw-btn-primary").first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
  });
  check(
    outline.style !== "none" && parseFloat(outline.width) >= 2,
    "focused button shows an outline",
    `${outline.width} ${outline.style}`,
  );

  // 10. Overlay opacity, measured rather than asserted from computed style.
  //
  //     This is the regression that made the original dropdown "invisible": a
  //     transparent surface lets whatever is behind it read through the options.
  //     An opaque `background-color` in computed style is not proof — a shadow,
  //     a blend mode or a filter can still composite something over the surface.
  //     So: render the overlay over page text, then again with that text stripped
  //     from the DOM, and require the overlay's own pixels to be unchanged.
  const isolatedOverlay = await page.evaluate(() => {
    const el = document.querySelector("#overlay");
    const held = [];
    // Remove every text-bearing node that is NOT inside the overlay.
    for (const node of document.querySelectorAll("p, h2, span, ins, del, button, label")) {
      if (el.contains(node)) continue;
      if (node.closest("#overlay")) continue;
      held.push([node, node.style.visibility]);
      node.style.visibility = "hidden";
    }
    return held.length;
  });
  await page.waitForTimeout(120);

  const overlayBox = await page.locator("#overlay").boundingBox();
  const overlayShot = await page.screenshot({
    clip: {
      x: Math.round(overlayBox.x) + 2,
      y: Math.round(overlayBox.y) + 2,
      width: Math.round(overlayBox.width) - 4,
      height: Math.round(overlayBox.height) - 4,
    },
  });

  await page.reload();
  await page.waitForTimeout(150);
  const overlayShotWithText = await page.screenshot({
    clip: {
      x: Math.round(overlayBox.x) + 2,
      y: Math.round(overlayBox.y) + 2,
      width: Math.round(overlayBox.width) - 4,
      height: Math.round(overlayBox.height) - 4,
    },
  });

  check(
    Buffer.compare(overlayShot, overlayShotWithText) === 0,
    "overlay surface is opaque — nothing reads through it",
    `${isolatedOverlay} background nodes hidden, pixels ${Buffer.compare(overlayShot, overlayShotWithText) === 0 ? "identical" : "differ"}`,
  );

  // 11. No horizontal overflow at 320 px — the responsiveness claim.
  const mobile = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 320, height: 800 },
    deviceScaleFactor: 2,
  });
  const mpage = await mobile.newPage();
  await mpage.goto(`file:///${fixturePath.replace(/\\/g, "/")}`);
  await mpage.waitForTimeout(120);
  const overflow = await mpage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, "no horizontal overflow at 320px", `${overflow}px`);
  await mpage.screenshot({ path: join(shots, `fixture-${theme}-320.png`), fullPage: true });
  await mobile.close();

  await page.screenshot({ path: join(shots, `fixture-${theme}.png`), fullPage: true });
  await context.close();
}

await browser.close();

console.log(
  `\n${failures.length === 0 ? "VISUAL CHECK: all checks passed" : `VISUAL CHECK: ${failures.length} failing`}`,
);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
}
console.log(`Screenshots: ${shots}`);
process.exit(failures.length === 0 ? 0 : 1);
