#!/usr/bin/env node
/**
 * Configure the Cloudflare billing alerts from plan.md §11.5(2).
 *
 * The alert *thresholds* are the deliverable — $10 / $50 / $200 — and they are
 * deliberately a code artifact rather than a dashboard preference, so "did we set
 * the alerts?" has an answer you can read, diff, and re-apply.
 *
 * ## The honest caveat
 *
 * Billing notifications are **not** part of the public, versioned Cloudflare API
 * surface. The endpoint below is the one the dashboard itself calls; it is
 * undocumented, may change without notice, and returns 404 on accounts where the
 * alerts feature is not enabled. This script therefore:
 *
 *   1. always supports `--dry-run`, which is the safe, always-available path;
 *   2. classifies a 404/403 as "do it in the dashboard" rather than a bug,
 *      printing exactly what to click; and
 *   3. never treats a failed API call as a reason to skip the alerts.
 *
 * The **hard spend cap is dashboard-only** and is not attempted here at all. See
 * docs/phase-4-deployment.md §6.2.
 *
 * Usage:
 *   node scripts/set-billing-alerts.mjs --dry-run
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/set-billing-alerts.mjs
 */

import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Configure Cloudflare billing alerts.

  --dry-run   print the alerts that would be created and exit

Environment:
  CLOUDFLARE_ACCOUNT_ID   account id
  CLOUDFLARE_API_TOKEN    token with billing:read / notifications edit
`);
  process.exit(0);
}

/**
 * Thresholds from plan.md §11.5(2). Three, not one, because they answer three
 * different questions: "$10 — is anything unexpected happening at all?",
 * "$50 — is this month different from last month?", "$200 — stop and look now."
 */
const ALERTS = [
  { name: "custom-wayback spend > $10", usd: 10, severity: "info" },
  { name: "custom-wayback spend > $50", usd: 50, severity: "warning" },
  { name: "custom-wayback spend > $200", usd: 200, severity: "critical" },
];

const DASHBOARD_STEPS = `
Do this in the dashboard instead — it takes two minutes and cannot 404:

  1. Cloudflare dashboard -> Manage Account -> Billing -> Notifications
  2. Create a spend notification for each of: $10, $50, $200
  3. Cloudflare dashboard -> Workers & Pages -> your Worker -> Metrics,
     and enable the usage-based billing notification for Queues and R2
     (those are the two line items that move fastest).
  4. Where the dashboard offers a HARD spend cap, set it, then verify it
     actually blocks. A cap that only warns is not a cap.
`.trim();

if (values["dry-run"]) {
  console.log("Would create these billing alerts:");
  for (const a of ALERTS) console.log(`  - ${a.name}  [${a.severity}]`);
  console.log();
  console.log(DASHBOARD_STEPS);
  process.exit(0);
}

const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
const token = process.env["CLOUDFLARE_API_TOKEN"];

if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.");
  console.error();
  console.error(DASHBOARD_STEPS);
  process.exit(2);
}

const url = `${API}/accounts/${accountId}/alerts`;

let created = 0;
let unsupported = false;

for (const alert of ALERTS) {
  const body = {
    name: alert.name,
    alert_type: "billing_usage_alert",
    enabled: true,
    conditions: { threshold_usd: alert.usd },
    mechanisms: { email: [{}] },
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`  ! ${alert.name}: request failed (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }

  if (response.ok) {
    console.log(`  + ${alert.name}`);
    created += 1;
    continue;
  }

  if (response.status === 404 || response.status === 403 || response.status === 405) {
    // Expected on accounts without the feature or without a billing-scoped
    // token. Not a failure of this script — a signal to use the dashboard.
    unsupported = true;
    console.warn(`  ! ${alert.name}: HTTP ${response.status} — alerts API unavailable on this account/token`);
    continue;
  }

  const text = await response.text();
  console.error(`  ! ${alert.name}: HTTP ${response.status} — ${text.slice(0, 200)}`);
}

console.log();
if (created === ALERTS.length) {
  console.log(`Created ${created} billing alerts.`);
  console.log("Now set the hard spend cap in the dashboard and verify it blocks:");
  console.log(DASHBOARD_STEPS);
} else {
  console.warn(`Created ${created} of ${ALERTS.length} alerts.`);
  if (unsupported) {
    console.warn("The alerts API is not available here. The thresholds are still the deliverable —");
  }
  console.warn(DASHBOARD_STEPS);
  // Exit non-zero only when something genuinely failed rather than 404'd.
  process.exit(unsupported && created === 0 ? 0 : 1);
}
