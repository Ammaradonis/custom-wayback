/**
 * Mobile check: the calendar renders as a bottom sheet below 640 px, the day
 * grid still fits a 320 px viewport, and the login page (the only screen with no
 * data dependency) is legible at phone width in both themes.
 *
 * The mobile path is a separate component branch in MonthCalendar — it uses a
 * Radix Dialog instead of a Popover — so the desktop e2e run does not cover it.
 *
 * Usage: node scripts/mobile-check.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const shots = join(here, "__screens__");
if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

async function loadPlaywright() {
  const candidates = [
    join(webRoot, "node_modules", "playwright"),
    join(webRoot, "..", "..", "node_modules", "playwright"),
  ];
  const npxRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null;
  if (npxRoot && existsSync(npxRoot)) {
    for (const d of readdirSync(npxRoot)) candidates.push(join(npxRoot, d, "node_modules", "playwright"));
  }
  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  const installed = new Set(
    cache && existsSync(cache)
      ? readdirSync(cache).map((d) => /^chromium-(\d+)$/.exec(d)?.[1]).filter(Boolean)
      : [],
  );
  const revOf = (dir) => {
    const p = join(dir, "..", "playwright-core", "browsers.json");
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")).browsers?.find((b) => b.name === "chromium")?.revision ?? null;
    } catch {
      return null;
    }
  };
  let fb = null;
  for (const dir of candidates) {
    const e = join(dir, "index.mjs");
    if (!existsSync(e)) continue;
    try {
      const m = await import(pathToFileURL(e).href);
      const pw = m.chromium ? m : (m.default ?? m);
      if (!pw?.chromium) continue;
      const r = revOf(dir);
      if (r === null || installed.has(r)) return pw;
      fb = fb ?? pw;
    } catch {
      /* next */
    }
  }
  return fb;
}

const { chromium } = (await loadPlaywright()) ?? {};
if (!chromium) {
  console.error("SKIP: no Playwright.");
  process.exit(0);
}

const { createServer } = await import("node:net");
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const url = `http://127.0.0.1:${port}/`;

const vite = spawn(
  process.execPath,
  [join(webRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] },
);
for (let i = 0; i < 120; i += 1) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 400));
}

const DOMAIN_ID = "01JDOMAIN0000000000000000";
const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ channel: "chromium" });

