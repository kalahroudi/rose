// SPDX-License-Identifier: Apache-2.0
// Proves every guard rule fires on a bad example, stays quiet on the good one, and that
// the repository itself is clean. Run: pnpm test:scripts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { RULES, checkFile, checkStructure, scan } from "./guard.mjs";

const H = "// SPDX-License-Identifier: Apache-2.0\n";
const rules = (file, body) => checkFile(file, H + body).violations.map((v) => v.rule);
const MOD = "apps/app/worker/modules/orders/index.ts";
const WEB = "apps/app/web/pages/Orders.tsx";

function fires(rule, file, bad, good) {
  test(`${rule}: fires`, () => assert.ok(rules(file, bad).includes(rule), `expected ${rule} for: ${bad}`));
  if (good !== undefined) test(`${rule}: quiet on the correct form`, () => assert.ok(!rules(file, good).includes(rule), `unexpected ${rule} for: ${good}\n${JSON.stringify(checkFile(file, H + good).violations)}`));
}

test("every rule documents why and how to fix", () => {
  for (const [id, r] of Object.entries(RULES)) assert.ok(r.why.length > 20 && r.fix.length > 10, id);
});

test("spdx: header satisfies", () => assert.deepEqual(rules("apps/app/web/x.ts", "export {};"), []));
test("spdx: missing header", () => assert.deepEqual(checkFile("apps/app/web/x.ts", "export {};").violations.map((v) => v.rule), ["spdx"]));
test("spdx: sql and css comment styles", () => {
  assert.deepEqual(checkFile("packages/core/migrations/0002_x.sql", "-- SPDX-License-Identifier: Apache-2.0\nSELECT 1;").violations, []);
  assert.deepEqual(checkFile("packages/ui/src/a.css", "/* SPDX-License-Identifier: Apache-2.0 */\n:root{}").violations, []);
});

fires("raw-sql", "apps/admin/worker/index.ts", 'const r = await c.env.DB.prepare("SELECT 1").first();', "const r = await listTenants(c.env.DB, q);");
test("raw-sql: allowed in core and tests, ignored in comments", () => {
  assert.ok(!rules("packages/core/src/control/x.ts", 'db.prepare("SELECT 1")').includes("raw-sql"));
  assert.ok(!rules("apps/admin/worker/test/a.test.ts", 'env.DB.prepare("SELECT 1")').includes("raw-sql"));
  assert.ok(!rules("apps/admin/worker/index.ts", '// never call .prepare( here').includes("raw-sql"));
});

fires("module-env", MOD, "const db = c.env.DB;", 'const rows = await ctx.db.all("SELECT id FROM orders LIMIT 10");');
fires("module-env", MOD, "handler: async (ctx, env) => env.SECRET", undefined);
fires("module-env", MOD, 'import { env } from "cloudflare:workers";', undefined);
fires("module-env", MOD, 'await fetch("https://hooks.example.com", { method: "POST" });', undefined);
fires("module-env", MOD, "const k = process.env.KEY;", undefined);
test("module-env: module tests may use the test env", () => assert.ok(!rules("apps/app/worker/modules/orders/orders.test.ts", "await createTestTenant(env, SELF); env.DB;").includes("module-env")));

fires("tenant-binding", "apps/app/worker/routes.ts", "const stub = e.TENANT_DO.get(e.TENANT_DO.idFromName(other));", undefined);
fires("tenant-binding", "apps/admin/worker/index.ts", "this.ctx.storage.sql.exec(q)", undefined);
fires("cf-workers-import", "apps/admin/worker/index.ts", 'import { env } from "cloudflare:workers";', 'import { notFound } from "@rose/core";');
test("cf-workers-import: allowed where the Durable Object class is declared", () => {
  assert.ok(!rules("apps/app/worker/index.ts", 'import { DurableObject } from "cloudflare:workers";').includes("cf-workers-import"));
  assert.ok(!rules("packages/core/src/tenancy/tenant-do.ts", 'import { DurableObject } from "cloudflare:workers";').includes("cf-workers-import"));
});

