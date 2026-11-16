// SPDX-License-Identifier: Apache-2.0
// Adversarial tests: try to get an ungated signed-in route past the AUTHZ-07 scanner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, scan } from "./route-authz-scan.mjs";

const AUTH = 'app.use("/api/*", authenticate);\n';
const wrap = (body) => `function f() {\n${AUTH}${body}\n}`;
const H = "async (c) => c.json({ secret: 1 })";
/** A source "fails" when it yields any ungated or unparsed finding. */
const fails = (body, ex = {}) => {
  const r = scan(wrap(body), ex);
  return r.ungated.length + r.unparsed.length > 0;
};

test("real tenant-app.ts yields no findings with CORE_EXEMPTIONS", () => {
  const r = scan(readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8"), CORE_EXEMPTIONS);
  assert.deepEqual([r.unparsed, r.ungated, r.stale], [[], [], []]);
  assert.ok(r.routes.some((x) => x.path === "/api/overview" && x.exempt));
});

test("method chaining on app: the chained ungated route is caught", () => {
  assert.ok(fails(`app.get("/api/a", async (c) => { need(c, "a:b"); return c.json(1); }).post("/api/b", ${H});`));
  assert.ok(fails(`app\n  .get("/api/a", async (c) => { need(c, "a:b"); })\n  .delete("/api/b", ${H});`));
});

test("unicode-escaped app identifier is not a hidden registration", () => {
  assert.ok(fails(`\\u0061pp.get("/api/x", ${H});`));
  assert.ok(fails(`ap\\u{70}.post("/api/x", ${H});`));
});

test("alias created before the auth line cannot register a signed-in route", () => {
  const src = `function f() {\nconst a = app;\nconst { get } = app;\n${AUTH}a.get("/api/x", ${H});\nget("/api/y", ${H});\n}`;
  const r = scan(src, {});
  assert.ok(r.ungated.length + r.unparsed.length > 0, JSON.stringify(r));
});

test("regex literal after ) cannot hide a route inside a fake string", () => {
  assert.ok(fails(`if (x) /'/.test(s), app.get("/api/x", ${H}), '/';`));
  assert.ok(fails(`if (x) /"/.test(s), app.get("/api/x", ${H}), "/";`));
});

test("regex literal right after ${ in a template cannot hide a route", () => {
  assert.ok(fails("const t = `${/'/.source}`; app.get(\"/api/x\", " + H + "); const u = '`';"));
});

test("regex literal after } (statement block) cannot hide a route", () => {
  assert.ok(fails(`{ }\n/'/.test(s), app.get("/api/x", ${H}), '/';`));
});

test("need() only in comments, strings, templates or regex is not a gate", () => {
  for (const g of ['// need(c, "a:b")\n', '/* need(c, "a:b") */', 'const s = "need(c, \'a:b\')";', "const s = `need(c, 'a:b')`;", "const r = /need(c, 'a:b')/;", "const s = `${'need(c, \"a:b\")'}`;"]) {
    assert.ok(fails(`app.get("/api/x", async (c) => { ${g} return c.json(1); });`), g);
  }
});

test("need() with the wrong context or an empty permission is not a gate", () => {
  for (const g of ['need(ctx, "a:b")', "need(c, ``)", 'need(c, "")', 'need("c", "a:b")', "need(c)", 'this.need(c, "a:b")', 'need?.(c, "a:b")']) {
    assert.ok(fails(`app.get("/api/x", async (c) => { ${g}; return c.json(1); });`), g);
  }
});

test("need() inside a route registered later does not gate an earlier route", () => {
  assert.ok(fails(`app.get("/api/a", ${H}); app.get("/api/b", async (c) => { need(c, "a:b"); });`));
});

test("need() in a registration nested in the handler does not gate the outer one", () => {
  assert.ok(fails(`app.get("/api/outer", async (c) => { app.get("/api/inner", async (c) => { need(c, "a:b"); }); return c.json(1); });`));
});

test("every registration shape is caught when ungated", () => {
  const shapes = [
    `app.get("/api/x", ${H});`, `app.post("/api/x", ${H});`, `app.put("/api/x", ${H});`, `app.patch("/api/x", ${H});`,
    `app.delete("/api/x", ${H});`, `app.options("/api/x", ${H});`, `app.head("/api/x", ${H});`, `app.all("/api/x", ${H});`,
    `app.on("GET", "/api/x", ${H});`, `app.on(["GET"], "/api/x", ${H});`, `app.on(methods, "/api/x", ${H});`,
    `app.route("/api", sub);`, `app.mount("/api", handler);`, `app.use("/api/x/*", ${H});`, `app.use(${H});`,
    `app.get<{ A: () => void }>("/api/x", ${H});`, `app.get<Map<string, Array<number>>>("/api/x", ${H});`,
    `app /* c */ . // c\n get ( "/api/x" , ${H} ) ;`, `app.post(${H});`,
  ];
  for (const s of shapes) assert.ok(fails(s), s);
});

test("unknown or indirect uses of app are unparsed, not passed", () => {
  for (const s of ['app.basePath("/api").get("/x", h);', "app!.get(\"/api/x\", h);", "app.get.call(app, \"/api/x\", h);", "const o = { app };", "[app].forEach((a) => a.get(\"/api/x\", h));", "Reflect.apply(app.get, app, [\"/api/x\", h]);", "app.get?.(\"/api/x\", h);", "(app).get(\"/api/x\", h);", "app['get'](\"/api/x\", h);"]) {
    const r = scan(wrap(s), {});
    assert.ok(r.unparsed.length + r.ungated.length > 0, s);
  }
});

test("registrations nested at depth are found", () => {
  assert.ok(fails(`try { while (x) { switch (y) { case 1: { (() => { if (z) app.get("/api/x", ${H}); })(); } } } } catch {}`));
  assert.ok(fails(`class K { m() { app.get("/api/x", ${H}); } }`));
  assert.ok(fails(`const t = \`\${(() => { app.get("/api/x", ${H}); return 1; })()}\`;`));
});

test("wildcard, param, template and odd literal paths are in scope", () => {
  for (const p of ['"*"', '"/*"', '"/:p/x"', '"/:p"', '"/:p{api}/x"', "`/auth`", "`/api/${x}`", '"/a" + "pi/x"', '"//api/x"', '"/\\x61pi/x"', '"/api"', '"/svc"', '"/api*"', '"/*/x"', '""', "P"]) {
    assert.ok(fails(`app.get(${p}, ${H});`), p);
  }
});

test("exemption keys cannot be reached by another method or a combined method list", () => {
  const ex = { "GET /api/overview": "r" };
  assert.ok(fails(`app.post("/api/overview", ${H});`, ex));
  assert.ok(fails(`app.on(["GET", "POST"], "/api/overview", ${H});`, ex));
  assert.ok(fails(`app.all("/api/overview", ${H});`, ex));
  assert.ok(fails(`app.get("/api/overview", async (c) => { need(c, "a:b"); }); app.get("/api/overview", ${H});`, ex));
});

test("the catch-all exemption cannot be abused", () => {
  const ex = { "ALL /api/*": { reason: "r", onlyThrows: "notFound" } };
  for (const s of [
    'app.all("/api/*", mw, () => { throw notFound(); });',
    'app.all("/api/*", (c) => { throw notFound(c.json(secret)); });',
    'app.all("/api/*", (c = leak()) => { throw notFound(); });',
    'app.all("/api/*", (c) => { throw notFound(); }); app.all("/api/*", (c) => c.json(1));',
    'app.all("/api/*", (c) => { throw notFound(); }, (c) => c.json(1));',
    'app.on("ALL", "/api/*", (c) => c.json(1));',
    'app.all("/api/*", (c) => { throw notFound(); }); app.use("/api/*", (c) => c.json(1));',
  ]) assert.ok(fails(s, ex), s);
});

test("stale exemptions are reported, including ones that only match an out-of-scope route", () => {
  const r = scan(wrap('app.get("/api/ok", async (c) => { need(c, "a:b"); });'), CORE_EXEMPTIONS);
  assert.deepEqual(r.stale.sort(), ["ALL /api/*", "GET /api/overview"]);
  const r2 = scan(wrap(`app.get("/auth/overview", ${H});`), { "GET /auth/overview": "r" });
  assert.deepEqual(r2.stale, ["GET /auth/overview"]);
});

test("missing or fake auth line is a failure", () => {
  for (const s of [
    "",
    `app.get("/api/x", ${H});`,
    `/* app.use("/api/*", authenticate); */ app.get("/api/x", ${H});`,
    `app.use("/api/*", authenticateLater); app.get("/api/x", ${H});`,
    `app.use(\`/api/*\`, authenticate); app.get("/api/x", ${H});`,
    `other.app.use("/api/*", authenticate); app.get("/api/x", ${H});`,
  ]) assert.ok(scan(s, {}).unparsed.length > 0, s);
});

test("re-applying authenticate with extra middleware is not skipped", () => {
  assert.ok(fails(`app.use("/api/*", authenticate, ${H});`));
  assert.ok(fails(`app.use("/api/x", authenticate); app.use("/api/*", (c) => c.json(1));`));
});

test("unterminated constructs make the scan fail rather than pass", () => {
  for (const s of [`app.get("/api/x", ${H}); /* open`, `app.get("/api/x", ${H}); const s = \`open`, `app.get("/api/x", (c) => { need(c, "a"`]) {
    const r = scan(wrap(s), {});
    assert.ok(r.unparsed.length + r.ungated.length > 0, s);
  }
});

// ── Attacks added in the second round ──────────────────────────────────────────────────────────
const HONO = (body) => `function f() {\nconst app = new Hono();\n${AUTH}${body}\nreturn app;\n}`;
const failsH = (body, ex = {}) => {
  const r = scan(HONO(body), ex);
  return r.ungated.length + r.unparsed.length > 0;
};
const PATHVAR = 'const P = "/api/x";\n';

test("a decoy `const app = new Hono()` earlier in the file does not shrink the scope away from the real app", () => {
  const src = `function helper() { const app = new Hono(); return app; }\nexport function mk() {\nconst app = new Hono();\n${AUTH}app.get("/api/x", ${H});\nreturn app;\n}`;
  const r = scan(src, {});
  assert.ok(r.ungated.length + r.unparsed.length > 0, JSON.stringify(r));
});

test("division after postfix ++/-- is not read as a regex that hides a route", () => {
  assert.ok(failsH(`${PATHVAR}let a = 1; let y = a++ / 2; app.get(P, ${H}); y = 1 / 1;`), "a++ /");
  assert.ok(failsH(`${PATHVAR}let a = 1; let y = a-- / 2; app.get(P, ${H}); y = 1 / 1;`), "a-- /");
});

test("division after a keyword-named property or contextual keyword identifier does not hide a route", () => {
  for (const pre of ["o.in", "o.await", "o.delete", "o.typeof", "of"]) {
    assert.ok(failsH(`${PATHVAR}const of = 4; let y = ${pre} / 2; app.get(P, ${H}); y = 1 / 1;`), pre);
  }
});

test("a route chained after app.onError(...) is caught", () => {
  assert.ok(failsH(`app.onError((e, c) => c.text("x")).get("/api/x", ${H});`));
});

test("aliasing app through `return app` in a helper function or method is not a free pass", () => {
  assert.ok(failsH(`const g = () => { return app; };\ng().get("/api/x", ${H});`), "arrow helper");
  assert.ok(failsH(`const o = { g() { return app } };\no.g().get("/api/x", ${H});`), "method helper");
});

test("need() in a later handler does not gate a route whose first handler already answers", () => {
  assert.ok(failsH(`app.get("/api/x", (c) => c.json({ secret: 1 }), (c) => need(c, "a:b"));`));
});

test("need() that can never run is not a gate", () => {
  for (const s of [
    `app.get("/api/x", async (c, next = need(c, "a:b")) => c.json({ secret: 1 }));`, // Hono always passes next
    `app.get("/api/x", async (c) => { return c.json({ secret: 1 }); need(c, "a:b"); });`,
    `app.get("/api/x", async (c) => { const g = () => need(c, "a:b"); return c.json({ secret: 1 }); });`,
  ]) assert.ok(failsH(s), s);
});

test("a locally shadowed need or context does not count as a gate", () => {
  assert.ok(failsH(`app.get("/api/x", async (c) => { const need = (_a, _b) => 0; need(c, "a:b"); return c.json({ secret: 1 }); });`), "shadowed need");
  assert.ok(failsH(`app.get("/api/x", async (c) => { { const c = fake; need(c, "a:b"); } return c.json({ secret: 1 }); });`), "shadowed c");
});

test("a registration written before the auth line but executed after it is still checked", () => {
  const hoisted = `function f() {\nconst app = new Hono();\nfunction reg() { app.get("/api/x", ${H}); }\n${AUTH}reg();\nreturn app;\n}`;
  const closure = `function f() {\nconst app = new Hono();\nconst later = () => app.get("/api/x", ${H});\n${AUTH}later();\nreturn app;\n}`;
  for (const s of [hoisted, closure]) {
    const r = scan(s, {});
    assert.ok(r.ungated.length + r.unparsed.length > 0, s);
  }
});

test("the catch-all exemption does not accept a notFound that is really the next parameter", () => {
  assert.ok(failsH('app.all("/api/*", (c, notFound) => { throw notFound(); });', { "ALL /api/*": { reason: "r", onlyThrows: "notFound" } }));
});
