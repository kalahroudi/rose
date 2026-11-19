// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, middlewareFingerprint, scan, tokenize } from "./route-authz-scan.mjs";
// Fingerprint of the plain pass-through inline middleware used in fixtures (it uses no free identifiers).
const FP_NEXT = middlewareFingerprint(tokenize("async (c, next) => { await next(); }"));

const AUTH_LINE = 'app.use("/api/*", authenticate);\n';
const NEED = "const need = (c, permission) => { const a = c.get(\"actor\"); if (!can(a.role, permission)) throw forbidden(); return a; };\n";
const AUTH = AUTH_LINE + NEED;
const wrap = (body) => `function f() {\nconst app = new Hono();\n${AUTH}${body}\nreturn app;\n}`;
const ungated = (body, ex = {}) => scan(wrap(body), ex).ungated.map((u) => u.key);
const GOOD = 'app.get("/api/ok", async (c) => { need(c, "x:read"); return c.json({}); });\n';

test("the real tenant-app.ts passes with the documented exemptions", () => {
  const r = scan(readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8"), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
  assert.deepEqual(r.unparsed, []);
  assert.deepEqual(r.ungated, []);
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.stalePublic, []);
  const jobs = r.routes.filter((x) => x.path === "/api/jobs");
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].gates, ["jobs:read"]);
  assert.ok(r.routes.length > 15);
});

test("a gated route passes; a route without need() fails", () => {
  assert.deepEqual(ungated(GOOD), []);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => c.json({}));'), ["GET /api/x"]);
});

test("a removed need() fails and a commented-out need() fails", () => {
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { return c.json(1); });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { // need(c, "a:b");\n return 1; });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { /* need(c, "a:b") */ return 1; });'), ["GET /api/x"]);
});

test("need() inside a string or template text is not a gate", () => {
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { const s = "need(c, \\"a:b\\")"; return s; });'), ["GET /api/x"]);
  assert.deepEqual(ungated("app.get(\"/api/x\", async (c) => { const s = `need(c, 'a:b')`; return s; });"), ["GET /api/x"]);
});

test("need() with the wrong context, no permission or an empty permission is not a gate", () => {
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { need(other, "a:b"); });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { need(c); });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { need(c, ""); });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (c) => { x.need(c, "a:b"); });'), ["GET /api/x"]);
  assert.deepEqual(ungated('app.get("/api/x", async (ctx) => { need(ctx, "a:b"); });'), []);
  assert.deepEqual(ungated('app.get("/api/x", async function (c) { need(c, perm); });'), []);
  assert.deepEqual(ungated('app.get("/api/x", async c => { need(c, "a:b"); });'), []);
});

test("an ungated route is caught in every registration shape", () => {
  const h = "async (c) => c.json(1)";
  const shapes = {
    get: `app.get("/api/x", ${h});`, post: `app.post("/api/x", ${h});`, put: `app.put("/api/x", ${h});`, patch: `app.patch("/api/x", ${h});`,
    delete: `app.delete("/api/x", ${h});`, options: `app.options("/api/x", ${h});`, head: `app.head("/api/x", ${h});`, all: `app.all("/api/x", ${h});`,
    generic: `app.get<{ Variables: V }>("/api/x", ${h});`, genericNested: `app.get<Env<A, B>>("/api/x", ${h});`,
    chained: `app\n  .get("/api/x", ${h});`, spaced: `app . post ( "/api/x" , ${h} ) ;`,
    onArray: `app.on(["GET", "POST"], "/api/x", ${h});`, onString: `app.on("GET", "/api/x", ${h});`,
    route: `app.route("/api/x", sub);`, mount: `app.mount("/api/x", sub);`, use: `app.use("/api/x", ${h});`,
  };
  for (const [name, code] of Object.entries(shapes)) {
    const r = scan(wrap(code), {});
    const handlerless = name === "route" || name === "mount"; // handler is not an inline function: unparsed
    assert.equal(r.ungated.length + r.unparsed.length, 1, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.unparsed.length, handlerless ? 1 : 0, name);
  }
  assert.equal(scan(wrap(shapes.onArray), {}).ungated[0].key, "GET|POST /api/x");
});

test("registrations nested in blocks, loops, ifs and callbacks are found", () => {
  const h = "async (c) => c.json(1)";
  assert.deepEqual(ungated(`if (a) { app.get("/api/x", ${h}); }`), ["GET /api/x"]);
  assert.equal(ungated(`for (const m of ms) { for (const r of m.routes) { app.on(r.method, \`/api/m/\${m.id}\`, ${h}); } }`).length, 1);
  assert.deepEqual(ungated(`list.forEach((r) => { app.get("/api/x", ${h}); });`), ["GET /api/x"]);
  assert.deepEqual(ungated(`app.get("/api/ok", async (c) => { need(c, "a:b"); app.get("/api/inner", async (d) => d.json(1)); });`), ["GET /api/inner"]);
  assert.deepEqual(ungated(`app.get("/api/outer", async (c) => { app.get("/api/inner", async (d) => { need(c, "a:b"); }); });`), ["GET /api/outer", "GET /api/inner"]);
});

test("wildcard, parameterised, template and non-literal paths are in scope; literal other first segments are not", () => {
  const h = "async (c) => c.json(1)";
  for (const p of ['"*"', '"/*"', '"/:p/x"', '"/"', "`/api/${x}`", "path", '"/(api|svc)/x"', '"/api/*"']) assert.equal(ungated(`app.all(${p}, ${h});`).length, 1, p);
  assert.deepEqual(ungated(`app.get("/__dev/tick", ${h}); app.get("/auth/handoff", ${h});`), []);
  assert.equal(ungated(`app.get("/svc/x", ${h});`).length, 1);
});

test("a template-literal path is in scope even without substitutions", () => {
  assert.equal(ungated("app.get(`/other`, async (c) => 1);").length, 1);
});

test("a regex literal containing /* or quotes does not hide later routes", () => {
  const body = `const re = /\\/*"'\`/g; const half = a / b; const r2 = /[/*]/;\napp.get("/api/x", async (c) => c.json(1));`;
  assert.deepEqual(ungated(body), ["GET /api/x"]);
  const toks = tokenize("const a = x / 2; const b = /ab+c/gi.test(y); return /z/;");
  assert.deepEqual(toks.filter((t) => t.type === "regex").map((t) => t.value), ["/ab+c/gi", "/z/"]);
});

