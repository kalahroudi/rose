// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for AUTHZ-07 pre-authentication app.use middleware (PUBLIC_CORE_MIDDLEWARE).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, middlewareFingerprint, scan, tokenize } from "./route-authz-scan.mjs";
import { pentestSource } from "./pentest-source.mjs";
// Fingerprint of the plain pass-through inline middleware used in fixtures (it uses no free identifiers).
const FP_NEXT = middlewareFingerprint(tokenize("async (c, next) => { await next(); }"));

const AUTH_LINE = 'app.use("/api/*", authenticate);';
const NEED = "const need = (c, permission) => { const a = c.get(\"actor\"); if (!can(a.role, permission)) throw forbidden(); return a; };";
const IMPORTS = 'import { csrfGuard, requestContext } from "./http/base";\nimport { etag } from "hono/etag";\nimport { evilHandler } from "./evil";\n'; // named middleware must be bound by an import
const wrap = (pre, post = "") => `${IMPORTS}function f() {\nconst app = new Hono();\n${pre}\n${AUTH_LINE}\n${NEED}\n${post}\nreturn app;\n}`;
const MW = (pre, list, post = "") => scan(wrap(pre, post), {}, {}, null, list);
const keys = (a) => a.map((u) => u.key);
const rejected = (r) => r.ungated.length + r.unparsed.length > 0;
const LIST = [
  { path: "*", handler: "inline", fingerprint: FP_NEXT, reason: "r" },
  { path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" },
  { path: "/api/*", handler: "etag()", from: "hono/etag", reason: "r" }, // call form: must match `etag()` exactly
];
const OK = 'app.use("*", async (c, next) => { await next(); });\napp.use("/api/*", csrfGuard);\napp.use("/api/*", etag());';
const realSrc = () => readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");
const realScan = (src) => scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE);
const injectBeforeAuth = (src, code) => {
  const at = src.indexOf('app.use("/api/*", authenticate)');
  assert.ok(at > 0, "auth line found");
  return `${src.slice(0, at)}${code}\n  ${src.slice(at)}`;
};

test("baseline: listed middleware passes cleanly", () => {
  const r = MW(OK, LIST);
  assert.deepEqual([r.ungated, r.unparsed, r.stalePublic], [[], [], []]);
});

test("spec 1: every PUBLIC_CORE_MIDDLEWARE entry has a non-empty path, handler and reason", () => {
  assert.ok(Array.isArray(PUBLIC_CORE_MIDDLEWARE) && PUBLIC_CORE_MIDDLEWARE.length > 0);
  for (const e of PUBLIC_CORE_MIDDLEWARE) {
    assert.equal(typeof e.path, "string"); assert.ok(e.path.length > 0);
    assert.equal(typeof e.handler, "string"); assert.ok(e.handler.length > 0);
    assert.equal(typeof e.reason, "string"); assert.ok(e.reason.trim().length > 0);
  }
});

test("spec 2: listed handler on a different path is ungated", () => {
  const r = MW(`${OK}\napp.use("/api/evil", csrfGuard);`, LIST);
  assert.deepEqual(keys(r.ungated), ["USE /api/evil"]);
});

test("spec 2: listed path with a different identifier handler is ungated", () => {
  const r = MW(`${OK}\napp.use("/api/*", evilHandler);`, LIST);
  assert.deepEqual(keys(r.ungated), ["USE /api/*"]);
});

test("spec 2: an inline function in place of a listed identifier is ungated", () => {
  const r = MW('app.use("*", async (c, next) => { await next(); });\napp.use("/api/*", async (c) => c.json(secret));\napp.use("/api/*", etag());', LIST);
  assert.deepEqual(keys(r.ungated), ["USE /api/*"]);
  assert.deepEqual(r.stalePublic, ["USE /api/* csrfGuard"]);
});

test("spec 2: a `function` expression handler is recognised as inline and flagged when unlisted", () => {
  const r = MW(`${OK}\napp.use("/api/evil", function (c) { return c.json(secret); });`, LIST);
  assert.deepEqual(keys(r.ungated), ["USE /api/evil"]);
});

test("spec 2: an identifier literally named `inline` is not treated as an inline function", () => {
  // The allow-list scheme uses "inline" for inline functions; a variable named inline must not ride on that entry.
  const r = MW('const inline = async (c) => c.json(secret);\napp.use("*", inline);\napp.use("/api/*", csrfGuard);\napp.use("/api/*", etag());', LIST);
  assert.ok(rejected(r), JSON.stringify(r.ungated.concat(r.unparsed)));
});

