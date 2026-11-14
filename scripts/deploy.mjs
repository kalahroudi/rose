#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm deploy` — verify, build, migrate, deploy both workers. Refuses to ship unverified code.
//   --skip-verify is intentionally not offered. --dry-run prints the steps.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_DIR, APP_DIR, DB_NAME, PLACEHOLDER_DB_ID, PROD_CONFIG, bin, c, fail, info, ok, parseArgs, readText, run } from "./lib.mjs";

const dry = !!parseArgs()["dry-run"];
for (const dir of [APP_DIR, ADMIN_DIR]) {
  const where = `${dir.replace(/^.*\/apps\//, "apps/")}/${PROD_CONFIG}`;
  if (!existsSync(join(dir, PROD_CONFIG))) fail(`${where} is missing. Run \`pnpm setup --production\` first.`);
  const cfg = readText(join(dir, PROD_CONFIG));
  if (cfg.includes(PLACEHOLDER_DB_ID)) fail(`${where} still has the placeholder database id. Run \`pnpm setup --production\` first.`);
  if (/"APP_BASE_DOMAIN"\s*:\s*"example\.com"/.test(cfg)) fail("APP_BASE_DOMAIN is still example.com. Run `pnpm setup --production` first.");
}

const steps = [
  ["Guard, typecheck and tests (pnpm verify)", "pnpm", ["verify"], undefined],
  ["Build", "pnpm", ["--filter", "@rose/app", "--filter", "@rose/admin", "build"], undefined],
  ["Database migrations", bin(APP_DIR, "wrangler"), ["d1", "migrations", "apply", DB_NAME, "--remote", "-c", PROD_CONFIG], APP_DIR],
  ["Deploy tenant app", bin(APP_DIR, "wrangler"), ["deploy", "-c", PROD_CONFIG], APP_DIR],
  ["Deploy operator console", bin(ADMIN_DIR, "wrangler"), ["deploy", "-c", PROD_CONFIG], ADMIN_DIR],
];
for (const [label, cmd, args, cwd] of steps) {
  info(`${label}${dry ? c.dim("  [dry-run]") : ""}`);
  if (dry) continue;
  const r = run(cmd, args, { cwd, env: { CI: "1" } });
  if (r.status !== 0) fail(`${label} failed. Nothing further was deployed.`);
}
ok(dry ? "Dry run complete" : "Deployed");
