#!/usr/bin/env node
/**
 * Apply the plan.md §11.5(3) R2 lifecycle rules to a bucket.
 *
 * Why a script and not a dashboard step: these rules are the difference between
 * "storage grows predictably" and "the bill doubled and nobody knows why", and a
 * dashboard step is a step that gets skipped. It is idempotent — running it twice
 * leaves the same three rules.
 *
 * Usage:
 *   node scripts/set-r2-lifecycle.mjs --bucket custom-wayback --dry-run
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *     node scripts/set-r2-lifecycle.mjs --bucket custom-wayback
 *
 * The token needs R2:Edit on that account. It is read from the environment and
 * never logged, echoed, or written to disk.
 */

import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";

const { values } = parseArgs({
  options: {
    bucket: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.bucket) {
  console.log(`Apply the custom-wayback R2 lifecycle rules.

  --bucket <name>   R2 bucket to configure (required)
  --dry-run         print the rules and exit without calling the API

Environment:
  CLOUDFLARE_ACCOUNT_ID   account id (required unless --dry-run)
  CLOUDFLARE_API_TOKEN    scoped token with R2:Edit (required unless --dry-run)
`);
  process.exit(values.help ? 0 : 2);
}

/**
 * The rules, and the reasoning, in one place.
 *
 * `raw/` is the only prefix worth a lifecycle rule. It holds verbatim originals
 * kept purely so a re-rewrite (new shim, better CSP, better image handling) costs
 * zero archive.org requests. That is insurance, and insurance should get cheaper
 * with age.
 */
const RULES = [
  {
    id: "raw-to-infrequent-access",
    enabled: true,
    conditions: { prefix: "raw/" },
    action: { type: "transition", storageClass: "InfrequentAccess" },
  },
  {
    id: "raw-expire",
    enabled: true,
    conditions: { prefix: "raw/" },
    action: { type: "delete" },
  },
  {
    id: "abort-incomplete-multipart",
    enabled: true,
    conditions: { prefix: "" },
    action: { type: "abortIncompleteMultipartUpload" },
  },
];

// R2 lifecycle rules carry their own timing fields; Cloudflare's API takes them
// alongside the action. Keep them separate from the readable list above so the
// intent stays obvious.
const TIMING = {
  "raw-to-infrequent-access": { maxAge: 30 * 86_400 },
  "raw-expire": { maxAge: 180 * 86_400 },
  "abort-incomplete-multipart": { maxAge: 7 * 86_400 },
};

const payload = {
  rules: RULES.map((rule) => ({
    ...rule,
    ...TIMING[rule.id],
  })),
};

if (values["dry-run"]) {
  console.log(`Would PUT ${API}/accounts/<account>/r2/buckets/${values.bucket}/lifecycle`);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
const token = process.env["CLOUDFLARE_API_TOKEN"];

if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.");
  process.exit(2);
}

const url = `${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(values.bucket)}/lifecycle`;

let response;
try {
  response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
} catch (err) {
  console.error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const text = await response.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { raw: text.slice(0, 500) };
}

if (!response.ok || parsed.success === false) {
  // Cloudflare error objects are safe to print — they never echo the token.
  console.error(`HTTP ${response.status} from the R2 lifecycle endpoint.`);
  console.error(JSON.stringify(parsed.errors ?? parsed, null, 2));
  process.exit(1);
}

console.log(`Applied ${payload.rules.length} lifecycle rules to bucket "${values.bucket}":`);
for (const rule of payload.rules) {
  const action = rule.action.type === "transition"
    ? `transition to ${rule.action.storageClass}`
    : rule.action.type === "delete"
      ? "delete"
      : "abort incomplete multipart uploads";
  console.log(`  - ${rule.conditions.prefix || "(whole bucket)"}  ${action}  after ${rule.maxAge / 86_400} days`);
}

// Read the rules back so a silent no-op cannot look like success.
try {
  const check = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const checkBody = await check.json();
  const count = checkBody?.result?.rules?.length ?? 0;
  console.log(`Read back ${count} rule(s) from the API.`);
  if (count !== payload.rules.length) {
    console.warn("Read-back count differs from what we sent — verify in the dashboard.");
  }
} catch {
  console.warn("Could not read the rules back; verify in the dashboard.");
}
