// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, parseArgs, setDatabaseId, setRoutes, setVar } from "./lib.mjs";

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