test("spec 2: ungated report carries the reported line number of the registration", () => {
  const r = MW(`${OK}\napp.use("/api/evil", async (c) => c.json(secret));`, LIST);
  assert.equal(r.ungated.length, 1);
  assert.equal(r.ungated[0].line, 9); // 3 import lines / function f(){ / const app / 3 OK lines / evil
  assert.match(r.ungated[0].reason, /before the authentication line/);
});

test("spec 2: middleware after the auth line is not checked against the pre-auth list", () => {
  const r = MW(OK, LIST, 'app.use("/api/*", someLogger);');
  assert.deepEqual([r.stalePublic], [[]]);
  assert.ok(!keys(r.ungated).includes("USE /api/*"));
});

test("spec 2: evil middleware chained onto a pre-auth route is flagged", () => {
  const r = scan(wrap(`${OK}\napp.get("/api/bootstrap", async (c) => c.json(1)).use("/api/evil", async (c) => c.json(secret));`), {}, { "GET /api/bootstrap": "r" }, null, LIST);
  assert.deepEqual(keys(r.ungated), ["USE /api/evil"]);
});

test("spec 2: pre-auth app.use nested inside a block is never a silent pass", () => {
  const r = MW(`${OK}\nif (x) { app.use("/api/evil", async (c) => c.json(secret)); }`, LIST);
  assert.ok(rejected(r));
});

test("spec 3: allow-list entries consumed once; a surplus duplicate entry is stale", () => {
  const r = MW(OK, [...LIST, { path: "*", handler: "inline", fingerprint: FP_NEXT, reason: "r" }]);
  assert.deepEqual(r.stalePublic, ["USE * inline"]);
  assert.deepEqual(r.ungated, []);
});

test("spec 3: all entries stale when there is no pre-auth middleware", () => {
  const r = MW("", LIST);
  assert.deepEqual(r.stalePublic.sort(), ["USE * inline", "USE /api/* csrfGuard", "USE /api/* etag()"].sort());
});

test("spec 4: unreadable pre-auth app.use forms go to unparsed, never pass", () => {
  const forms = [
    "app.use(`*`, async (c, next) => { await next(); });",
    'app.use("/api/\\x2a", csrfGuard);',
    'app.use("/api/" + "*", csrfGuard);',
    'app.use("/api/*", etag(), evil);',
    'app.use("/api/*", mw.evil);',
    'app.use("/api/*", mw.evil());',
    'app.use("/api/*", (async (c) => c.json(secret)));',
    'app.use("/api/*", cond ? csrfGuard : evil);',
    "app.use(...args);",
    "app.use();",
  ];
  for (const f of forms) {
    const r = MW(`${OK}\n${f}`, LIST);
    assert.ok(r.unparsed.length >= 1, `unparsed for ${f}: ${JSON.stringify(r)}`);
  }
});

test("spec 4: a listed-looking handler with extra handler args is not a pass", () => {
  const r = MW('app.use("*", async (c, next) => { await next(); });\napp.use("/api/*", csrfGuard, async (c) => c.json(secret));\napp.use("/api/*", etag());', LIST);
  assert.ok(rejected(r));
});

test("spec 5: the real tenant-app.ts passes with zero ungated / unparsed / stale", () => {
  const r = realScan(realSrc());
  assert.deepEqual([r.ungated, r.unparsed, r.stale, r.stalePublic, r.staleOutside], [[], [], [], [], []]);
});

test("spec 5/7: evil app.use injected above the real auth line is flagged", () => {
  const r = realScan(injectBeforeAuth(realSrc(), 'app.use("/api/evil", async (c) => c.json(secret));'));
  assert.deepEqual(keys(r.ungated), ["USE /api/evil"]);
});

test("spec 5/7: an extra inline '*' middleware in the real file is flagged", () => {
  const r = realScan(injectBeforeAuth(realSrc(), 'app.use("*", async (c, next) => { await next(); });'));
  assert.deepEqual(keys(r.ungated), ["USE *"]);
});

test("spec 5/7: removing a listed middleware from the real file yields a stale entry", () => {
  const src = realSrc();
  const line = 'app.use("/svc/*", csrfGuard);';
  assert.ok(src.includes(line));
  const r = realScan(src.replace(line, ""));
  assert.deepEqual(r.stalePublic, ["USE /svc/* csrfGuard"]);
  assert.deepEqual(r.ungated, []);
});

test("legacy: default (no publicMiddleware) leaves pre-auth app.use unchecked and does not crash", () => {
  const r = scan(wrap(`${OK}\napp.use("/api/evil", async (c) => c.json(secret));`));
  assert.deepEqual(r.stalePublic, []);
});

test("pentest AUTHZ-07 wires PUBLIC_CORE_MIDDLEWARE into the scan", () => {
  const src = pentestSource(ROOT);
  assert.match(src, /scanRoutes\([^;]*PUBLIC_CORE_MIDDLEWARE\)/);
});