fires("platform-import", MOD, 'import { listTenants } from "@rose/core/platform";', 'import { defineModule } from "@rose/core";');
fires("platform-import", "apps/app/worker/index.ts", 'import { readSession } from "../../../packages/core/src/control/sessions";', undefined);
fires("platform-import", "packages/ui/src/api.ts", 'import type { X } from "@rose/core/src/env";', undefined);
fires("platform-import", "apps/admin/web/pages/T.tsx", 'import { listTenants } from "@rose/core/platform";', undefined);
test("platform-import: the admin worker may use the operator API; admin tests may deep-import", () => {
  assert.ok(!rules("apps/admin/worker/index.ts", 'import { listTenants } from "@rose/core/platform";').includes("platform-import"));
  assert.ok(!rules("apps/admin/worker/test/admin.test.ts", 'await import("../../../../packages/core/src/control/sessions");').includes("platform-import"));
});

fires("sql-interpolation", MOD, "await ctx.db.all(`SELECT * FROM orders WHERE name = '${name}' LIMIT 5`);", 'await ctx.db.all("SELECT * FROM orders WHERE name = ? LIMIT 5", [name]);');
fires("sql-interpolation", MOD, "await ctx.db.all(`SELECT * FROM orders ORDER BY ${ctx.req.query('sort')} LIMIT 5`);", "await ctx.db.all(`SELECT * FROM orders ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...w.args, 1, 2]);");
fires("sql-interpolation", MOD, 'await ctx.db.run("DELETE FROM orders WHERE id = " + id);', undefined);
fires("sql-interpolation", MOD, "const sql = `UPDATE orders SET ${field} = ? WHERE id = ?`;", 'const w = { sql: `WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids };');
test("sql-interpolation: constant fragment joins and non-SQL templates are fine", () => {
  assert.ok(!rules(MOD, 'return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };').includes("sql-interpolation"));
  assert.ok(!rules(MOD, "await ctx.audit(`bulk.${body.action}`, null); const p = `/${String(created.id)}`; const t = `Delete workspace ${t.slug}`;").includes("sql-interpolation"));
});

fires("list-limit", MOD, 'const rows = await ctx.db.all<{ id: string }>("SELECT * FROM orders ORDER BY created_at");', 'const rows = await ctx.db.all<{ id: string }>("SELECT * FROM orders ORDER BY created_at LIMIT 50");');
fires("list-limit", MOD, "await ctx.db.batch([{ sql: `SELECT * FROM orders ${w.sql}`, params: w.args }]);", "await ctx.db.batch([{ sql: `SELECT * FROM orders ${w.sql} LIMIT ? OFFSET ?`, params: w.args }, { sql: `SELECT COUNT(*) AS n FROM orders ${w.sql}`, params: w.args }]);");
fires("list-limit", MOD, 'await ctx.db.all("SELECT * FROM orders LIMIT 5000");', 'await ctx.db.all("SELECT status, COUNT(*) AS n FROM orders GROUP BY status");');
test("list-limit: single-row reads are not lists", () => assert.ok(!rules(MOD, 'await ctx.db.first("SELECT * FROM orders WHERE id = ?", [id]);').includes("list-limit")));

fires("forbidden-api", WEB, "<div dangerouslySetInnerHTML={{ __html: x }} />", "<div>{x}</div>");
fires("forbidden-api", WEB, "el.innerHTML = value;", "el.textContent = value;");
fires("forbidden-api", "apps/app/worker/x.ts", "const r = eval(code);", "const r = JSON.parse(text);");
fires("forbidden-api", WEB, 'const f = new Function("return 1");', undefined);
fires("forbidden-api", WEB, 'document.write("<p>x</p>");', undefined);

fires("insecure-random", "apps/app/worker/modules/orders/index.ts", "const id = Math.random().toString(36);", 'const id = newId("or");');
test("insecure-random: fine in tests and in UI code", () => {
  assert.ok(!rules("packages/core/test/a.test.ts", "Math.random()").includes("insecure-random"));
  assert.ok(!rules(WEB, "const jitter = Math.random();").includes("insecure-random"));
});

fires("log-sensitive", "apps/admin/worker/index.ts", "console.log('issued', token);", "console.log('issued session', session.publicId);");
fires("log-sensitive", "packages/core/src/x.ts", "console.info(`code ${code}`);", 'console.error(JSON.stringify({ level: "error", at: "requestCode", error: String(err) }));');
test("log-sensitive: the dev mailbox is the one allowed place", () => assert.ok(!rules("packages/core/src/email.ts", "console.log(mail.text, code);").includes("log-sensitive")));

