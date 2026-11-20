// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the AUTHZ-07 pre-authentication public allow-list (PUBLIC_CORE_ROUTES).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, scan } from "./route-authz-scan.mjs";

const AUTH_LINE = 'app.use("/api/*", authenticate);\n';
const NEED = "const need = (c, permission) => { const a = c.get(\"actor\"); if (!can(a.role, permission)) throw forbidden(); return a; };\n";
const H = "async (c) => c.json(1)";
// pre: code before the auth line; post: code after it.
const wrap = (pre, post = "") => `function f() {\nconst app = new Hono();\n${pre}\n${AUTH_LINE}${NEED}${post}\nreturn app;\n}`;
const run = (pre, pub = {}, post = "") => scan(wrap(pre, post), {}, pub);
const keys = (arr) => arr.map((u) => u.key);
const PUB = { "GET /api/bootstrap": "r", "ROUTE /api/auth": "r" };
const realSrc = () => readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");

/** A pre-auth source must be rejected: something in ungated or unparsed. */
const rejected = (r) => r.ungated.length + r.unparsed.length > 0;

test("unlisted pre-auth route on any path is ungated (default publicRoutes is empty)", () => {
  for (const p of ["/api/evil", "/x", "/", "/svc/evil", "/auth/handoff2", "*", "/api/*", "/healthz"]) {
    const r = scan(wrap(`app.get(${JSON.stringify(p)}, ${H});`));
    assert.deepEqual(keys(r.ungated), [`GET ${p}`], p);
  }
});

test("every registrar before auth is checked against the allow-list", () => {
  const cases = {
    [`app.get("/e", ${H});`]: "GET /e", [`app.post("/e", ${H});`]: "POST /e", [`app.put("/e", ${H});`]: "PUT /e",
    [`app.patch("/e", ${H});`]: "PATCH /e", [`app.delete("/e", ${H});`]: "DELETE /e", [`app.options("/e", ${H});`]: "OPTIONS /e",
    [`app.head("/e", ${H});`]: "HEAD /e", [`app.all("/e", ${H});`]: "ALL /e", [`app.on("GET", "/e", ${H});`]: "GET /e",
    [`app.on(["GET", "POST"], "/e", ${H});`]: "GET|POST /e", [`app.on(m, "/e", ${H});`]: "ON /e",
    [`app.route("/e", sub);`]: "ROUTE /e", [`app.mount("/e", fetcher);`]: "MOUNT /e",
    [`app.get<{ V: 1 }>("/e", ${H});`]: "GET /e",
  };
  for (const [src, key] of Object.entries(cases)) assert.deepEqual(keys(run(src, PUB).ungated), [key], src);
});

test("allow-listed key with a different registrar does not pass", () => {
  for (const src of [`app.all("/api/bootstrap", ${H});`, `app.post("/api/bootstrap", ${H});`, `app.mount("/api/auth", x);`,
    `app.get("/api/auth", ${H});`, `app.route("/api/bootstrap", sub);`, `app.on(["GET", "POST"], "/api/bootstrap", ${H});`]) {
    const r = run(src, PUB);
    assert.equal(r.ungated.length, 1, src);
  }
});

test("allow-listed routes pass and are not stale", () => {
  const r = run(`app.get("/api/bootstrap", ${H});\napp.route("/api/auth", sub);`, PUB);
  assert.deepEqual(r.ungated, []);
  assert.deepEqual(r.unparsed, []);
  assert.deepEqual(r.stalePublic, []);
});

test("routes chained after pre-auth middleware, onError or a public route are checked", () => {
  for (const src of [
    `app.use("*", mw).get("/api/evil", ${H});`,
    `app.onError(h).get("/api/evil", ${H});`,
    `app.get("/api/bootstrap", ${H}).post("/api/evil", ${H});`,
    `app\n  .use("*", mw)\n  .use("/x", mw)\n  .all("/api/evil", ${H});`,
    `app.route("/api/auth", sub).mount("/api/evil", f);`,
  ]) {
    const r = run(src, PUB);
    assert.equal(r.ungated.length, 1, src);
    assert.match(r.ungated[0].key, /\/api\/evil$/, src);
  }
});

