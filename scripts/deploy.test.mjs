// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProdConfig, checkProdConfigs } from "./deploy.mjs";
import { PROD_CONFIG, ROOT, setDatabaseId, setVar } from "./lib.mjs";

const realDbId = "11111111-2222-3333-4444-555555555555";

function configuredApp() {
  let text = readFileSync(join(ROOT, "apps/app/wrangler.jsonc"), "utf8");
  text = setDatabaseId(text, realDbId);
  return setVar(text, "APP_BASE_DOMAIN", "acme.app");
}

function configuredAdmin({ adminHost = "admin.acme.app" } = {}) {
  let text = readFileSync(join(ROOT, "apps/admin/wrangler.jsonc"), "utf8");
  text = setDatabaseId(text, realDbId);
  text = setVar(text, "APP_BASE_DOMAIN", "acme.app");
  if (adminHost === null) return text.replace(/^\s*"ADMIN_HOST"\s*:.*\n/m, "");
  return setVar(text, "ADMIN_HOST", adminHost);
}

function runDeployDryRun({ appCfg, adminCfg }) {
  const dir = mkdtempSync(join(tmpdir(), "rose-deploy-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/deploy.mjs"), join(dir, "scripts/deploy.mjs"));
  copyFileSync(join(ROOT, "scripts/lib.mjs"), join(dir, "scripts/lib.mjs"));
  for (const [app, cfg] of [["app", appCfg], ["admin", adminCfg]]) {
    mkdirSync(join(dir, `apps/${app}/node_modules/.bin`), { recursive: true });
    writeFileSync(join(dir, `apps/${app}/node_modules/.bin/wrangler`), "#!/bin/sh\nexit 0\n");
    if (cfg !== undefined) writeFileSync(join(dir, `apps/${app}/${PROD_CONFIG}`), cfg);
  }
  try {
    return spawnSync(process.execPath, [join(dir, "scripts/deploy.mjs"), "--dry-run"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkProdConfig rejects missing, blank, commented or placeholder ADMIN_HOST on admin config", () => {
  const where = `apps/admin/${PROD_CONFIG}`;
  assert.match(checkProdConfig(configuredAdmin({ adminHost: null }), { where, isAdmin: true }) ?? "", /no ADMIN_HOST/);
  assert.match(checkProdConfig(configuredAdmin({ adminHost: "" }), { where, isAdmin: true }) ?? "", /no ADMIN_HOST/);
  assert.match(checkProdConfig(configuredAdmin({ adminHost: "   " }), { where, isAdmin: true }) ?? "", /no ADMIN_HOST/);
  const commented = configuredAdmin().replace(/("ADMIN_HOST"\s*:\s*"admin\.acme\.app",?)/, "// $1");
  assert.match(checkProdConfig(commented, { where, isAdmin: true }) ?? "", /no ADMIN_HOST/);
  assert.match(checkProdConfig(configuredAdmin({ adminHost: "admin.example.com" }), { where, isAdmin: true }) ?? "", /admin\.example\.com/);
  assert.match(checkProdConfig(configuredAdmin({ adminHost: "ADMIN.EXAMPLE.COM" }), { where, isAdmin: true }) ?? "", /admin\.example\.com/);
});

test("checkProdConfig accepts configured admin and app configs (app does not need ADMIN_HOST)", () => {
  assert.equal(checkProdConfig(configuredApp(), { where: `apps/app/${PROD_CONFIG}`, isAdmin: false }), null);
  assert.equal(checkProdConfig(configuredAdmin(), { where: `apps/admin/${PROD_CONFIG}`, isAdmin: true }), null);
});

test("checkProdConfigs checks both apps/app and apps/admin files on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rose-deploy-cfg-"));
  const appDir = join(dir, "apps/app");
  const adminDir = join(dir, "apps/admin");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(adminDir, { recursive: true });
  try {
    writeFileSync(join(appDir, PROD_CONFIG), configuredApp());
    assert.match(checkProdConfigs(appDir, adminDir) ?? "", /apps\/admin\/wrangler\.production\.jsonc is missing/);
    writeFileSync(join(adminDir, PROD_CONFIG), configuredAdmin({ adminHost: null }));
    assert.match(checkProdConfigs(appDir, adminDir) ?? "", /no ADMIN_HOST/);
    writeFileSync(join(adminDir, PROD_CONFIG), configuredAdmin());
    assert.equal(checkProdConfigs(appDir, adminDir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.mjs --dry-run fails when admin production config has no ADMIN_HOST or still has admin.example.com", () => {
  const missing = runDeployDryRun({ appCfg: configuredApp(), adminCfg: configuredAdmin({ adminHost: null }) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ADMIN_HOST/);
  assert.match(missing.stderr, /pnpm setup --production/);

  const placeholder = runDeployDryRun({ appCfg: configuredApp(), adminCfg: configuredAdmin({ adminHost: "admin.example.com" }) });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /admin\.example\.com/);
  assert.match(placeholder.stderr, /pnpm setup --production/);

  const valid = runDeployDryRun({ appCfg: configuredApp(), adminCfg: configuredAdmin() });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Dry run complete/);
});
