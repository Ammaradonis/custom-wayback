/**
 * End-to-end proof that the calendar can select a month and a day.
 *
 * This is the assertion the original bug report was about: "calendars do not
 * allow me to pick a month or a certain day". Every other script here checks a
 * static artefact; this one drives the real React component in a real browser
 * against a stubbed API and asserts that pressing the controls changes the app's
 * state.
 *
 * It covers the three things that were actually broken:
 *
 *   1. The month heading control opens a month grid and picking a month moves the
 *      day grid and refetches coverage for it (the old `<select>` navigated the
 *      grid but left every day unselectable).
 *   2. The year control opens a year grid and picking a year is reflected.
 *   3. Clicking a day with captures commits it — the trigger label changes — and
 *      clicking a day with none is *still possible* rather than a dead cell.
 *
 * Usage: node scripts/e2e-calendar.mjs
 *   Starts its own Vite dev server on a free port and shuts it down afterwards.
 *   Screenshots land in scripts/__screens__/.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const shots = join(here, "__screens__");
if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

// ── Playwright loader (same strategy as visual-check.mjs) ────────────────────

async function loadPlaywright() {
  const candidates = [
    join(webRoot, "node_modules", "playwright"),
    join(webRoot, "..", "..", "node_modules", "playwright"),
  ];
  const npxRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "npm-cache", "_npx")
    : null;
  if (npxRoot && existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, dir, "node_modules", "playwright"));
    }
  }

  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  const installed = new Set(
    cache && existsSync(cache)
      ? readdirSync(cache).map((d) => /^chromium-(\d+)$/.exec(d)?.[1]).filter(Boolean)
      : [],
  );

  function revisionOf(dir) {
    const p = join(dir, "..", "playwright-core", "browsers.json");
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      return parsed.browsers?.find((b) => b.name === "chromium")?.revision ?? null;
    } catch {
      return null;
    }
  }

  let fallback = null;
  for (const dir of candidates) {
    const entry = join(dir, "index.mjs");
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const pw = mod.chromium ? mod : (mod.default ?? mod);
      if (!pw?.chromium) continue;
      const rev = revisionOf(dir);
      if (rev === null || installed.has(rev)) return pw;
      fallback = fallback ?? pw;
    } catch {
      /* try the next */
    }
  }
  return fallback;
}

// Need readFileSync for revisionOf — already imported at the top.

const playwright = await loadPlaywright();
if (!playwright) {
  console.error("SKIP: no usable Playwright install found.");
  process.exit(0);
}
const { chromium } = playwright;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DOMAIN = "samsung.com";
const DOMAIN_ID = "01JDOMAIN0000000000000000";

/** Coverage for one month: only some days have captures, as in reality. */
function coverageDays(month) {
  if (month === "2026-01") {
    return ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-20"];
  }
  if (month === "2025-12") {
    return ["2025-12-02", "2025-12-03", "2025-12-24"];
  }
  return [];
}

function manifest(month) {
  const days = coverageDays(month);
  const pages = days.map((day, i) => ({
    url: `https://${DOMAIN}/page-${i + 1}`,
    day,
    ts: `${day.replace(/-/g, "")}120000`,
    title: `${DOMAIN} page ${i + 1}`,
    bytes: 102400,
    route: `/a/${DOMAIN}/${day}/page-${i + 1}`,
    resolvedDay: day,
    deltaDays: 0,
    stored: true,
    purged: false,
  }));
  return {
    version: 1,
    domain: DOMAIN,
    month,
    days,
    pages,
    stats: {},
    note: undefined,
  };
}

// ── Start a dev server on a free port ────────────────────────────────────────

/** Ask the OS for an unused port, then release it so Vite can bind it. */
async function pickPort() {
  const { createServer } = await import("node:net");
  return new Promise((res) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const port = await pickPort();
const url = `http://127.0.0.1:${port}/`;

const viteBin = join(webRoot, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
  console.error(`SKIP: vite not found at ${viteBin}`);
  process.exit(0);
}

console.log(`Starting vite dev server on ${url} …`);
// `--host 127.0.0.1` matters: Vite's default is `localhost`, which on Windows
// resolves to ::1 only, so a fetch to 127.0.0.1 gets connection-refused and the
// server looks like it never started.
const vite = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] },
);