test("division is not a regex, so a later string is still a string", () => {
  assert.deepEqual(ungated(`const q = (a + b) / 2 / 3; const s = "// not a comment";\napp.get("/api/x", async (c) => 1);`), ["GET /api/x"]);
});

test("template literals nest and their code is tokenized", () => {
  const toks = tokenize("`a ${ f(`b ${ c } /* x */`) } d // y` + z");
  assert.deepEqual(toks.filter((t) => t.type === "id").map((t) => t.value), ["f", "c", "z"]);
});

test("aliasing or passing app fails as unparsed", () => {
  for (const code of ["const a = app;", "register(app);", "app[name](\"/api/x\", h);", "app.somethingNew(\"/api/x\", h);", "app?.get(\"/api/x\", h);", "const { get } = app;", "export default app;"]) {
    const r = scan(wrap(code), {});
    assert.equal(r.unparsed.length, 1, code);
  }
  assert.deepEqual(scan(wrap("return app;"), {}).unparsed, []);
  assert.deepEqual(scan(`function f() {\nconst app = new Hono();\n${AUTH}return app\n}`, {}).unparsed, []);
});

test("app.use in scope fails unless exempted; re-applying authenticate is allowed", () => {
  assert.deepEqual(ungated('app.use("/api/x", async (c, next) => { await next(); });'), ["USE /api/x"]);
  assert.equal(scan(wrap("app.use(mw);"), {}).unparsed.length, 1); // middleware that is not an inline function
  assert.deepEqual(ungated("app.use(async (c, next) => { await next(); });"), ["USE *"]);
  assert.deepEqual(ungated('app.use("/svc/*", authenticate);'), []);
  assert.deepEqual(ungated('app.use("/api/x", async (c, next) => { await next(); });', { "USE /api/x": "reason" }), []);
});

test("exemptions: matched ones pass, unmatched ones are stale, duplicates are not covered", () => {
  const h = "async (c) => c.json(1)";
  assert.deepEqual(ungated(`app.get("/api/overview", ${h});`, { "GET /api/overview": "r" }), []);
  const r = scan(wrap(GOOD), { "GET /api/overview": "r" });
  assert.deepEqual(r.stale, ["GET /api/overview"]);
  assert.deepEqual(ungated(`app.get("/api/overview", ${h}); app.get("/api/overview", ${h});`, { "GET /api/overview": "r" }), ["GET /api/overview"]);
  assert.deepEqual(scan(wrap(`app.get("/api/overview", ${h});`), { "GET /api/overview": "r" }).routes[0].exempt, "r");
});

test("the catch-all exemption holds only while the handler just throws notFound()", () => {
  const ex = { "ALL /api/*": { reason: "r", onlyThrows: "notFound" } };
  assert.deepEqual(ungated('app.all("/api/*", () => { throw notFound(); });', ex), []);
  assert.deepEqual(ungated('app.all("/api/*", () => {\n throw notFound()\n});', ex), []);
  assert.deepEqual(ungated('app.all("/api/*", () => { leak(); throw notFound(); });', ex), ["ALL /api/*"]);
  assert.deepEqual(ungated('app.all("/api/*", (c) => c.json({ secret: 1 }));', ex), ["ALL /api/*"]);
  assert.deepEqual(ungated('app.all("/api/*", () => { throw other(); });', ex), ["ALL /api/*"]);
});

test("a missing authentication line is a failure, not a pass", () => {
  const r = scan('app.get("/api/x", async (c) => 1);', {});
  assert.equal(r.unparsed.length, 1);
  assert.match(r.unparsed[0].reason, /authentication line/);
  assert.equal(scan("app.use('/api/*', authenticate)\nlet s = 'oops", {}).unparsed.length, 1);
});

test("routes registered before the authentication line are not in scope", () => {
  const r = scan(`function f() {\nconst app = new Hono();\napp.get("/api/bootstrap", async (c) => 1);\n${AUTH}${GOOD}return app;\n}`, {}, { "GET /api/bootstrap": "public" });
  assert.deepEqual(r.ungated, []);
  assert.equal(r.routes.length, 1);
});

test("the authentication line itself is not detected inside a comment or string", () => {
  const noAuth = (src) => scan(src, {}).unparsed.some((u) => /Could not find the authentication line/.test(u.reason));
  assert.ok(noAuth('// app.use("/api/*", authenticate)\napp.get("/api/x", (c) => 1);'));
  assert.ok(noAuth('const s = \'app.use("/api/*", authenticate)\';'));
});

test("bypass: a chained registration after a gated one is checked", () => {
  const g = 'async (c) => { need(c, "a:b"); }';
  assert.deepEqual(ungated(`app.get("/api/a", ${g}).post("/api/b", async (c) => c.json(1));`), ["POST /api/b"]);
  assert.deepEqual(ungated(`app.get("/api/a", ${g}).post("/api/b", ${g}).put("/api/c", async (c) => 1);`), ["PUT /api/c"]);
  assert.deepEqual(ungated(`app.get("/api/a", ${g}).post("/api/b", ${g});`), []);
  assert.equal(scan(wrap(`app.get("/api/a", ${g}).json(1);`), {}).unparsed.length, 1);
  assert.deepEqual(scan(wrap("").replace(AUTH, 'app.use("/api/*", authenticate).get("/api/x", async (c) => 1);\n' + NEED), {}).ungated.map((u) => u.key), ["GET /api/x"]);
});

test("bypass: an identifier with a unicode escape is reported as unparsed", () => {
  for (const code of ['app.\\u0067et("/api/x", h);', '\\u0061pp.get("/api/x", h);', 'app.g\\u{65}t("/api/x", h);']) {
    assert.ok(scan(wrap(code), {}).unparsed.length >= 1, code);
  }
});

test("bypass: an alias created before the authentication line is reported", () => {
  for (const pre of ["const a = app;", "const { get } = app;", "let r = app;"]) {
    const r = scan(`const app = new Hono<Env>();\n${pre}\n${AUTH}a.get("/api/x", h);`, {});
    assert.equal(r.unparsed.length, 1, pre);
  }
  assert.deepEqual(scan(`const app = new Hono<Env>();\napp.get("/api/pre", async (c) => c.json(1));\n${AUTH}${GOOD}return app;`, {}).unparsed, []);
});

test("bypass: an empty permission is not a gate", () => {
  assert.deepEqual(ungated("app.get(\"/api/x\", async (c) => { need(c, ``); });"), ["GET /api/x"]);
  assert.deepEqual(ungated("app.get(\"/api/x\", async (c) => { need(c, ''); });"), ["GET /api/x"]);
  assert.deepEqual(ungated("app.get(\"/api/x\", async (c) => { need(c, `a:${p}`); });"), ["GET /api/x"]); // interpolated: not a known permission
});

