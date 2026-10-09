import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  // In production, migrations are applied via `wrangler d1 migrations apply`.
  // Locally, they run against the file DB specified in WRANGLER_D1_LOCAL_PATH.
  driver: "d1-http",
} satisfies Config;
