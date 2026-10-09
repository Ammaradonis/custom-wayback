#!/usr/bin/env node
/**
 * Test runner for the API Worker.
 *
 * ## Why this exists
 *
 * The API's source uses `.js` import specifiers (correct for the bundler and for
 * `tsc`), and imports the workspace packages by name. Node alone cannot resolve
 * either: `./fetch.js` has no sibling `fetch.js` on disk, and
 * `@custom-wayback/shared` points at a built `dist/` that a test should not have
 * to pre-build. So the tests would only ever run against a deployed Worker.
 *
 * The fix is to let the *bundler that actually ships the Worker* do the
 * resolving. esbuild is already in the tree (Wrangler uses it) and resolves
 * `.js` → `.ts`, `exports` maps and workspace links exactly as `wrangler deploy`
 * does. Each test file is bundled to a temporary ESM file and then handed to
 * `node --test`.
 *
 * The consequence worth stating plainly: the tests execute the same module graph
 * the Worker deploys, not a re-implementation of it.
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const apiRoot = resolve(here, "..");
const testDir = join(apiRoot, "test");

const entries = (await readdir(testDir))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(testDir, f))
  .sort();

if (entries.length === 0) {
  console.error("No *.test.ts files found in test/.");
  process.exit(2);
}

const outDir = await mkdtemp(join(tmpdir(), "cw-api-test-"));
let exitCode = 0;

try {
  await build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    // Test-only: lets the bundle run under Node without Workers-only globals.
    define: { "import.meta.env": "undefined" },
    logLevel: "warning",
    // `linkedom/worker` has no Node-specific code; `node:*` builtins used by the
    // shared packages stay external, which is what Node wants anyway.
    external: ["node:*"],
    banner: {
      js: [
        "// Bundled from apps/api/src by scripts/run-api-tests.mjs.",
        "// Generated file — edit the TypeScript sources, not this output.",
      ].join("\n"),
    },
  });

  const bundled = (await readdir(outDir)).filter((f) => f.endsWith(".js")).map((f) => join(outDir, f));

  console.log(`Running ${bundled.length} test file(s) from apps/api/test:`);
  for (const file of bundled) console.log(`  • ${file.replace(outDir, "").replace(/^[\\/]/, "")}`);
  console.log("");

  exitCode = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--test", ...bundled], {
      stdio: "inherit",
      cwd: apiRoot,
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      console.error(`Failed to start the test runner: ${err.message}`);
      resolvePromise(1);
    });
  });
} finally {
  await rm(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