test("bypass: the catch-all exemption needs plain parameters and an exact throw notFound() body", () => {
  const ex = { "ALL /api/*": { reason: "r", onlyThrows: "notFound" } };
  assert.deepEqual(ungated('app.all("/api/*", (c = leak()) => { throw notFound(); });', ex), ["ALL /api/*"]);
  assert.deepEqual(ungated('app.all("/api/*", ({ a = leak() }) => { throw notFound(); });', ex), ["ALL /api/*"]);
  assert.deepEqual(ungated('app.all("/api/*", function (c = leak()) { throw notFound(); });', ex), ["ALL /api/*"]);
  assert.deepEqual(ungated('app.all("/api/*", (c) => { throw notFound(); });', ex), ["ALL /api/*"]); // any parameter disqualifies
  assert.deepEqual(ungated('app.all("/api/*", () => { throw notFound() });', ex), []);
  assert.deepEqual(ungated('app.all("/api/*", function () { throw notFound(); });', ex), []);
});

// Regression tests for the second adversarial round.
const HONO = (body) => `function f() {\nconst app = new Hono();\n${AUTH}${body}\nreturn app;\n}`;
const bad = (src, ex = {}) => { const r = scan(src, ex); return r.ungated.length + r.unparsed.length > 0; };
const H = "async (c) => c.json(1)";

test("regression: the app declaration is chosen inside the function that contains the auth line", () => {
  const decoy = `function helper() { const app = new Hono(); return app; }\nfunction mk() {\nconst app = new Hono();\n${AUTH}app.get("/api/x", ${H});\nreturn app;\n}`;
  assert.ok(bad(decoy));
  assert.deepEqual(scan(`function helper() { const app = new Hono(); return app; }\nfunction mk() {\nconst app = new Hono();\n${AUTH}${GOOD}return app;\n}`, {}).unparsed, []);
  assert.equal(scan(`function f() {\n${AUTH}${GOOD}}`, {}).unparsed.length, 1); // no declaration
  assert.equal(scan(`function f() {\nconst app = new Hono(); const app2 = 1; { const app = new Hono(); }\n${AUTH}${GOOD}}`, {}).unparsed.length, 1); // several
});

test("regression: / after postfix ++ or -- is division", () => {
  const t = (src) => tokenize(src).filter((x) => x.type === "regex").length;
  assert.equal(t("let y = a++ / 2; let z = b-- / 3;"), 0);
  assert.equal(t("let y = a[0]++ / 2; let z = f()-- / 3;"), 0);
  assert.equal(t("let y = x + +/re/.source;"), 1);
});

test("regression: a keyword after . or ?. is a property name", () => {
  const t = (src) => tokenize(src).filter((x) => x.type === "regex").length;
  assert.equal(t("let y = o.in / 2; let z = o?.delete / 2;"), 0);
  assert.equal(t("let y = typeof /re/.source;"), 1);
  assert.equal(t("const of = 4; let y = of / 2;"), 0);
});

test("regression: a chain after app.onError(...) is checked", () => {
  assert.ok(bad(HONO(`app.onError((e, c) => c.text("x")).get("/api/x", ${H});`)));
  assert.ok(!bad(HONO(`app.onError((e, c) => c.text("x")).get("/api/x", async (c) => { need(c, "a:b"); });`)));
});

test("regression: return app only counts as a top-level statement of the factory", () => {
  assert.ok(bad(HONO(`const g = () => { return app; };`)));
  assert.ok(bad(HONO(`if (x) { return app; }`)));
  assert.ok(!bad(HONO(GOOD)));
});

test("regression: every handler must be an inline function and the gate must be in the first", () => {
  const g = 'async (c) => { need(c, "a:b"); }';
  assert.equal(scan(HONO(`app.get("/api/x", mw, ${g});`), {}).unparsed.length, 1);
  assert.equal(scan(HONO(`app.get("/api/x", ${g}, handler);`), {}).unparsed.length, 1);
  assert.equal(scan(HONO(`app.get("/api/x", ${g}, mw());`), {}).unparsed.length, 1);
  assert.ok(bad(HONO(`app.get("/api/x", ${H}, ${g});`)));
  assert.ok(!bad(HONO(`app.get("/api/x", ${g}, ${H});`)));
});

test("regression: the gate must be the first statement of the handler", () => {
  const ok = (b) => !bad(HONO(`app.get("/api/x", async (c) => { ${b} });`));
  assert.ok(ok('need(c, "a:b"); return c.json(1);'));
  assert.ok(ok('const actor = need(c, "a:b"); return c.json(actor);'));
  assert.ok(ok('let actor = await need(c, "a:b");'));
  assert.ok(!ok('return c.json(1); need(c, "a:b");'));
  assert.ok(!ok('log(); need(c, "a:b");'));
  assert.ok(!ok('const g = () => need(c, "a:b"); return c.json(1);'));
  assert.ok(!bad(HONO(`app.get("/api/x", (c) => need(c, "a:b"));`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c, next = need(c, "a:b")) => c.json(1));`)));
});

test("regression: a redeclared need or context parameter is not a gate", () => {
  const ok = (b) => !bad(HONO(`app.get("/api/x", async (c) => { ${b} });`));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { const need = (_a, _b) => 0; need(c, "a:b"); });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { need(c, "a:b"); const need = () => 0; });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { need(c, "a:b"); { const c = fake; } });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { need(c, "a:b"); function need() {} });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { need(c, "a:b"); [1].map((need) => need); });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c, need) => { need(c, "a:b"); });`)));
  assert.ok(bad(HONO(`app.get("/api/x", async (c) => { need(c, "a:b"); const { c: x, need: y } = z, need = 1; });`)));
  assert.ok(ok('need(c, "a:b"); if (c.req) { return c.json(1); } return x ? f(c) : g;'));
});

test("regression: a registration nested before the auth line is unparsed", () => {
  const pre = (b) => `function f() {\nconst app = new Hono();\n${b}\n${AUTH}return app;\n}`;
  assert.equal(scan(pre(`function reg() { app.get("/api/x", ${H}); }`), {}).unparsed.length, 1);
  assert.ok(scan(pre(`const later = () => app.get("/api/x", ${H});`), {}).unparsed.length >= 1);
  assert.equal(scan(pre(`if (x) { app.get("/api/x", ${H}); }`), {}).unparsed.length, 1);
  assert.equal(scan(pre(`if (x) app.get("/api/x", ${H});`), {}).unparsed.length, 1);
  assert.deepEqual(scan(pre(`app.get("/api/pre", ${H});`), {}).unparsed, []);
});

