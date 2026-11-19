// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the AUTHZ-07 regex-vs-division handling (tokenizeSafe, L6/L11/L12 follow-up).
// Each trick is checked to register /api/evil when run as real JS, then must be caught by scan() when injected
// before and after the auth line of the real tenant-app.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib.mjs";
import { CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, scan } from "./route-authz-scan.mjs";

const H = "async (c) => c.json(1)";
const AUTH_LINE = 'app.use("/api/*", authenticate);';
const real = () => readFileSync(join(ROOT, "packages", "core", "src", "tenant-app.ts"), "utf8");

/** Run the snippet as strict JS and return the paths it registers with app.get. */
function jsRegisters(snippet) {
  const seen = [];
  // oxlint-disable-next-line typescript/no-implied-eval -- the test executes a fixture snippet to learn which routes it registers
  new Function("app", '"use strict";\n' + snippet)({ get: (p) => seen.push(p) });
  return seen;
}

function assertCaught(snippet) {
  assert.deepEqual(jsRegisters(snippet), ["/api/evil"], "the snippet must really register the route");
  const src = real();
  for (const [where, s] of [["pre", src.replace(AUTH_LINE, snippet + AUTH_LINE)], ["post", src.replace(AUTH_LINE, AUTH_LINE + "\n" + snippet)]]) {
    const r = scan(s, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
    assert.ok(r.ungated.length + r.unparsed.length + r.stale.length + r.stalePublic.length > 0, `${where}: hidden route not reported`);
  }
}

test("regex after `extends` (heuristic reads division, not marked ambiguous) cannot hide a route", () => {
  assertCaught(`class Z extends /'/.constructor {}; app.get("/api/evil", ${H}); //' {}\n`);
});

test("division after a keyword-named private field `this.#in` (heuristic reads regex) cannot hide a route", () => {
  assertCaught(`class Z { #in = 1; m() { this.#in /'/ 1 + '; app.get("/api/evil", ${H}); //'\n } }; new Z().m();\n`);
});

test("division after `this.#typeof` cannot hide a route", () => {
  assertCaught(`class Z { #typeof = 1; m() { this.#typeof /'/ 1 + '; app.get("/api/evil", ${H}); //'\n } }; new Z().m();\n`);
});

test("mixed reading (`}` as regex, `of` as division) whose all-regex reading fails to tokenize cannot hide a route", () => {
  assertCaught(`let of = 1;\n{}\n/\`/.source;\nfor (const k in of /'/ 1') {}\napp.get('/api/evil', ${H});\n{}\n/\`/.source;\n`);
});

test("more than 200 ambiguous slashes fail closed", () => {
  const many = Array.from({ length: 210 }, () => "x = (a) / 2;").join("\n") + "\n";
  const src = real().replace(AUTH_LINE, AUTH_LINE + "\n" + many);
  const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
  assert.ok(r.unparsed.some((u) => /200/.test(u.reason)));
});

test("ordinary code with ambiguous slashes is not a finding", () => {
  const ok = [
    "const a1 = (1) / 2 + [4][0] / 2;\n",
    "const o1 = { n: 4 }.n / 2;\n",
    "let i1 = 1; const q1 = i1++ / 2;\n",
    "const s1 = 'a/b'.split(/\\//).length / 2;\n",
    "class K1 { #n = 4; m() { return this.#n / 2; } }\n",
    "for (const v of [1]) { const w = (v) / 2; }\n",
  ];
  for (const snip of ok) {
    const src = real().replace(AUTH_LINE, AUTH_LINE + "\n" + snip);
    const r = scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES);
    assert.deepEqual(r.unparsed, [], snip);
    assert.deepEqual(r.ungated, [], snip);
  }
});
