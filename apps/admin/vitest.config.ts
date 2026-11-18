// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { mkdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The worker config points at the built SPA; tests do not need it, but the directory must exist.
mkdirSync("dist/client", { recursive: true });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("../../packages/core/migrations"),
          ENVIRONMENT: "development",
          EMAIL_PROVIDER: "console",
          APP_BASE_DOMAIN: "rose.test",
          BOOTSTRAP_OPERATOR_EMAIL: "root@example.com",
          ROSE_MASTER_KEY: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
        },
      },
    })),
  ],
  test: {
    include: ["worker/**/*.test.ts"],
    setupFiles: ["./worker/test/setup.ts"],
    // `pnpm test:coverage`. Workers-runtime tests support only the istanbul provider.
    coverage: {
      provider: "istanbul",
      include: ["worker/**/*.ts"],
      exclude: ["worker/**/*.test.ts", "worker/test/**"],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // Ratchet floors (2026-11-18, measured pct - 1). Raise only; see docs/testing.md.
      thresholds: { lines: 65, statements: 63, functions: 76, branches: 43 },
    },
  },
});