test("regression: the catch-all exemption needs zero params and an exact throw notFound() body", () => {
  const ex = { "ALL /api/*": { reason: "r", onlyThrows: "notFound" } };
  assert.ok(!bad(HONO('app.all("/api/*", () => { throw notFound(); });'), ex));
  assert.ok(bad(HONO('app.all("/api/*", (c) => { throw notFound(); });'), ex));
  assert.ok(bad(HONO('app.all("/api/*", (c, notFound) => { throw notFound(); });'), ex));
  assert.ok(bad(HONO('app.all("/api/*", () => { log(); throw notFound(); });'), ex));
});

// Regression tests for the third adversarial round.
const unparsedOf = (src) => scan(src, {}).unparsed.length;
const GATE = 'async (c) => { need(c, "a:b"); return c.json(1); }';

test("regression: the value of a registration is not tracked, so any use of it is unparsed", () => {
  for (const code of [
    `const r = app.get("/api/a", ${GATE}); r.get("/api/b", ${H});`,
    `app.get("/api/a", ${GATE})!.get("/api/b", ${H});`,
    `app.get("/api/a", ${GATE})["get"]("/api/b", ${H});`,
    `(app.get("/api/a", ${GATE})).get("/api/b", ${H});`,
    `(app.get("/api/a", ${GATE}) as any).get("/api/b", ${H});`,
    `register(app.get("/api/a", ${GATE}));`,
    `app.get("/api/a", ${GATE}) as any;`,
    `x = app.get("/api/a", ${GATE});`,
    `app.get("/api/a", ${GATE}), other();`,
    `app.get("/api/a", ${GATE})\n(other)();`,
  ]) assert.ok(unparsedOf(HONO(code)) >= 1, code);
  // before the authentication line too: an alias made there can register routes after it
  assert.ok(unparsedOf(`function f() {\nconst app = new Hono();\nconst r = app.get("/x", ${H});\n${AUTH}r.get("/api/b", ${H});\nreturn app;\n}`) >= 1);
  // the shapes that stay valid
  for (const code of [`app.get("/api/a", ${GATE});`, `app.get("/api/a", ${GATE})\napp.get("/api/b", ${GATE});`, `if (x) app.get("/api/a", ${GATE});`, `app\n.get("/api/a", ${GATE})\n.post("/api/b", ${GATE});`]) {
    assert.deepEqual(scan(HONO(code), {}).unparsed, [], code);
  }
});

test("regression: a regex right after the ) closing an if/while/for/with condition is a regex", () => {
  const regexes = (src) => tokenize(src).filter((t) => t.type === "regex").map((t) => t.value);
  assert.deepEqual(regexes("if (p) /a\\/*b/.test(p);"), ["/a\\/*b/"]);
  assert.deepEqual(regexes("while (p) /x/.test(p); for (;;) /y/.test(p); for await (const a of b) /z/.test(a); with (o) /w/.test(1);"), ["/x/", "/y/", "/z/", "/w/"]);
  assert.deepEqual(regexes("const q = (a + b) / 2 / 3; f(x) / 2; o.if(x) / 2;"), []);
  const r = scan(HONO(`if (p) /a\\/*b/.test(p);\napp.get("/api/hidden", ${H});\n/* note */\napp.get("/api/ok", ${GATE});`), {});
  assert.deepEqual(r.ungated.map((u) => u.key), ["GET /api/hidden"]);
});

test("regression: need must be declared exactly once, at factory level, and must still check", () => {
  const src = (decl, body = `app.get("/api/x", ${GATE});`) => `function f() {\nconst app = new Hono();\n${AUTH_LINE}${decl}\n${body}\nreturn app;\n}`;
  assert.deepEqual(scan(src(NEED), {}).unparsed, []);
  assert.equal(unparsedOf(src("")), 1, "no declaration");
  assert.equal(unparsedOf(src(NEED + NEED)) >= 1, true, "two declarations");
  assert.ok(unparsedOf(src(NEED, `for (const r of rs) { const need = (c, p) => c.get("actor"); app.get("/api/x", ${GATE}); }`)) >= 1, "shadowed in an enclosing block");
  assert.ok(unparsedOf(src(NEED, `function g(need) { app.get("/api/x", ${GATE}); }`)) >= 1, "parameter");
  assert.ok(unparsedOf(src(NEED, `const { need } = o; app.get("/api/x", ${GATE});`)) >= 1, "destructured");
  assert.ok(unparsedOf(src(NEED, `const g = need;`)) >= 1, "need used as a value");
  assert.ok(unparsedOf(src(NEED.replace("if (!can(a.role, permission)) throw forbidden();", ""))) >= 1, "body no longer checks");
  assert.ok(unparsedOf(src(NEED.replace("throw forbidden()", "log()"))) >= 1, "no throw");
  assert.ok(unparsedOf(src("const need = (c, p) => c.get('actor');")) >= 1, "expression body");
  assert.ok(unparsedOf(src(`if (x) { ${NEED} }`)) >= 1, "not at factory level");
  assert.deepEqual(scan(src(NEED, `app.get("/api/x", async (c) => { o.need(c, "a:b"); });`), {}).unparsed, []); // member access is not a binding
  // the real file with its check removed
  const real = readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");
  const r = scan(real.replace("if (!can(actor.role, permission)) throw forbidden();", ""), CORE_EXEMPTIONS);
  assert.ok(r.unparsed.length >= 1);
});

test("regression: the permission argument must be a known-shaped literal or a dotted identifier path", () => {
  const ok = (arg) => !bad(HONO(`app.get("/api/x", async (c) => { need(c, ${arg}); });`));
  for (const arg of ['"a:b"', "`a:b`", "'members:read'", "route.permission", "perm", "a.b.c", '"a-b:c-d"']) assert.ok(ok(arg), arg);
  for (const arg of ["undefined", "null as never", '("")', "...[]", "``", '""', '"nocolon"', '"A:b"', '"a:b:c"', "`a:${p}`", "null", "this", "a?.b", "a[0]", "f()", "a.b()", 'x ? "a:b" : "c:d"', '"a:b" as string', "route.permission!"]) assert.ok(!ok(arg), arg);
});