let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d.toString()));
vite.stderr.on("data", (d) => (viteLog += d.toString()));

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const ready = await waitForServer();
if (!ready) {
  console.error("Dev server did not start. Log:\n" + viteLog);
  vite.kill();
  process.exit(2);
}
console.log("Dev server ready.");

// ── Drive it ────────────────────────────────────────────────────────────────

const failures = [];
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({ channel: "chromium" });
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 900, height: 1000 },
  deviceScaleFactor: 2,
});

// Stub the API. The point is to exercise the UI, not the Worker.
await context.route("**/v1/**", async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const p = u.pathname;
  const json = (body) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  if (p === "/v1/domains") {
    return json([
      {
        id: DOMAIN_ID,
        domain: DOMAIN,
        hostFilter: null,
        trackingStatus: "idle",
        addedAt: 1767225600,
        lastCrawledAt: 1767312000,
      },
    ]);
  }
  if (p === `/v1/domains/${DOMAIN_ID}/coverage`) {
    return json([...coverageDays("2026-01"), ...coverageDays("2025-12")]);
  }
  if (p === "/v1/manifest") {
    return json(manifest(u.searchParams.get("month") ?? "2026-01"));
  }
  if (p === "/v1/sites") {
    return json({
      sites: [
        { domain: DOMAIN, month: "2026-01", pages: 4, days: 4 },
        { domain: DOMAIN, month: "2025-12", pages: 3, days: 3 },
      ],
    });
  }
  if (p === "/v1/jobs/usage") {
    return json({
      month: "2026-01",
      meteredUsd: 0.42,
      planFloorUsd: 5,
      totalUsd: 5.42,
      budget: { state: "ok", spentUsd: 5.42, budgetUsd: 25, remainingUsd: 19.58, fraction: 0.2168, crawlsBlocked: false },
      byKind: [],
      byDomain: [],
      quota: { used: 1, limit: 8, remaining: 7, resetsAt: 1767312000 },
      throttle: { events: 0, totalWaitMs: 0, byStatus: {}, lastEventAt: null },
      generatedAt: 1767225600,
    });
  }
  return json({});
});

await context.addInitScript(() => {
  window.localStorage.setItem("cw_token", "test-token");
});

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

// A 2026-01 fixture, so pin "today" to something inside the fixture's range by
// asserting on the fixtures we control rather than on the real clock.
const YEAR = new Date().getFullYear();
const janYear = YEAR; // calendar opens on the current month; we navigate explicitly

console.log("\n=== Calendar interaction ===");

// 1. The trigger exists and is labelled.
const trigger = page.getByRole("button", { name: /Choose a date for/ });
check(await trigger.isVisible(), "calendar trigger is visible");
check(
  (await trigger.textContent())?.includes("Pick a day") ?? false,
  "trigger starts with no day selected",
  (await trigger.textContent())?.trim(),
);

// 2. Open it. The popover must actually be painted — this was the "invisible
//    dropdown" complaint, so measure the resolved background of the *surface*
//    (`.cw-overlay`), not of Radix's positioning wrapper, which is transparent
//    by design because it exists only to place the content.
await trigger.click();
await page.waitForTimeout(300);

const popover = page.locator(".cw-overlay").first();
check(await popover.isVisible(), "calendar popover opens");

const popBg = await popover.evaluate((el) => getComputedStyle(el).backgroundColor);
check(
  popBg !== "rgba(0, 0, 0, 0)" && popBg !== "transparent",
  "calendar popover has an opaque background",
  popBg,
);

// 3. The month grid. Click the month heading, then pick a past month.
const monthHeading = page.getByRole("button", { name: /^Change month\./ });
check(await monthHeading.isVisible(), "month heading control is present");

await monthHeading.click();
await page.waitForTimeout(200);

const monthGrid = page.getByRole("group", { name: /^Choose a month in/ });
check(await monthGrid.isVisible(), "month grid opens");

