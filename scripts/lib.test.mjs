// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT, diagnoseOperatorSignIn, parseArgs, setDatabaseId, setRoutes, setVar } from "./lib.mjs";

/** Strip // comments (outside strings) and parse. */
const parseJsonc = (t) => JSON.parse(t.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) => str ?? ""));

for (const app of ["app", "admin"]) {
  test(`wrangler.jsonc edits keep apps/${app} config valid and commented`, () => {
    const before = readFileSync(join(ROOT, `apps/${app}/wrangler.jsonc`), "utf8");
    let t = setDatabaseId(before, "11111111-2222-3333-4444-555555555555");
    t = setVar(t, "APP_BASE_DOMAIN", "acme.app");
    t = setVar(t, "EMAIL_FROM", 'Acme "Team" <login@acme.app>');
    t = setRoutes(t, [{ pattern: "acme.app/*", zone_name: "acme.app" }, { pattern: "*.acme.app/*", zone_name: "acme.app" }]);
    const again = setRoutes(setVar(t, "EMAIL_FROM", "x@y.z"), [{ pattern: "b.app/*", zone_name: "b.app" }]);
    const cfg = parseJsonc(t);
    assert.equal(cfg.d1_databases[0].database_id, "11111111-2222-3333-4444-555555555555");
    assert.equal(cfg.vars.APP_BASE_DOMAIN, "acme.app");
    assert.equal(cfg.vars.EMAIL_FROM, 'Acme "Team" <login@acme.app>');
    assert.equal(cfg.routes.length, 2);
    assert.equal(cfg.routes[1].pattern, "*.acme.app/*");
    assert.ok(t.includes("//"), "comments survive");
    const cfg2 = parseJsonc(again);
    assert.equal(cfg2.routes.length, 1, "re-running replaces routes instead of duplicating");
    assert.equal(cfg2.vars.EMAIL_FROM, "x@y.z");
    assert.equal(Object.keys(cfg2.vars).filter((k) => k === "EMAIL_FROM").length, 1);
  });
}

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--a", "1", "--b=2", "--c", "x", "--d"]), { _: [], a: "1", b: "2", c: "x", d: true });
});

test("diagnoseOperatorSignIn names the cause of a refused operator code", async () => {
  const { diagnoseOperatorSignIn } = await import("./lib.mjs");
  const e = "op@example.com";
  assert.match(diagnoseOperatorSignIn(e, { userExists: false, isOperator: false, passkeys: 0 }), /not an operator.*--operator-email/);
  assert.match(diagnoseOperatorSignIn(e, { userExists: true, isOperator: false, passkeys: 0 }), /not an operator/);
  assert.match(diagnoseOperatorSignIn(e, { userExists: true, isOperator: true, passkeys: 2 }), /console passkey/);
  assert.equal(diagnoseOperatorSignIn(e, { userExists: true, isOperator: true, passkeys: 0 }), null);
});

test("diagnoseOperatorSignIn: zero operators points at the bootstrap address, not a non-existent operator", () => {
  const m = diagnoseOperatorSignIn("x@example.com", { userExists: false, isOperator: false, passkeys: 0, noOperators: true });
  assert.match(m, /no operators yet/);
  assert.match(m, /BOOTSTRAP_OPERATOR_EMAIL/);
  assert.doesNotMatch(m, /an operator's address/);
});

test("diagnoseOperatorSignIn: zero operators with a passkey on the address names the passkey and the empty-value case", () => {
  const withKey = diagnoseOperatorSignIn("x@example.com", { userExists: true, isOperator: false, passkeys: 1, noOperators: true });
  assert.match(withKey, /no operators yet/);
  assert.match(withKey, /console passkey/);
  const plain = diagnoseOperatorSignIn("x@example.com", { userExists: false, isOperator: false, passkeys: 0, noOperators: true });
  assert.match(plain, /not empty/);
});

async function devVarsIn(files) {
  const dir = mkdtempSync(join(tmpdir(), "rose-devvars-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/lib.mjs"), join(dir, "scripts/lib.mjs"));
  for (const app of ["app", "admin"]) {
    mkdirSync(join(dir, `apps/${app}`), { recursive: true });
    if (files[app] !== undefined) writeFileSync(join(dir, `apps/${app}/.dev.vars`), files[app]);
  }
  const lib = await import(pathToFileURL(join(dir, "scripts/lib.mjs")).href);
  const result = lib.ensureDevVars();
  const read = (app) => Object.fromEntries(readFileSync(join(dir, `apps/${app}/.dev.vars`), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const out = { result, app: read("app"), admin: read("admin") };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("ensureDevVars: a fresh checkout gets the rose.localhost base domain", async () => {
  const { result, app, admin } = await devVarsIn({});
  assert.equal(result.created, true);
  assert.equal(result.migratedBaseDomain, false);
  assert.equal(app.APP_BASE_DOMAIN, "rose.localhost");
  assert.equal(admin.APP_BASE_DOMAIN, "rose.localhost");
  assert.equal(admin.APP_URL_TEMPLATE, "http://{host}:5174");
});

test("ensureDevVars: the old localhost base domain moves to rose.localhost and keeps the keys", async () => {
  const { result, app, admin } = await devVarsIn({
    app: "ENVIRONMENT=development\nAPP_BASE_DOMAIN=localhost\nROSE_MASTER_KEY=appkey\n",
    admin: "ENVIRONMENT=development\nAPP_BASE_DOMAIN=localhost\nROSE_MASTER_KEY=adminkey\n",
  });
  assert.equal(result.migratedBaseDomain, true);
  assert.equal(app.APP_BASE_DOMAIN, "rose.localhost");
  assert.equal(admin.APP_BASE_DOMAIN, "rose.localhost");
  assert.equal(app.ROSE_MASTER_KEY, "appkey");
  assert.equal(admin.ROSE_MASTER_KEY, "adminkey");
});

test("ensureDevVars: a base domain the developer chose is kept", async () => {
  const { result, app, admin } = await devVarsIn({ app: "APP_BASE_DOMAIN=acme.localhost\n", admin: "APP_BASE_DOMAIN=acme.localhost\n" });
  assert.equal(result.migratedBaseDomain, false);
  assert.equal(app.APP_BASE_DOMAIN, "acme.localhost");
  assert.equal(admin.APP_BASE_DOMAIN, "acme.localhost");
});