test("regression: a gate that relies on ASI (no semicolon) counts", () => {
  const ok = (b) => !bad(HONO(`app.get("/api/x", async (c) => {\n${b}\n});`));
  assert.ok(ok('need(c, "a:b")\nreturn c.json(1)'));
  assert.ok(ok('const actor = need(c, "a:b")\nreturn c.json(actor)'));
  assert.ok(ok("need(c, `a:b`)\nreturn 1"));
  assert.ok(ok('need(c, "a:b")'));
  assert.ok(!ok('need(c, "a:b")\n(evil)()'));
  assert.ok(!ok('need(c, "a:b")\n[0]'));
  assert.ok(!ok('need(c, "a:b") + 1; return 1'));
  assert.ok(!ok('need(c, "a:b") || x; return 1'));
});

const U = 'async (c) => c.json({ leaked: true })';

test("regression: // comments end at \\r, U+2028 and U+2029 too", () => {
  for (const lt of ["\r", " ", " "]) {
    assert.deepEqual(ungated(`// c${lt}app.get("/api/evil", ${U});`), ["GET /api/evil"], JSON.stringify(lt));
  }
  assert.equal(tokenize("a // x b").length, 2);
  assert.equal(tokenize("a\r\nb\rc")[2].line, 3);
});

test("regression: `/` after a postfix non-null `!` is division; ambiguous spacing fails closed", () => {
  const body = `const p = "/api/evil"; const n = [1][0]; const h = n! / 2; app.get(p, ${U}); const q = 1 / 2;`;
  assert.deepEqual(ungated(body), ["GET p"]);
  assert.deepEqual(ungated(`const h2 = [1][0]!/2; app.get('/api/evil', ${U}); const q2 = 1 / 2;`), ["GET /api/evil"]);
  assert.equal(tokenize("x!/2").filter((t) => t.type === "regex").length, 0);
  assert.equal(tokenize("x = !/re/.test(y)").filter((t) => t.type === "regex").length, 1);
  assert.ok(unparsedOf(wrap("const a = x ! / 2; app.get('/api/evil', " + U + "); const b = 1 / 2;")) > 0);
});

test("regression: template holes emit tokens and a registration in a hole is unparsed", () => {
  const types = tokenize("`a${b}c`").map((t) => t.type);
  assert.deepEqual(types, ["template", "tmplOpen", "id", "tmplClose", "templateEnd"]);
  const src = `const tag = (_s, ...v) => v[1];\nconst r = tag\`\${(0)}\${app.get("/api/a", ${GOOD.slice(GOOD.indexOf("async"), -3)})\n}\`;\nr.get("/api/evil", ${U});`;
  assert.ok(unparsedOf(wrap(src)) > 0);
});

test("regression: route registration outside the factory function is unparsed", () => {
  const extra = (code) => wrap("") + "\n" + code;
  assert.ok(unparsedOf(extra(`export function g(app) { app.get("/api/evil", ${U}); }`)) > 0);
  assert.ok(unparsedOf(extra(`const w = make(); w.app.get("/api/evil", ${U});`)) > 0);
  assert.equal(unparsedOf(extra(`const v = c.get("host");`)), 0);
});

const PRE = (pre, pub) => scan(`function f() {\nconst app = new Hono();\n${pre}\n${AUTH}\nreturn app;\n}`, {}, pub);
const OPEN_H = "async (c) => c.json({})";

test("public allow-list: an unlisted route before the auth line is ungated, a listed one passes", () => {
  assert.deepEqual(PRE(`app.get("/api/evil", ${OPEN_H});`, {}).ungated.map((u) => u.key), ["GET /api/evil"]);
  assert.deepEqual(PRE(`app.post("/x", ${OPEN_H});`, {}).ungated.map((u) => u.key), ["POST /x"]);
  const ok = PRE(`app.get("/api/pub", ${OPEN_H});`, { "GET /api/pub": "why" });
  assert.deepEqual(ok.ungated, []);
  assert.deepEqual(ok.stalePublic, []);
  assert.deepEqual(ok.unparsed, []);
});

test("public allow-list: middleware before the auth line stays out of scope", () => {
  const r = PRE('app.use("*", async (c, next) => { await next(); });', {});
  assert.deepEqual(r.ungated, []);
});

test("public allow-list: stale, duplicate, dynamic path, and entries registered after auth", () => {
  assert.deepEqual(PRE("", { "GET /api/gone": "why" }).stalePublic, ["GET /api/gone"]);
  const dup = PRE(`app.get("/api/pub", ${OPEN_H});\napp.get("/api/pub", ${OPEN_H});`, { "GET /api/pub": "why" });
  assert.equal(dup.ungated.length, 1);
  assert.match(dup.ungated[0].reason, /Duplicate/);
  const dyn = PRE(`app.get(PATH, ${OPEN_H});`, { "GET /api/pub": "why" });
  assert.equal(dyn.unparsed.length >= 1, true);
  const after = scan(wrap(GOOD), {}, { "GET /api/ok": "why" });
  assert.deepEqual(after.stalePublic, ["GET /api/ok"]);
});

test("public allow-list: a chained pre-auth registration is checked too", () => {
  const r = PRE(`app.get("/api/pub", ${OPEN_H}).post("/api/evil", ${OPEN_H});`, { "GET /api/pub": "why" });
  assert.deepEqual(r.ungated.map((u) => u.key), ["POST /api/evil"]);
});