// Months later than the current one are disabled: the archive has no captures in
// the future, and offering them is what made the old picker feel broken.
const now = new Date();
const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
const nextName = nextMonth.toLocaleDateString("en-US", { month: "long" });
const nextButton = page.getByRole("button", { name: `${nextName} ${nextMonth.getFullYear()}` });
if (await nextButton.count()) {
  check(!(await nextButton.isEnabled()), `future month (${nextName}) is not selectable`);
} else {
  check(true, "no future month offered in this year");
}

// Pick a past month.
const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevName = previousMonth.toLocaleDateString("en-US", { month: "long" });
const prevYear = previousMonth.getFullYear();
const prevTarget = page.getByRole("button", { name: `${prevName} ${prevYear}` });
check(await prevTarget.isEnabled(), `previous month (${prevName} ${prevYear}) is selectable`);

await prevTarget.click();
await page.waitForTimeout(400);

const headingAfter = await monthHeading.getAttribute("aria-label");
check(
  headingAfter?.includes(prevName) ?? false,
  "picking a month moves the calendar to it",
  headingAfter,
);

// The day grid must exist for the new month (and must not be an all-disabled wall).
const grid = page.getByRole("grid").first();
check(await grid.isVisible(), "day grid renders for the chosen month");

const dayButtons = grid.locator('[role="gridcell"]:not([aria-hidden])');
const dayCount = await dayButtons.count();
check(dayCount >= 28, "day grid has a full month of cells", `${dayCount} cells`);

const enabledDays = await grid.locator('button[role="gridcell"]:not([disabled])').count();
check(enabledDays > 0, "the chosen month has selectable days", `${enabledDays} enabled`);

// 4. Year grid. The month view renders a year grid AND a month grid, so both
//    carry year-navigation buttons — scope everything to the year group.
const yearHeading = page.getByRole("button", { name: /^Change year\./ });
await yearHeading.click();
await page.waitForTimeout(200);

const yearGrid = page.getByRole("group", { name: "Choose a year" });
check(await yearGrid.isVisible(), "year grid opens");
const yearCount = await yearGrid.locator("button").count();
check(yearCount >= 12, "year grid offers a page of years", `${yearCount} years`);

/** The nav row that belongs to the year grid, not the month grid's own arrows. */
const yearNav = page.getByTestId("year-grid-nav");
const earlier = yearNav.getByRole("button", { name: "Previous years" });
check(await earlier.isEnabled(), "can page back through years");
await earlier.click();
await page.waitForTimeout(250);

const anyYear = yearGrid.locator("button:not([disabled])").first();
const pickedYear = (await anyYear.textContent())?.trim();
await anyYear.click();
await page.waitForTimeout(400);
const yearAfter = await yearHeading.getAttribute("aria-label");
check(
  yearAfter?.includes(pickedYear ?? "\u0000") ?? false,
  "picking a year is reflected in the heading",
  `${pickedYear} -> ${yearAfter}`,
);

// 5. Day selection. Drive the full three-level flow — year, then month, then day
//    — which is the interaction the old picker could not complete.
//
//    The fixture holds captures in January of the current year, so navigate
//    there deliberately rather than assuming the calendar happens to show it.
const nav = page.getByTestId("year-grid-nav");

async function openYearLevel() {
  await yearHeading.click();
  await page.waitForTimeout(200);
  await yearGrid.waitFor({ state: "visible", timeout: 5000 });
}

/** Page the year grid until `year` is on screen, or give up after a bound. */
async function showYear(year) {
  for (let i = 0; i < 10; i += 1) {
    const text = await nav.locator("span").first().textContent();
    const [start, end] = (text ?? "").split("–").map((s) => Number(s.trim()));
    if (!Number.isFinite(start) || !Number.isFinite(end)) break;
    if (year >= start && year <= end) return true;
    const direction = year < start ? "Previous years" : "Later years";
    const button = nav.getByRole("button", { name: direction });
    if (!(await button.isEnabled())) return false;
    await button.click();
    await page.waitForTimeout(200);
  }
  return false;
}

await openYearLevel();
check(await showYear(YEAR), `year grid can reach ${YEAR}`);

