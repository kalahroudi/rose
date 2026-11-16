// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for L13: post-auth registrations outside /api and /svc must be on OUTSIDE_SCOPE_ROUTES.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_ROUTES, scan } from "./route-authz-scan.mjs";

const AUTH_LINE = 'app.use("/api/*", authenticate);\n';
const NEED = "const need = (c, permission) => { const a = c.get(\"actor\"); if (!can(a.role, permission)) throw forbidden(); return a; };\n";
const wrap = (body, pre = "") => `function f() {\nconst app = new Hono();\n${pre}${AUTH_LINE}${NEED}${body}\nreturn app;\n}`;
const GOOD = 'app.get("/api/ok", async (c) => { need(c, "x:read"); return c.json({}); });\n';
const H = "async (c) => c.json({ secret: 1 })";
const keys = (r) => r.ungated.map((u) => u.key);
const REAL = () => readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");

test("every outside-scope allow-list entry has a non-trivial reason", () => {
  for (const [k, v] of Object.entries(OUTSIDE_SCOPE_ROUTES)) {
    assert.match(k, /^[A-Z|]+ \/\S*$/, `key format of ${k}`);
    assert.equal(typeof v, "string");
    assert.ok(v.trim().length >= 20, `reason for ${k} is too short`);
  }
});

test("/__dev/tick is on the allow-list and the real tenant-app passes with no stale outside entries", () => {
  assert.ok(Object.hasOwn(OUTSIDE_SCOPE_ROUTES, "POST /__dev/tick"));
  const r = scan(REAL(), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES);
  assert.deepEqual([r.unparsed, r.ungated, r.stale, r.stalePublic, r.staleOutside], [[], [], [], [], []]);
});

test("injecting an unlisted outside route into the real tenant-app is reported", () => {
  const src = REAL().replace('app.post("/__dev/tick"', 'app.get("/evil", async (c) => c.json({}));\n  app.post("/__dev/tick"');
  assert.notEqual(src, REAL());
  const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES);
  assert.deepEqual(keys(r), ["GET /evil"]);
});

test("removing /__dev/tick from the real tenant-app makes its entry stale", () => {
  const src = REAL().replace('app.post("/__dev/tick"', 'app.post("/api/__dev/tick_gone"');
  const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES);
  assert.deepEqual(r.staleOutside, ["POST /__dev/tick"]);
});

test("method matters: an allow-listed POST does not cover GET or ALL on the same path", () => {
  const list = { "POST /__dev/tick": "dev only reason here" };
  for (const m of ["get", "all", "put", "delete"]) {
    const r = scan(wrap(`app.${m}("/__dev/tick", ${H});`), {}, {}, list);
    assert.deepEqual(keys(r), [`${m.toUpperCase()} /__dev/tick`], m);
    assert.deepEqual(r.staleOutside, ["POST /__dev/tick"], m);
  }
});

test("path matters exactly: trailing slash, sub-path and case variants are not covered", () => {
  const list = { "GET /evil": "reason reason reason" };
  for (const p of ["/evil/", "/evil/x", "/Evil", "/evil/*"]) {
    const r = scan(wrap(`app.get("${p}", ${H});`), {}, {}, list);
    assert.deepEqual(keys(r), [`GET ${p}`], p);
  }
});

test("outside-scope middleware, mounts and app.on are reported when unlisted", () => {
  const cases = [
    [`app.use("/evil/*", async (c, next) => { await next(); });`, "USE /evil/*"],
    ["app.route(\"/evil\", sub);", "ROUTE /evil"],
    [`app.on("GET", "/evil", ${H});`, "GET /evil"],
    [`app.on(["GET", "POST"], "/evil", ${H});`, "GET|POST /evil"],
  ];
  for (const [body, key] of cases) {
    const r = scan(wrap(body), {}, {}, {});
    assert.ok(keys(r).includes(key), `${body} -> ${JSON.stringify(keys(r))} ${JSON.stringify(r.unparsed)}`);
  }
});