test("review: identifier `of` before `/` is division, so a trick cannot hide a route", () => {
  const real = readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");
  const authLine = 'app.use("/api/*", authenticate);';
  const trick = (route) => `let of: any = 1;\n {}\n of / (${route} as any); //'\n ;\n`;
  const pre = real.replace(authLine, trick("app.get('/api/evil', H)") + authLine);
  assert.notEqual(pre, real);
  const r = scan(pre, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
  assert.ok(r.ungated.length + r.unparsed.length > 0);
  const post = real.replace(authLine, authLine + "\n" + trick("app.get('/api/evil', H)"));
  const r2 = scan(post, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
  assert.ok(r2.ungated.length + r2.unparsed.length > 0);
  // for-of with a regex still tokenizes as a regex
  assert.ok(tokenize("for (const x of /a/.exec(s)) {}").some((t) => t.type === "regex"));
  assert.ok(tokenize("for (x of /a/.exec(s)) {}").some((t) => t.type === "regex"));
  assert.ok(!tokenize("let of = 1; of / 2 / 3;").some((t) => t.type === "regex"));
  assert.throws(() => tokenize("for (let of / 2; ;) {}"), /Ambiguous/);
});

test("review: app.on with a non-standard method cannot forge a synthetic key", () => {
  const forged = PRE(`app.on("ROUTE", "/api/auth", ${OPEN_H});`, { "ROUTE /api/auth": "why" });
  assert.ok(forged.unparsed.length >= 1);
  assert.deepEqual(forged.stalePublic, ["ROUTE /api/auth"]);
  assert.ok(unparsedOf(wrap(`app.on("ALL", "/api/x", ${GATE});`)) >= 1);
  assert.equal(unparsedOf(wrap(`app.on(["GET", "post"], "/api/x", ${GATE});`)), 0);
});

test("review: allow-listed pre-auth routes must have only inline handler arguments", () => {
  const r = PRE(`app.get("/api/bootstrap", "/api/evil", ${OPEN_H});`, { "GET /api/bootstrap": "why" });
  assert.ok(r.unparsed.length >= 1);
  const ok = PRE(`app.get("/api/bootstrap", ${OPEN_H}, ${OPEN_H});`, { "GET /api/bootstrap": "why" });
  assert.deepEqual(ok.unparsed, []);
});

test("review: ambiguous regex-vs-division slashes fail closed (L6, L11, L12), before and after the auth line", () => {
  const real = readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");
  const authLine = 'app.use("/api/*", authenticate);';
  const tricks = [
    "{}\n/'/; app.get('/api/evil', H); //'\n;\n",
    "let of: any = 1;\nfor (const k in of / (app.get('/api/evil', H) as any) as any) {} //' ) {}\n",
    "for (void of / (app.get('/api/evil', H)); false;) {} //' ) {}\n",
    "let x: any;\nfor ((x) of /'/.source) app.get('/api/evil', H); //' )\n;\n",
    "for (x! of /'/.source) app.get('/api/evil', H); //' )\n;\n",
  ];
  for (const trick of tricks) {
    for (const src of [real.replace(authLine, trick + authLine), real.replace(authLine, authLine + "\n" + trick)]) {
      assert.notEqual(src, real);
      const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
      assert.ok(r.ungated.length + r.unparsed.length + r.stale.length + r.stalePublic.length > 0, trick);
    }
  }
  assert.ok(scan(real.replace(authLine, tricks[0] + authLine), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES).unparsed.some((u) => /Ambiguous/.test(u.reason) && u.line > 0));
});

test("review: ordinary division and regex are not ambiguity findings", () => {
  const ok = (body) => assert.deepEqual(scan(wrap(body), {}).unparsed, [], body);
  ok("const x = (a) / 2;");
  ok("const y = (a) / 2 + b / 3; const z = [1][0] / 2;");
  ok("const r = /a'b/.test(s); const q = (/x/g).test(s); f(/y\"/);");
  ok(GOOD);
  const rec = [];
  tokenize("const x = (a) / 2;", { record: rec });
  assert.equal(rec.length, 1);
  tokenize("const r = /a/;", { record: rec });
  assert.equal(rec.length, 1);
});

test("raw cross-check: scanned words inside strings, regexes or comments are reported unparsed", () => {
  const un = (body) => scan(wrap(body), {}).unparsed.map((u) => u.reason);
  assert.ok(un('const s = "app.get(";').some((r) => /inside what the scanner read as a string, regex or comment/.test(r)));
  assert.ok(un("// authenticate is next\n").some((r) => /authenticate/.test(r)));
  assert.ok(un("const r = /need(/;").some((r) => /need/.test(r)));
  assert.deepEqual(un(GOOD), []);
});

test("`#name` after a keyword-named private field is a property, and `extends /re/` is ambiguous", () => {
  const toks = tokenize("class Z { #in = 1; m() { return this.#in / 2; } }");
  assert.ok(!toks.some((t) => t.type === "regex"));
  const rec = [];
  tokenize("class Z extends /x/.constructor {}", { record: rec });
  assert.equal(rec.length, 1);
  const hide = "class Z extends /'/.constructor {}; app.get(\"/api/evil\", async (c) => c.json(1)); //' {}\n";
  assert.ok(scan(wrap(hide), {}).unparsed.length > 0);
});

test("impossible readings are discarded: no false positive on (1) / 2 + [4][0] / 2", () => {
  const r = scan(wrap("const a = (1) / 2 + [4][0] / 2; const b = (a) / 2 + f(b) / 3;"), {});
  assert.deepEqual(r.unparsed, []);
});

test("the real tenant-app.ts passes with OUTSIDE_SCOPE_ROUTES enforced", () => {
  const r = scan(readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8"), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES);
  assert.deepEqual([r.unparsed, r.ungated, r.stale, r.stalePublic, r.staleOutside], [[], [], [], [], []]);
});

test("an unlisted post-auth route outside /api and /svc is reported", () => {
  const r = scan(wrap('app.get("/evil", async (c) => c.json({ secret: 1 }));'), {}, {}, {});
  assert.deepEqual(r.ungated.map((u) => u.key), ["GET /evil"]);
  assert.deepEqual(r.staleOutside, []);
});

test("a listed post-auth route outside /api and /svc passes", () => {
  const r = scan(wrap('app.get("/evil", async (c) => c.json({}));'), {}, {}, { "GET /evil": "reason" });
  assert.deepEqual([r.ungated, r.unparsed, r.staleOutside], [[], [], []]);
});

test("a stale outside-scope entry is reported", () => {
  const r = scan(wrap(GOOD), {}, {}, { "GET /evil": "reason" });
  assert.deepEqual(r.staleOutside, ["GET /evil"]);
  assert.deepEqual(r.ungated, []);
});

test("a duplicate listed outside-scope registration is reported", () => {
  const r = scan(wrap('app.get("/evil", async (c) => c.json({})); app.get("/evil", async (c) => c.json({}));'), {}, {}, { "GET /evil": "reason" });
  assert.deepEqual(r.ungated.map((u) => u.key), ["GET /evil"]);
});

const MW_IMPORTS = 'import { csrfGuard, requestContext } from "./http/base";\nimport { etag } from "hono/etag";\n';
const MW = (pre, list = PUBLIC_CORE_MIDDLEWARE) => scan(`${MW_IMPORTS}function f() {\nconst app = new Hono();\n${pre}\n${AUTH}\nreturn app;\n}`, {}, {}, null, list);
const MW_OK = [{ path: "*", handler: "inline", fingerprint: FP_NEXT, reason: "r" }, { path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }];
const MW_SRC = 'app.use("*", async (c, next) => { await next(); });\napp.use("/api/*", csrfGuard);';

test("pre-auth middleware: listed middleware passes, in source order", () => {
  const r = MW(MW_SRC, MW_OK);
  assert.deepEqual([r.ungated, r.unparsed, r.stalePublic], [[], [], []]);
  assert.ok(PUBLIC_CORE_MIDDLEWARE.every((e) => e.reason.trim() && e.path && e.handler));
});

test("pre-auth middleware: an answering app.use above the auth line is flagged", () => {
  const r = MW(`${MW_SRC}\napp.use("/api/evil", async (c) => c.json(secret));`, MW_OK);
  assert.deepEqual(r.ungated.map((u) => u.key), ["USE /api/evil"]);
  assert.match(r.ungated[0].reason, /PUBLIC_CORE_MIDDLEWARE/);
});

test("pre-auth middleware: an extra unlisted app.use('*', inline) is flagged (each entry is used once)", () => {
  const r = MW(`${MW_SRC}\napp.use("*", async (c, next) => { await next(); });`, MW_OK);
  assert.deepEqual(r.ungated.map((u) => u.key), ["USE *"]);
});

test("pre-auth middleware: a removed listed middleware is stale", () => {
  const r = MW('app.use("*", async (c, next) => { await next(); });', MW_OK);
  assert.deepEqual(r.stalePublic, ["USE /api/* csrfGuard"]);
});

test("pre-auth middleware: non-literal path or handler is unparsed, never a pass", () => {
  for (const s of ['app.use(P, csrfGuard);', 'app.use(`/api/${x}`, csrfGuard);', 'app.use("/api/*", a, b);', 'app.use("/api/*", ...hs);', 'app.use("/api/*", (a || b));', 'app.use(csrfGuard);']) {
    const r = MW(s, MW_OK);
    assert.equal(r.unparsed.length, 1, s);
    assert.deepEqual(r.ungated, [], s);
  }
});

test("pre-auth middleware: a chained use after a listed one is checked too", () => {
  const r = MW('app.use("*", async (c, next) => { await next(); }).use("/api/evil", async (c) => c.json(1));\napp.use("/api/*", csrfGuard);', MW_OK);
  assert.deepEqual(r.ungated.map((u) => u.key), ["USE /api/evil"]);
});

test("the real tenant-app.ts passes with PUBLIC_CORE_MIDDLEWARE enforced", () => {
  const r = scan(readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8"), CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE);
  assert.deepEqual([r.unparsed, r.ungated, r.stale, r.stalePublic, r.staleOutside], [[], [], [], [], []]);
});

test("pre-auth middleware: calls with arguments are unparsed; bare and call forms differ", () => {
  const list = [{ path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }, { path: "/api/*", handler: "etag()", from: "hono/etag", reason: "r" }];
  const ok = MW('app.use("/api/*", csrfGuard);\napp.use("/api/*", etag());', list);
  assert.deepEqual([ok.ungated, ok.unparsed, ok.stalePublic], [[], [], []]);
  for (const s of ['app.use("/api/*", etag(async (c) => c.json(secret)));\napp.use("/api/*", csrfGuard);', 'app.use("/api/*", etag());\napp.use("/api/*", csrfGuard(x));']) {
    const r = MW(s, list);
    assert.ok(r.unparsed.length === 1 && r.ungated.length === 0, s);
  }
  const bare = MW('app.use("/api/*", csrfGuard);\napp.use("/api/*", etag);', list);
  assert.deepEqual(bare.ungated.map((u) => u.key), ["USE /api/*"]);
});

// L14 review follow-ups: exact handler form, reviewed inline code, import-only names, order, list validation.
const REAL = () => readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");
const realMw = (src) => scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE);
const beforeFirstUse = (src, code) => { const at = src.indexOf('app.use("*"'); assert.ok(at > 0); return `${src.slice(0, at)}${code}\n  ${src.slice(at)}`; };
const swap = (src, a, b) => { assert.ok(src.includes(a), a); return src.replace(a, b); };

test("pre-auth middleware: a no-argument call never matches a bare-identifier entry", () => {
  const r = MW('app.use("*", requestContext());', [{ path: "*", handler: "requestContext", from: "./http/base", reason: "r" }]);
  assert.deepEqual([r.ungated.map((u) => u.key), r.stalePublic], [["USE *"], ["USE * requestContext"]]);
  for (const [a, b] of [['app.use("*", requestContext as never);', 'app.use("*", requestContext());'], ['app.use("/api/*", csrfGuard);', 'app.use("/api/*", csrfGuard());']]) {
    const r2 = realMw(swap(REAL(), a, b));
    assert.equal(r2.ungated.length, 1, b);
  }
});

test("pre-auth middleware: changing the code of a reviewed inline middleware fails until its fingerprint is updated", () => {
  assert.ok(PUBLIC_CORE_MIDDLEWARE.filter((e) => e.handler === "inline").every((e) => /^[0-9a-f]{16}$/.test(e.fingerprint ?? "")));
  const r = realMw(swap(REAL(), 'app.use("*", async (c, next) => {', 'app.use("*", async (c, next) => {\n    return c.json({ leaked: c.env });'));
  assert.ok(r.ungated.some((u) => /fingerprint/.test(u.reason)), JSON.stringify(r.ungated));
  // whitespace and comments are not code: they do not change the fingerprint
  const r2 = realMw(swap(REAL(), 'app.use("*", async (c, next) => {', 'app.use("*", async (c, next) => { // reviewed\n'));
  assert.deepEqual([r2.ungated, r2.unparsed, r2.stalePublic], [[], [], []]);
});

test("pre-auth middleware: a named handler must be bound only by an import", () => {
  for (const code of ["const csrfGuard = async (c) => c.json(secret);", "const etag = () => async (c) => c.json(secret);", "let { requestContext } = evil;"]) {
    const r = realMw(beforeFirstUse(REAL(), code));
    assert.ok(r.unparsed.some((u) => /exactly one unrenamed import|must be one value import/.test(u.reason)), code);
  }
  const assigned = MW('csrfGuard = evil;\napp.use("/api/*", csrfGuard);', [{ path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }]);
  assert.equal(assigned.unparsed.length, 1);
  const notImported = scan(`function f() {\nconst app = new Hono();\napp.use("/api/*", csrfGuard);\n${AUTH}\nreturn app;\n}`, {}, {}, null, [{ path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }]);
  assert.equal(notImported.unparsed.length, 1);
  const renamed = scan(`import { csrfGuard as cg } from "./http/base";\nfunction f() {\nconst app = new Hono();\napp.use("/api/*", csrfGuard);\n${AUTH}\nreturn app;\n}`, {}, {}, null, [{ path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }]);
  assert.equal(renamed.unparsed.length, 1);
});

test("pre-auth middleware: registrations must follow the list order", () => {
  const list = [{ path: "*", handler: "requestContext", from: "./http/base", reason: "r" }, { path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" }];
  const ok = MW('app.use("*", requestContext);\napp.use("/api/*", csrfGuard);', list);
  assert.deepEqual([ok.ungated, ok.unparsed, ok.stalePublic], [[], [], []]);
  const r = MW('app.use("/api/*", csrfGuard);\napp.use("*", requestContext);', list);
  assert.equal(r.ungated.length, 1);
  assert.match(r.ungated[0].reason, /order/);
});

test("pre-auth middleware: a malformed allow-list is reported, never a pass or a crash", () => {
  const src = 'app.use("/api/*", csrfGuard);';
  for (const list of [[{ path: "/api/*", handler: "csrfGuard" }], [{ path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "  " }], [null], [{ path: "*", handler: "csrfGuard", from: "./http/base", reason: "r", fingerprint: "abc" }]]) {
    const r = MW(src, list);
    assert.ok(r.unparsed.some((u) => /PUBLIC_CORE_MIDDLEWARE\[0\]/.test(u.reason)), JSON.stringify(list));
    assert.deepEqual(r.ungated.map((u) => u.key), ["USE /api/*"], JSON.stringify(list));
  }
  const notArray = MW(src, { path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" });
  assert.equal(notArray.unparsed.length, 1);
});

test("pre-auth middleware: the import's module is pinned and must not be renamed", () => {
  const r = realMw(swap(REAL(), 'import { etag } from "hono/etag";', 'import { etag } from "./evil";'));
  assert.ok(r.ungated.some((u) => /imported from "\.\/evil"/.test(u.reason)), JSON.stringify(r.ungated));
  const noBase = (src) => swap(src, "import { clientIp, csrfGuard, errorHandler,", "import { clientIp, errorHandler,");
  for (const imp of ['import { csrfGuard } from "./evil";', 'import { answer as csrfGuard } from "./http/base";', 'import csrfGuard from "./http/base";']) {
    const r2 = realMw(swap(noBase(REAL()), 'import { z } from "zod";', `import { z } from "zod";\n${imp}`));
    assert.ok(r2.ungated.length + r2.unparsed.length > 0, imp);
  }
});

test("pre-auth middleware: any other binding of a named middleware fails (generic params, using, namespaces)", () => {
  const fac = "export function createTenantApp(options: TenantAppOptions) {";
  for (const [a, b] of [[fac, "export function createTenantApp<T = unknown>(options: TenantAppOptions, [csrfGuard, requestContext]: any[] = [evil, evil]) {"], [fac, `namespace csrfGuard {}\n${fac}`], ["  const app = new Hono<Env>();", "  using csrfGuard: any = evil;\n  const app = new Hono<Env>();"], ["  const app = new Hono<Env>();", "  ({ csrfGuard } = evil);\n  const app = new Hono<Env>();"]]) {
    const r = realMw(swap(REAL(), a, b));
    assert.ok(r.unparsed.length > 0, b);
  }
});

test("pre-auth middleware: all middleware must come before the first public route", () => {
  const r = realMw(swap(swap(REAL(), '  app.use("/api/*", csrfGuard);\n', ""), '  app.use("/api/*", authenticate);', '  app.use("/api/*", csrfGuard);\n  app.use("/api/*", authenticate);'));
  assert.ok(r.ungated.some((u) => /after a public route/.test(u.reason)), JSON.stringify(r.ungated));
});

test("pre-auth middleware: helpers called by a fingerprinted inline middleware cannot be shadowed or re-imported", () => {
  for (const code of ["const assertEnvironment = (_e) => { throw 0; };", "const Response = class {};", "const resolveHost = async () => evil;"]) {
    const r = realMw(swap(REAL(), "  const app = new Hono<Env>();", `  ${code}\n  const app = new Hono<Env>();`));
    assert.ok(r.unparsed.some((u) => /inline middleware uses/.test(u.reason)), code);
  }
  const moved = realMw(swap(REAL(), 'import { hostnameOf, invalidateHostCache, resolveHost, type HostResolution } from "./tenancy/resolve";', 'import { hostnameOf, invalidateHostCache, type HostResolution } from "./tenancy/resolve";\nimport { resolveHost } from "./evil";'));
  assert.ok(moved.ungated.some((u) => /fingerprint/.test(u.reason)), JSON.stringify(moved.ungated));
});

test("pre-auth middleware: inline entries need a fingerprint, named entries a module, and holes are reported", () => {
  for (const list of [[{ path: "*", handler: "inline", reason: "r" }], [{ path: "/api/*", handler: "csrfGuard", reason: "r" }]]) {
    const r = MW('app.use("*", async (c, next) => { await next(); });\napp.use("/api/*", csrfGuard);', list);
    assert.ok(r.unparsed.some((u) => /PUBLIC_CORE_MIDDLEWARE\[0\]/.test(u.reason)), JSON.stringify(list));
  }
  const sparse = [];
  sparse[1] = { path: "/api/*", handler: "csrfGuard", from: "./http/base", reason: "r" };
  const r = MW('app.use("/api/*", csrfGuard);', sparse);
  assert.ok(r.unparsed.some((u) => /PUBLIC_CORE_MIDDLEWARE\[0\]/.test(u.reason)));
  assert.deepEqual(r.ungated, []);
});

test("pre-auth middleware: names hidden by an ambiguous `/`, global rebinding and namespace merges are caught", () => {
  const fac = "export function createTenantApp(options: TenantAppOptions) {";
  const hidden = realMw(swap(REAL(), fac, "export function createTenantApp(options: TenantAppOptions, a = 0 as Array<any> / 1, csrfGuard: any = globalThis.answerAll, b = 1 / 1) {"));
  assert.ok(hidden.unparsed.length > 0, "a parameter hidden in a misread regex");
  for (const code of ["globalThis.Response = Evil as never;", 'Reflect.set(globalThis, "Response", Evil);']) {
    const r = realMw(swap(REAL(), "  const app = new Hono<Env>();", `  ${code}\n  const app = new Hono<Env>();`));
    assert.ok(r.unparsed.some((u) => /inline middleware uses `Response`/.test(u.reason)), code);
  }
  const ns = realMw(swap(REAL(), fac, `namespace Response.x { export const y = 1; }\n${fac}`));
  assert.ok(ns.unparsed.some((u) => /inline middleware uses `Response`/.test(u.reason)));
});