for (const theme of ["dark", "light"]) {
  console.log(`\n=== ${theme.toUpperCase()} — 320x720 phone ===`);
  const context = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 320, height: 720 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  await context.route("**/v1/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const j = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/v1/domains") {
      return j([
        { id: DOMAIN_ID, domain: "samsung.com", hostFilter: null, trackingStatus: "idle", addedAt: 1, lastCrawledAt: null },
      ]);
    }
    if (p === "/v1/manifest") {
      const month = new URL(route.request().url()).searchParams.get("month");
      const days = month === "2026-01" ? ["2026-01-05", "2026-01-06", "2026-01-20"] : [];
      return j({
        version: 1,
        domain: "samsung.com",
        month,
        days,
        pages: days.map((d, i) => ({
          url: `https://samsung.com/p${i + 1}`,
          day: d,
          ts: `${d.replace(/-/g, "")}120000`,
          title: `p${i + 1}`,
          bytes: 1000,
          route: `/a/samsung.com/${d}/p${i + 1}`,
          resolvedDay: d,
          deltaDays: 0,
          stored: true,
          purged: false,
        })),
        stats: {},
      });
    }
    if (p === "/v1/sites") return j({ sites: [{ domain: "samsung.com", month: "2026-01", pages: 3, days: 3 }] });
    if (p === "/v1/jobs/usage") {
      return j({
        month: "2026-01", meteredUsd: 0, planFloorUsd: 0, totalUsd: 0,
        budget: { state: "disabled", spentUsd: 0, budgetUsd: 0, remainingUsd: 0, fraction: 0, crawlsBlocked: false },
        byKind: [], byDomain: [],
        quota: { used: 0, limit: 8, remaining: 8, resetsAt: 1767312000 },
        throttle: { events: 0, totalWaitMs: 0, byStatus: {}, lastEventAt: null },
        generatedAt: 1767225600,
      });
    }
    return j({});
  });

  // ── Login page (no auth, no data) ──
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, "login page does not overflow at 320px", `${overflow}px`);

  const emailBg = await page.locator("#email").evaluate((el) => getComputedStyle(el).backgroundColor);
  check(emailBg !== "rgba(0, 0, 0, 0)", "login email field has a fill", emailBg);

  const submitBg = await page.getByRole("button", { name: /Sign in/ }).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, h: el.getBoundingClientRect().height };
  });
  check(submitBg.bg !== "rgba(0, 0, 0, 0)", "login submit button is filled", submitBg.bg);
  check(submitBg.h >= 44, "login submit button meets the 44px touch target", `${submitBg.h}px`);
  await page.screenshot({ path: join(shots, `login-320-${theme}.png`), fullPage: true });

  // ── Dashboard: calendar must open as a bottom sheet at this width ──
  const dash = await context.newPage();
  await dash.addInitScript(() => window.localStorage.setItem("cw_token", "t"));
  await dash.goto(url, { waitUntil: "networkidle" });
  await dash.waitForTimeout(700);

  const trigger = dash.getByRole("button", { name: /Choose a date for/ });
  check(await trigger.isVisible(), "calendar trigger is visible on mobile");
  await trigger.click();
  await dash.waitForTimeout(450);

  // The mobile branch renders a Radix Dialog: the sheet is pinned to the bottom
  // edge and spans the full width. Assert that geometry, not just presence.
  const sheet = dash.locator(".cw-overlay").first();
  const box = await sheet.boundingBox();
  const vp = dash.viewportSize();
  check(box !== null, "bottom sheet is rendered");
  if (box && vp) {
    check(
      Math.abs(box.y + box.height - vp.height) <= 2,
      "sheet is anchored to the bottom edge",
      `bottom=${Math.round(box.y + box.height)} viewport=${vp.height}`,
    );
    check(box.x <= 1 && box.width >= vp.width - 2, "sheet spans the full width", `${Math.round(box.width)}/${vp.width}`);
  }

  const sheetOverflow = await dash.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(sheetOverflow <= 0, "no horizontal overflow with the sheet open", `${sheetOverflow}px`);

  // The day grid must fit inside the sheet without clipping columns.
  const grid = dash.getByRole("grid").first();
  check(await grid.isVisible(), "day grid renders in the mobile sheet");
  const gridBox = await grid.boundingBox();
  if (gridBox && box) {
    check(
      gridBox.x >= box.x - 2 && gridBox.x + gridBox.width <= box.x + box.width + 2,
      "day grid fits inside the sheet",
      `grid ${Math.round(gridBox.width)}px in sheet ${Math.round(box.width)}px`,
    );
    // Seven columns at 320px: any cell narrower than ~34px is unusable.
    const cellW = gridBox.width / 7;
    check(cellW >= 34, "day cells are large enough to tap", `${cellW.toFixed(1)}px per column`);
  }

  await dash.screenshot({ path: join(shots, `calendar-sheet-320-${theme}.png`) });

  // And a selection still works at this width. The fixture only has captures in
  // January, while the sheet opens on the current month, so navigate there via
  // the month heading — which also exercises the mobile sheet's level switching.
  const monthHeading = dash.getByRole("button", { name: /^Change month\./ });
  await monthHeading.click();
  await dash.waitForTimeout(250);
  const currentYear = new Date().getFullYear();
  const january = dash.getByRole("button", { name: `January ${currentYear}` });
  if ((await january.count()) && (await january.isEnabled())) {
    await january.click();
    await dash.waitForTimeout(450);
  }

  const cell = grid
    .locator('button[role="gridcell"][aria-label*="1 capture"]:not([disabled])')
    .first();
  if (await cell.count()) {
    await cell.click();
    await dash.waitForTimeout(450);
    const label = (await trigger.textContent())?.trim() ?? "";
    check(!label.includes("Pick a day"), "selecting a day works from the mobile sheet", label);
  } else {
    // Fall back to any selectable day: a zero-capture day is selectable by
    // design, so this still proves the tap path works at 320px.
    const anyDay = grid.locator('button[role="gridcell"]:not([disabled])').first();
    if (await anyDay.count()) {
      await anyDay.click();
      await dash.waitForTimeout(450);
      const label = (await trigger.textContent())?.trim() ?? "";
      check(!label.includes("Pick a day"), "selecting a day works from the mobile sheet", label);
    } else {
      check(false, "a selectable day was available to tap in the mobile sheet");
    }
  }

  check(errors.length === 0, "no page errors", errors.join(" | ") || "none");
  await context.close();
}

await browser.close();
vite.kill();

console.log(
  `\n${failures.length === 0 ? "MOBILE CHECK: all checks passed" : `MOBILE CHECK: ${failures.length} failing`}`,
);
for (const f of failures) console.error(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
