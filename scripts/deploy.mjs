#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm deploy` — verify, build, migrate, deploy both workers. Refuses to ship unverified code.
//   --skip-verify is intentionally not offered. --dry-run prints the steps.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ADMIN_DIR, APP_DIR, DB_NAME, PLACEHOLDER_DB_ID, PROD_CONFIG, bin, c, fail, info, ok, parseArgs, readText, run } from "./lib.mjs";

const stripComments = (text) => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");

/** Validate one production wrangler config; returns an error message or null. */
export function checkProdConfig(cfg, { where, isAdmin }) {
  const code = stripComments(cfg);
  if (code.includes(PLACEHOLDER_DB_ID)) return `${where} still has the placeholder database id. Run \`pnpm setup --production\` first.`;
  if (/"APP_BASE_DOMAIN"\s*:\s*"example\.com"/.test(code)) return "APP_BASE_DOMAIN is still example.com. Run `pnpm setup --production` first.";
  if (isAdmin) {
    const adminHost = /"ADMIN_HOST"\s*:\s*"([^"]*)"/.exec(code)?.[1]?.trim().toLowerCase() ?? "";
    if (!adminHost) return `${where} has no ADMIN_HOST. Run \`pnpm setup --production\` first.`;
    if (adminHost === "admin.example.com") return `${where} still has ADMIN_HOST set to admin.example.com. Run \`pnpm setup --production\` first.`;
  }
  return null;
}

export function checkProdConfigs(appDir = APP_DIR, adminDir = ADMIN_DIR) {
  for (const [dir, isAdmin] of [[appDir, false], [adminDir, true]]) {
    const where = `${dir.replace(/^.*\/apps\//, "apps/")}/${PROD_CONFIG}`;
    const path = join(dir, PROD_CONFIG);
    if (!existsSync(path)) return `${where} is missing. Run \`pnpm setup --production\` first.`;
    const err = checkProdConfig(readText(path), { where, isAdmin });
    if (err) return err;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dry = !!parseArgs()["dry-run"];
  const err = checkProdConfigs();
  if (err) fail(err);

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
}