fires("storage-sensitive", WEB, 'localStorage.setItem("rose.session_token", t);', 'localStorage.setItem("rose.theme", "dark");');
fires("storage-sensitive", "packages/ui/src/api.ts", 'const t = sessionStorage.getItem("apiKey");', undefined);
fires("storage-sensitive", WEB, "const c = document.cookie;", undefined);

fires("ui-external-fetch", WEB, 'const r = await fetch("https://api.github.com/repos/x/y");', 'const r = await api("/api/setup");');
fires("ui-external-fetch", "packages/ui/src/api.ts", "new WebSocket(`wss://example.com/x`);", "await fetch(path, init);");
test("ui-external-fetch: workers may call third parties", () => assert.ok(!rules("apps/admin/worker/index.ts", 'await fetch("https://api.github.com/x");').includes("ui-external-fetch")));

fires("target-blank", WEB, '<a href={url} target="_blank">Docs</a>', '<a href={url} target="_blank" rel="noopener noreferrer">Docs</a>');
test("target-blank: rel on a neighbouring line of the same element is accepted", () => {
  assert.ok(!rules(WEB, '<a\n  href={url}\n  target="_blank"\n  rel="noopener noreferrer"\n>Docs</a>').includes("target-blank"));
});

test("admin-isolation: operator worker must not bind tenant storage", () => {
  const bad = '{ "name": "rose-admin", "durable_objects": { "bindings": [{ "name": "TENANT_DO", "class_name": "TenantDO" }] } }';
  assert.ok(checkFile("apps/admin/wrangler.jsonc", bad).violations.some((v) => v.rule === "admin-isolation"));
  assert.deepEqual(checkFile("apps/admin/wrangler.jsonc", '{\n  // no tenant database binding, no TENANT_DO\n  "name": "rose-admin"\n}').violations, []);
  assert.deepEqual(checkFile("apps/app/wrangler.jsonc", bad).violations, []);
});

test("deployment-values: wrangler.jsonc may hold placeholders only", () => {
  const ok = '{\n  "routes": [{ "pattern": "*.example.com/*", "zone_name": "example.com" }],\n  "vars": { "BOOTSTRAP_OPERATOR_EMAIL": "admin@example.com", "EMAIL_FROM": "Rose <no-reply@update.example.com>" },\n  "d1_databases": [{ "database_id": "00000000-0000-0000-0000-000000000000" }]\n}';
  assert.deepEqual(checkFile("apps/admin/wrangler.jsonc", ok).violations, []);
  for (const bad of ['"database_id": "11111111-2222-4333-8444-555555555555"', '"BOOTSTRAP_OPERATOR_EMAIL": "ops@acme.io"', '"APP_BASE_DOMAIN": "acme.io"', '"routes": [{ "pattern": "acme.io/*", "zone_name": "acme.io" }]']) {
    assert.ok(checkFile("apps/app/wrangler.jsonc", `{\n  ${bad}\n}`).violations.some((v) => v.rule === "deployment-values"), bad);
  }
  assert.deepEqual(checkFile("apps/app/wrangler.production.jsonc", '{\n  "database_id": "11111111-2222-4333-8444-555555555555"\n}').violations, []);
});

test("csp: script-src must stay strict", () => {
  const ok = "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none'\n";
  assert.deepEqual(checkFile("apps/app/public/_headers", ok).violations, []);
  for (const bad of [ok.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), ok.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), ok.replace("script-src 'self'", "script-src 'self' https://cdn.example.com"), ok.replace("script-src 'self'; ", ""), ok.replace("frame-ancestors 'none'", "frame-ancestors *"), "/*\n  X-Frame-Options: DENY\n"]) {
    assert.ok(checkFile("apps/app/public/_headers", bad).violations.some((v) => v.rule === "csp"), bad);
  }
});