test("optional-chained or computed registrations before auth are rejected", () => {
  for (const src of [`app.use("*", mw)?.get("/api/evil", ${H});`, `app["get"]("/api/evil", ${H});`, `(app).get("/api/evil", ${H});`,
    `const a = app; a.get("/api/evil", ${H});`, `const { get } = app;`]) {
    assert.ok(rejected(run(src, PUB)), src);
  }
});

test("duplicates of an allow-listed key are reported, whichever shape they take", () => {
  for (const src of [
    `app.get("/api/bootstrap", ${H});\napp.get("/api/bootstrap", ${H});`,
    `app.get("/api/bootstrap", ${H}).get("/api/bootstrap", ${H});`,
    `app.get("/api/bootstrap", ${H});\napp.on("GET", "/api/bootstrap", ${H});`,
    `app.on(["GET"], "/api/bootstrap", ${H});\napp.get("/api/bootstrap", ${H});`,
    `app.route("/api/auth", a);\napp.route("/api/auth", b);`,
  ]) {
    const r = run(src, PUB);
    assert.equal(r.ungated.length, 1, src);
    assert.match(r.ungated[0].reason, /[Dd]uplicate/, src);
  }
  const three = run(`app.get("/api/bootstrap", ${H});\n`.repeat(3), PUB);
  assert.equal(three.ungated.length, 2);
});

test("dynamic or non-literal paths before auth are unparsed", () => {
  for (const src of [
    `app.get(P, ${H});`, `app.get("/api/" + "evil", ${H});`, "app.get(`/api/evil`, " + H + ");", "app.get(`/api/${x}`, " + H + ");",
    `app.get(["/api/bootstrap", "/api/evil"], ${H});`, `app.on("GET", ["/api/bootstrap", "/api/evil"], ${H});`,
    `app.get(${H});`, `app.get();`, `app.get("\\/api/bootstrap", ${H});`, `app.get(("/api/bootstrap"), ${H});`,
    `app.get("/api/bootstrap" as const, ${H});`, `app.route(base, sub);`,
  ]) {
    const r = run(src, PUB);
    assert.ok(r.unparsed.length > 0, src);
  }
});

test("pre-auth registrations not at the factory top level are rejected", () => {
  for (const src of [
    `if (x) app.get("/api/evil", ${H});`, `if (x) { app.get("/api/bootstrap", ${H}); }`,
    `const later = () => app.get("/api/evil", ${H});`, `app.use("*", async (c, next) => { app.get("/api/evil", ${H}); await next(); });`,
    `void app.get("/api/evil", ${H});`, `app.get("/api/evil", ${H}), 0;`, `x = app.get("/api/evil", ${H});`,
  ]) {
    assert.ok(rejected(run(src, PUB)), src);
  }
});

test("case and whitespace variants never match an allow-list key", () => {
  for (const p of ["/API/bootstrap", "/api/Bootstrap", " /api/bootstrap", "/api/bootstrap ", "/api/bootstrap/", "/api//bootstrap", "/api/bootstrap\\t"]) {
    const r = run(`app.get(${JSON.stringify(p)}, ${H});`, PUB);
    assert.ok(rejected(r), p);
    assert.ok(r.stalePublic.includes("GET /api/bootstrap"), p);
  }
  for (const k of ["get /api/bootstrap", "GET  /api/bootstrap", " GET /api/bootstrap", "GET /api/bootstrap ", "Get /api/bootstrap"]) {
    const r = run(`app.get("/api/bootstrap", ${H});`, { [k]: "r" });
    assert.deepEqual(keys(r.ungated), ["GET /api/bootstrap"], k);
    assert.deepEqual(r.stalePublic, [k], k);
  }
});

test("prototype and inherited keys do not allow-list anything", () => {
  const inherited = Object.create({ "GET /api/evil": "r" });
  assert.deepEqual(keys(run(`app.get("/api/evil", ${H});`, inherited).ungated), ["GET /api/evil"]);
  for (const p of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const r = run(`app.get(${JSON.stringify(p)}, ${H});`, {});
    assert.equal(r.ungated.length, 1, p);
  }
  const polluted = JSON.parse('{"__proto__": "r", "GET /api/bootstrap": "r"}');
  const r = run(`app.get("/api/bootstrap", ${H});`, polluted);
  assert.deepEqual(r.ungated, []);
  assert.deepEqual(r.stalePublic, ["__proto__"]);
  const nullProto = Object.assign(Object.create(null), { "GET /api/bootstrap": "r" });
  assert.deepEqual(run(`app.get("/api/bootstrap", ${H});`, nullProto).ungated, []);
});