test("an outside-scope route chained onto the authentication line is reported", () => {
  const src = `function f() {\nconst app = new Hono();\napp.use("/api/*", authenticate).get("/evil", ${H});\n${NEED}${GOOD}\nreturn app;\n}`;
  const r = scan(src, {}, {}, {});
  assert.ok(keys(r).includes("GET /evil") || r.unparsed.length > 0, JSON.stringify(r));
});

test("an outside-scope route chained onto a gated /api route is reported", () => {
  const r = scan(wrap(`app.get("/api/ok", async (c) => { need(c, "x:read"); return c.json({}); }).get("/evil", ${H});`), {}, {}, {});
  assert.deepEqual(keys(r), ["GET /evil"]);
});

test("an outside-scope route registered inside a nested block after auth is reported", () => {
  const r = scan(wrap(`if (true) { app.get("/evil", ${H}); }`), {}, {}, {});
  assert.ok(keys(r).includes("GET /evil") || r.unparsed.length > 0, JSON.stringify(r));
});

test("allow-listing an outside path does not let a pre-auth registration of it pass", () => {
  const r = scan(wrap(GOOD, `app.get("/evil", ${H});\n`), {}, {}, { "GET /evil": "reason reason reason" });
  assert.ok(keys(r).includes("GET /evil"), JSON.stringify(r.ungated));
  assert.deepEqual(r.staleOutside, ["GET /evil"]);
});

test("a listed key does not cover /api routes: an /api route still needs need()", () => {
  const r = scan(wrap(`app.get("/api/x", ${H});`), {}, {}, { "GET /api/x": "reason reason reason" });
  assert.deepEqual(keys(r), ["GET /api/x"]);
  assert.deepEqual(r.staleOutside, ["GET /api/x"]);
});

test("prototype names cannot be used to bypass the allow-list", () => {
  for (const p of ["/__proto__", "/constructor", "/toString", "/hasOwnProperty"]) {
    const r = scan(wrap(`app.get("${p}", ${H});`), {}, {}, {});
    assert.deepEqual(keys(r), [`GET ${p}`], p);
  }
});

test("duplicate allow-listed registration is reported once even across different spellings of method", () => {
  const r = scan(wrap(`app.post("/__dev/tick", ${H});\napp.on("POST", "/__dev/tick", ${H});`), {}, {}, { "POST /__dev/tick": "reason reason reason" });
  assert.deepEqual(keys(r), ["POST /__dev/tick"]);
  assert.deepEqual(r.staleOutside, []);
});

test("non-literal outside paths are not silently skipped", () => {
  for (const p of ["`/evil`", "EVIL_PATH", '"/ev" + "il"']) {
    const r = scan(wrap(`app.get(${p}, ${H});`), {}, {}, {});
    assert.ok(r.ungated.length + r.unparsed.length > 0, `${p}: ${JSON.stringify(r)}`);
  }
});

test("the root path and a bare wildcard after auth are reported, not skipped", () => {
  for (const p of ["/", "*", "/*", "/:tenant"]) {
    const r = scan(wrap(`app.get("${p}", ${H});`), {}, {}, {});
    assert.ok(r.ungated.length + r.unparsed.length > 0, `${p}: ${JSON.stringify(r)}`);
  }
});

test("a stale outside entry is reported even when other entries are used", () => {
  const r = scan(wrap(`app.get("/a", ${H});`), {}, {}, { "GET /a": "reason reason reason", "GET /b": "reason reason reason" });
  assert.deepEqual(keys(r), []);
  assert.deepEqual(r.staleOutside, ["GET /b"]);
});

test("staleOutside is always an array (empty when enforcement is off)", () => {
  const r = scan(wrap(`app.get("/evil", ${H});`));
  assert.ok(Array.isArray(r.staleOutside));
});

test("AUTHZ-07 in pentest passes OUTSIDE_SCOPE_ROUTES and reports staleOutside", () => {
  const src = readFileSync(join(ROOT, "scripts", "pentest.mjs"), "utf8");
  const call = src.match(/const scanCoreRoutes = \(\) => scanRoutes\(([^\n]*)\);/);
  assert.ok(call, "scanCoreRoutes definition found");
  assert.match(call[1], /OUTSIDE_SCOPE_ROUTES/);
  assert.match(src, /r\.staleOutside\.map/);
});