test("secret-in-repo: keys, tokens and private keys", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  assert.ok(checkFile("docs/x.md", `ROSE_MASTER_KEY=${key}`).violations.some((v) => v.rule === "secret-in-repo"));
  assert.ok(checkFile("apps/app/wrangler.jsonc", `"RESEND_API_KEY": "re_${"a1B2".repeat(8)}"`).violations.some((v) => v.rule === "secret-in-repo"));
  assert.ok(checkFile("docs/x.md", "-----BEGIN PRIVATE KEY-----").violations.some((v) => v.rule === "secret-in-repo"));
  assert.ok(checkFile("x.env.example", `UPSTREAM_SIGNING_SECRET=${"ab".repeat(32)}`).violations.some((v) => v.rule === "secret-in-repo"));
  // Public test fixtures are allowlisted by exact value.
  assert.deepEqual(checkFile("packages/core/wrangler.test.jsonc", '"ROSE_MASTER_KEY": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="').violations, []);
  assert.deepEqual(checkFile("docs/x.md", "ROSE_MASTER_KEY=<base64 of 32 random bytes>").violations, []);
});

test("guard-allow: an exception needs the right rule id and a reason, and is reported", () => {
  const body = '// guard-allow: module-env fixed webhook destination reviewed by security\nawait fetch("https://hooks.example.com");';
  const r = checkFile(MOD, H + body);
  assert.deepEqual(r.violations, []);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0].reason, /reviewed by security/);
  assert.ok(checkFile(MOD, H + '// guard-allow: raw-sql wrong rule\nawait fetch("https://x.example");').violations.length === 1);
  assert.ok(checkFile(MOD, H + '// guard-allow: module-env\nawait fetch("https://x.example");').violations.length === 1, "a reason is mandatory");
});

test("scan: comments are blanked, strings and template expressions are captured", () => {
  const s = scan('const a = "x // not a comment"; // real\n/* block\n */ const q = `A ${b.c} B ${d(`n ${e}`)} C`; const re = /"[^"]*"/g; const z = "after";');
  assert.ok(!s.code.includes("real") && !s.code.includes("block"));
  assert.ok(s.code.includes("x // not a comment"));
  const tpl = s.literals.find((l) => l.kind === "template");
  assert.deepEqual(tpl.exprs, ["b.c", "d(`n ${e}`)"]);
  assert.equal(tpl.line, 3);
  assert.ok(s.literals.some((l) => l.text === "after"), "regex literal with quotes does not derail the scanner");
});

test("module-structure: unregistered, probe-less and untested modules are rejected", () => {
  const files = ["apps/app/worker/test/isolation.test.ts", "apps/app/worker/modules/index.ts", "apps/app/worker/modules/good/index.ts", "apps/app/worker/modules/good/good.test.ts", "apps/app/worker/modules/bad/index.ts"];
  const content = {
    "apps/app/worker/test/isolation.test.ts": "describeTenantIsolation(env, SELF, modules);",
    "apps/app/worker/modules/index.ts": 'import { good } from "./good";\nexport const modules = [good];',
    "apps/app/worker/modules/good/index.ts": "export const good = defineModule({ id: 'good', isolationProbe: {} });",
    "apps/app/worker/modules/bad/index.ts": "export const bad = { id: 'bad' };",
  };
  const msgs = checkStructure(files, (f) => content[f]).map((v) => `${v.file}: ${v.message}`);
  assert.equal(msgs.filter((m) => m.includes("/good/")).length, 0);
  assert.equal(msgs.filter((m) => m.includes("/bad/")).length, 4, msgs.join("\n"));
  const weakened = { ...content, "apps/app/worker/test/isolation.test.ts": "describe.skip('x', () => describeTenantIsolation(env, SELF, [modules[0]]));" };
  assert.equal(checkStructure(files, (f) => weakened[f]).filter((v) => v.file.endsWith("isolation.test.ts")).length, 2);
  assert.ok(checkStructure(files.slice(1), (f) => content[f]).some((v) => v.message.includes("missing")));
});

test("the repository itself passes the guard", () => {
  const out = spawnSync(process.execPath, ["scripts/guard.mjs", "--json"], { encoding: "utf8" }).stdout;
  const result = JSON.parse(out);
  assert.deepEqual(result.violations, [], result.violations.map((v) => `${v.rule} ${v.file}:${v.line} ${v.message}`).join("\n"));
  void execFileSync;
});
