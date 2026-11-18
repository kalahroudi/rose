// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // `pnpm test:coverage`. Workers-runtime tests support only the istanbul provider.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // Ratchet floors (2026-11-18, measured pct - 1). Raise only; see docs/testing.md.
      thresholds: { lines: 79, statements: 76, functions: 77, branches: 64 },
    },
  },
});