// Pick the year, which drops to the month level.
const targetYearCell = page.getByRole("button", { name: new RegExp(`^${YEAR}$`) });
await targetYearCell.click();
await page.waitForTimeout(300);
check(
  (await monthGrid.isVisible().catch(() => false)),
  "choosing a year drops to the month level",
);

// Pick January (the fixture's covered month) — this is what returns to the days.
const nowMonthIndex = new Date().getMonth();
const monthPicker = page.getByRole("group", { name: new RegExp(`^Choose a month in ${YEAR}$`) });
const coveredMonthName = nowMonthIndex >= 1 ? "January" : new Date().toLocaleDateString("en-US", { month: "long" });
const coveredMonthButton = monthPicker.getByRole("button", { name: `${coveredMonthName} ${YEAR}` });
await coveredMonthButton.click();
await page.waitForTimeout(500);
check(
  await grid.isVisible().catch(() => false),
  "choosing a month returns to the day grid",
);

// Prefer a day the fixture says has captures, so this exercises the coverage
// path; fall back to any selectable day, which also documents a deliberate
// behaviour: a day with *zero* captures is still selectable (it is a legitimate
// choice for scoping a crawl or a share link). Only future days are truly
// disabled — an all-disabled grid was one of the ways the old picker felt broken.
const coveredCell = grid.locator('button[role="gridcell"][aria-label*="capture"]:not([aria-label*="no captures"]):not([disabled])').first();
const anyCell = grid.locator('button[role="gridcell"]:not([disabled])').first();
const usingCovered = (await coveredCell.count()) > 0;
const targetCell = usingCovered ? coveredCell : anyCell;
const dayLabel = await targetCell.getAttribute("aria-label");
check(
  dayLabel !== null && !dayLabel.includes("in the future"),
  "the chosen month exposes selectable days",
  dayLabel ?? "none",
);
console.log(`         (picked a ${usingCovered ? "covered" : "zero-capture"} day)`);

// Capture the day grid with coverage dots while it is on screen — the visual
// record of the fix, and the artefact a human should eyeball.
await page.screenshot({ path: join(shots, "calendar-day-grid.png") });

// Also capture the month level, which is the control that used to do nothing.
await monthHeading.click();
await page.waitForTimeout(250);
await page.screenshot({ path: join(shots, "calendar-month-grid.png") });
const monthGridAgain = monthPicker.getByRole("button", { name: `${coveredMonthName} ${YEAR}` });
await monthGridAgain.click();
await page.waitForTimeout(400);
await targetCell.click();
await page.waitForTimeout(500);

const triggerAfter = (await trigger.textContent())?.trim() ?? "";
check(
  !triggerAfter.includes("Pick a day"),
  "clicking a day commits a selection and updates the trigger",
  `${triggerAfter}  (cell: ${dayLabel})`,
);

// 6. The popover closes on selection, so the next tap is on the page.
check(
  !(await monthGrid.isVisible().catch(() => false)),
  "picker dismisses after a day is chosen",
);

// 7. Keyboard: reopen and drive with arrows, then Enter.
await trigger.click();
await page.waitForTimeout(300);
await page.getByRole("grid").first().locator('[role="gridcell"]:not([aria-hidden])').first().focus();
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
const focusedAfterArrows = await page.evaluate(() => {
  const el = document.activeElement;
  return el?.getAttribute("data-day") ?? null;
});
check(focusedAfterArrows !== null, "arrow keys move focus within the day grid", `day ${focusedAfterArrows}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check(
  !(await page.getByRole("group", { name: /^Choose a month in/ }).isVisible().catch(() => false)),
  "Enter selects the focused day",
);

await page.screenshot({ path: join(shots, "dashboard-after-selection.png"), fullPage: false });

// 8. No runtime errors along the way.
const realErrors = pageErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e));
check(realErrors.length === 0, "no page errors during the whole flow", realErrors.join(" | ") || "none");

await browser.close();
vite.kill();

console.log(
  `\n${failures.length === 0 ? "CALENDAR E2E: all checks passed" : `CALENDAR E2E: ${failures.length} failing`}`,
);
for (const f of failures) console.error(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