test("an allow-listed key registered only after authentication is stale (not a match)", () => {
  const r = run("", { "GET /api/bootstrap": "r" }, `app.get("/api/bootstrap", async (c) => { need(c, "a:b"); return 1; });`);
  assert.deepEqual(r.stalePublic, ["GET /api/bootstrap"]);
  assert.deepEqual(r.ungated, []);
  const chainedOnAuth = scan(`function f() {\nconst app = new Hono();\napp.use("/api/*", authenticate).get("/api/bootstrap", async (c) => { need(c, "a:b"); });\n${NEED}return app;\n}`, {}, { "GET /api/bootstrap": "r" });
  assert.deepEqual(chainedOnAuth.stalePublic, ["GET /api/bootstrap"]);
});

test("chained routes on the auth line stay under need() rules, not the allow-list", () => {
  const src = `function f() {\nconst app = new Hono();\napp.use("/api/*", authenticate).get("/api/bootstrap", ${H});\n${NEED}return app;\n}`;
  const r = scan(src, {}, { "GET /api/bootstrap": "r" });
  assert.deepEqual(keys(r.ungated), ["GET /api/bootstrap"]);
});

test("pre-auth middleware or an allow-list match on 'use' does not satisfy a route key", () => {
  const r = run(`app.use("/api/bootstrap", ${H});`, { "GET /api/bootstrap": "r", "USE /api/bootstrap": "r" });
  assert.deepEqual(r.ungated, []);
  assert.ok(r.stalePublic.includes("GET /api/bootstrap"));
});

test("stale public entries are separate from stale exemptions", () => {
  const r = scan(wrap(""), { "GET /api/gone": "r" }, { "GET /api/also-gone": "r" });
  assert.deepEqual(r.stale, ["GET /api/gone"]);
  assert.deepEqual(r.stalePublic, ["GET /api/also-gone"]);
});

test("a public key does not exempt the same route after auth, and an exemption does not allow it before auth", () => {
  const after = run("", { "GET /api/x": "r" }, `app.get("/api/x", ${H});`);
  assert.deepEqual(keys(after.ungated), ["GET /api/x"]);
  const before = scan(wrap(`app.get("/api/overview", ${H});`), CORE_EXEMPTIONS, {});
  assert.ok(keys(before.ungated).includes("GET /api/overview"));
});

test("PUBLIC_CORE_ROUTES lists exactly the intended routes, each with a real reason", () => {
  assert.deepEqual(Object.keys(PUBLIC_CORE_ROUTES).sort(), [
    "GET /api/bootstrap", "GET /api/root/slug", "GET /auth/handoff", "POST /api/root/code/link",
    "POST /api/root/code/request", "POST /api/root/code/verify", "POST /api/root/enter", "ROUTE /api/auth",
  ].sort());
  for (const [k, v] of Object.entries(PUBLIC_CORE_ROUTES)) assert.ok(typeof v === "string" && v.trim().length > 30, k);
});

test("real tenant-app.ts: injecting an unlisted route before auth is caught", () => {
  const src = realSrc();
  const at = src.indexOf('app.use("/api/*", authenticate);');
  assert.ok(at > 0);
  for (const inj of [`app.get("/api/evil", ${H});\n  `, `app.post("/x", ${H});\n  `, `app.get("/api/bootstrap", ${H});\n  `,
    `app.all("/svc/*", ${H});\n  `, `app.use("*", mw).get("/api/evil", ${H});\n  `]) {
    const r = scan(src.slice(0, at) + inj + src.slice(at), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
    assert.equal(r.ungated.length, 1, inj);
  }
});

test("real tenant-app.ts: removing an allow-listed registration makes its entry stale", () => {
  const src = realSrc().replace(/app\.get\("\/api\/root\/slug"/, 'app.get("/api/root/slug2"');
  const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
  assert.deepEqual(r.stalePublic, ["GET /api/root/slug"]);
  assert.deepEqual(keys(r.ungated), ["GET /api/root/slug2"]);
});
