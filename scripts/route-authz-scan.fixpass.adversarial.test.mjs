// SPDX-License-Identifier: Apache-2.0
// Adversarial: AUTHZ-07 load-time code shapes found by earlier review passes. Since the M6 redesign pins every
// file in a helper's import tree by its whole contents, each shape must fail the scan when added to a helper
// module, however the old tokenizer would have classified it.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, diskSources, scan } from "./route-authz-scan.mjs";

const disk = diskSources();
const tenantApp = disk.read(resolve(disk.srcDir, "tenant-app.ts"));
const RESOLVE = resolve(disk.srcDir, "tenancy/resolve.ts");
const original = disk.read(RESOLVE);
const SEED = 'cache.set("evil.example", { value: { kind: "root" }, expires: Infinity });';
const run = (resolveSrc) =>
  scan(tenantApp, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, {
    ...disk,
    read: (p) => (p === RESOLVE ? resolveSrc : disk.read(p)),
  });
const show = (r) => JSON.stringify({ unparsed: r.unparsed, ungated: r.ungated });
const insertAfterInvalidate = (code) => {
  const out = original.replace(/(function invalidateHostCache[^]*?\n}\n)/, `$1${code}\n`);
  assert.notEqual(out, original, "insertion point not found in tenancy/resolve.ts");
  return out;
};
const failsWith = (code) => {
  const r = run(insertAfterInvalidate(code));
  assert.ok(r.ungated.length + r.unparsed.length > 0, show(r));
};

test("baseline: the unmodified resolve.ts passes", () => {
  const r = run(original);
  assert.equal(r.ungated.length + r.unparsed.length, 0, show(r));
});

const SHAPES = {
  "a keyword-less statement after a function body": SEED,
  "a function body that runs at load via a top-level call": `function seedHosts() { ${SEED} }\nseedHosts();`,
  "an unreached const initializer (V1)": `const _seed = ${SEED.replace(/;$/, "")};`,
  "a class static block (V3)": `class Seed { static { ${SEED} } }`,
  "a semicolon-less const followed by a statement (V4, ASI)": `const zz = 1\n${SEED}`,
  "a statement after a body-less function signature": `function ov(): void\n${SEED}`,
  "a newline-function IIFE in a const": `const h =\nfunction g() { ${SEED} }()`,
  "a void newline-function IIFE": `void\nfunction g() { ${SEED} }()`,
  "a function whose signature contains braces": `function f(x: { a: 1 }): { host: string } { ${SEED} return { host: "" }; }\nf({ a: 1 });`,
  "a multi-name const": `const a1 = 1, g1 = () => { ${SEED} };\ng1();`,
  "a destructured const": `const { g2 } = { g2: () => { ${SEED} } };\ng2();`,
  "a side-effect import of a new file": 'import "./seed-hosts";',
};

for (const [name, code] of Object.entries(SHAPES)) {
  test(`${name} in a helper module fails the scan`, () => failsWith(code));
}
