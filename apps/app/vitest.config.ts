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
          ENVIRONMENT: "test",
          APP_BASE_DOMAIN: "rose.test",
          ROSE_MASTER_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        },
      },
    })),
  ],
  test: { include: ["worker/**/*.test.ts"], setupFiles: ["./worker/test/setup.ts"] },
});
