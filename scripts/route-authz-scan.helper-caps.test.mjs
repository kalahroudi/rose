// SPDX-License-Identifier: Apache-2.0
// AUTHZ-07 whole-file pin: every import form is followed, every specifier kind is classified exactly, caps are exact.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CORE_EXEMPTIONS, HELPER_MAX_BYTES, HELPER_MAX_FILES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, diskSources, helperManifest, scan } from "./route-authz-scan.mjs";

const disk = diskSources();
const tenantApp = disk.read(resolve(disk.srcDir, "tenant-app.ts"));
const run = (sources) => scan(tenantApp, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, sources);
const withResolve = (edit) => {
  const path = resolve(disk.srcDir, "tenancy/resolve.ts");
  const before = disk.read(path);
  const after = edit(before);
  assert.notEqual(after, before);
  return { ...disk, read: (p) => (p === path ? after : disk.read(p)) };
};
const afterInvalidate = (code) => (s) => s.replace(/(function invalidateHostCache[^]*?\n}\n)/, `$1${code}\n`);
const SEED = 'cache.set("evil.example", { value: { kind: "root" }, expires: Infinity });';
const changed = (r) => r.ungated.some((u) => u.key === "HELPER ./tenancy/resolve:resolveHost");
const TENANT_IMPORT = 'import type { TenantRow } from "../control/tenants";';
const HOST_LINE = "return new URL(request.url).hostname.toLowerCase();";

// Every shape of load-time code that earlier token-level passes had to chase: whole-file hashing catches them all.
for (const [label, code] of [
  ["an initializer of an unreached const", `const _seed = ${SEED}`],
  ["a static block in an unreached class", `class Seed { static { ${SEED} } }`],
  ["a statement absorbed into a semicolon-less const (ASI)", `const zz = 1\n${SEED}`],
  ["a keyword-less statement", SEED],
  ["an IIFE", `(() => { ${SEED} })();`],
  ["a body-less function signature followed by a statement", `function ov(): void\n${SEED}`],
  ["a signature with braces in its type", `function sig(a: { x: number }): { y: number } { return { y: a.x }; }\n${SEED}`],
  ["a destructured multi-name declaration", `const { a1, b1 } = { a1: 1, b1: ${SEED.length} }, zz = 2;`],
  ["a function called from a load-time statement", `function seedHosts() { ${SEED} }\nseedHosts();`],
]) {
  test(`load-time code in an unreached spot fails the scan: ${label}`, () => {
    const r = run(withResolve(afterInvalidate(code)));
    assert.ok(changed(r), JSON.stringify([r.unparsed, r.ungated]));
  });
}

test("a side-effect import added to a helper fails the scan", () => {
  const r = run(withResolve((s) => s.replace(TENANT_IMPORT, `${TENANT_IMPORT}\nimport "./seed-effect";`)));
  assert.ok(r.unparsed.length > 0 || changed(r), JSON.stringify([r.unparsed, r.ungated]));
});

test("a node: built-in import in a helper must be listed in the manifest, and needs no lockfile lookup", () => {
  const r = run(withResolve((s) => s.replace(TENANT_IMPORT, `${TENANT_IMPORT}\nimport { randomUUID } from "node:crypto";`).replace(HOST_LINE, `randomUUID();\n  ${HOST_LINE}`)));
  assert.ok(changed(r) && r.ungated.some((u) => /node:crypto was added/.test(u.reason)), JSON.stringify([r.unparsed, r.ungated]));
  assert.ok(!r.unparsed.some((u) => /0 versions/.test(u.reason)), JSON.stringify(r.unparsed));
});

// Synthetic sources rooted at /s (the repo root is then "/", so manifest keys read "s/<file>").
const synth = (map, lockfile = "") => ({ srcDir: "/s", lockfile, read: (p) => (p.startsWith("/s/") && Object.hasOwn(map, p.slice(3)) ? map[p.slice(3)] : null) });
const tree = (map, lockfile) => helperManifest("./m", synth({ "tenant-app.ts": "", ...map }, lockfile));
const filesOf = (m) => Object.keys(m).sort();

test("every import form is followed", () => {
  const forms = {
    "import { x } from": "./a",
    "import x from": "./a",
    "import * as x from": "./a",
    "import type { X } from": "./a",
    "export { x } from": "./a",
    "export * from": "./a",
    "export * as x from": "./a",
    "export type * from": "./a",
    "import": "./a",
  };
  for (const [head, spec] of Object.entries(forms)) {
    const m = tree({ "m.ts": `${head} "${spec}";\n`, "a.ts": "export const x = 1;" });
    assert.deepEqual(filesOf(m), ["s/a.ts", "s/m.ts"], head);
  }
  assert.deepEqual(filesOf(tree({ "m.ts": 'const p = import("./a");\n', "a.ts": "" })), ["s/a.ts", "s/m.ts"]);
  assert.deepEqual(filesOf(tree({ "m.ts": 'const p = import("./a", { with: { type: "json" } });\n', "a.ts": "" })), ["s/a.ts", "s/m.ts"]);
  assert.deepEqual(filesOf(tree({ "m.ts": 'import { "a-b" as x } from "./a";\nexport { x };\n', "a.ts": "" })), ["s/a.ts", "s/m.ts"]);
  assert.deepEqual(filesOf(tree({ "m.ts": 'export { y };\nconst y = 1;\nexport default y;\nexport const z = "./nope";\n' })), ["s/m.ts"]);
});

test("a dynamic import with a non-literal argument, or require, makes the tree unparsed", () => {
  for (const code of ['const p = import(name);', 'const p = import("./a" + b);', "const p = import(`./a`);", 'const r = require("./a");', "const r = require;"]) {
    assert.throws(() => tree({ "m.ts": code, "a.ts": "" }), /dynamic import|require/, code);
  }
});

test("a malformed export-from or import is unparsed, never skipped", () => {
  assert.throws(() => tree({ "m.ts": "export * from foo;" }), /export/);
  assert.throws(() => tree({ "m.ts": "export { a } from foo;" }), /export-from/);
  assert.throws(() => tree({ "m.ts": "import { a } from;" }), /import/);
});

test("file contents are hashed exactly, CRLF aside", () => {
  const one = tree({ "m.ts": "export const x = 1;\n" });
  assert.deepEqual(tree({ "m.ts": "export const x = 1;\r\n" }), one);
  for (const edit of ["export const x = 1; \n", "export const x = 1;\n\n", "// c\nexport const x = 1;\n", "export const x=1;\n"]) assert.notDeepEqual(tree({ "m.ts": edit }), one, edit);
});

test("node: and cloudflare: specifiers are recorded by exact name without a lockfile lookup", () => {
  const m = tree({ "m.ts": 'import a from "node:crypto";\nimport b from "cloudflare:sockets";\n' });
  assert.equal(m["node:crypto"], "builtin");
  assert.equal(m["cloudflare:sockets"], "builtin");
});

test("specifiers that are none of the allowed kinds are unparsed, naming the specifier, never as a lockfile miss", () => {
  for (const spec of ["bun:sqlite", "data:text/javascript,1", "file:///x.js", "NODE:fs", "Node:fs", "node:", "cloudflare:", "https://x.example/a.js", "node:Fs", "#internal", "/abs/x", "Left-Pad"]) {
    assert.throws(() => tree({ "m.ts": `import "${spec}";` }), (e) => e.message.includes(spec) && /cannot be pinned/.test(e.message) && !/0 versions/.test(e.message), spec);
  }
});

test("an npm package is pinned by its lockfile entry, and a missing entry fails", () => {
  const lock = "  left-pad@1.0.0:\n    resolution: {integrity: sha512-a}\n";
  assert.match(tree({ "m.ts": 'import "left-pad";' }, lock)["npm:left-pad"], /^left-pad@1\.0\.0\//);
  assert.throws(() => tree({ "m.ts": 'import "left-pad";' }, ""), /0 versions of `left-pad`/);
  assert.throws(() => tree({ "m.ts": 'import "crypto";' }, lock), /`crypto` is a Node built-in written without the `node:` prefix/);
});

test("a workspace package is walked like a relative import, in the repo and through a lockfile link", () => {
  const pkg = (p) => JSON.stringify({ name: "x", exports: { ".": "./src/index.ts", "./sub": "./src/sub.ts" }, ...p });
  const src = (map, lockfile = "") => ({ srcDir: "/a/b/s", lockfile, read: (p) => (p === "/a/b/s/tenant-app.ts" ? "" : map[p] ?? null) });
  const map = { "/a/b/s/m.ts": 'import "@rose/ui";\nimport "@rose/ui/sub";', "/packages/ui/package.json": pkg(), "/packages/ui/src/index.ts": "export {};", "/packages/ui/src/sub.ts": "export {};" };
  const m = helperManifest("./m", src(map));
  assert.deepEqual(filesOf(m), ["packages/ui/package.json", "packages/ui/src/index.ts", "packages/ui/src/sub.ts", "a/b/s/m.ts"].sort());
  // an unknown export subpath is unparsed
  const bad = { ...map, "/a/b/s/m.ts": 'import "@rose/ui/nope";' };
  assert.throws(() => helperManifest("./m", src(bad)), /no plain string entry/);
  // a lockfile link: importer resolves like a workspace package
  const lock = "importers:\n\n  .:\n    dependencies:\n      linked:\n        specifier: workspace:*\n        version: link:packages/linked\n";
  const linked = { "/a/b/s/m.ts": 'import "linked";', "/packages/linked/package.json": JSON.stringify({ main: "./index.js" }), "/packages/linked/index.js": "export {};" };
  const l = helperManifest("./m", src(linked, lock));
  assert.ok(Object.hasOwn(l, "packages/linked/index.js") && !Object.keys(l).some((k) => k.startsWith("npm:")), JSON.stringify(l));
});

const chain = (n) => {
  const map = { "m.ts": 'import "./f1";' };
  for (let k = 1; k < n; k++) map[`f${k}.ts`] = `import "./f${k + 1}";`;
  map[`f${n}.ts`] = "";
  return map;
};

test("exactly the file cap passes and one more is unparsed", () => {
  assert.equal(Object.keys(tree(chain(HELPER_MAX_FILES - 1))).length, HELPER_MAX_FILES);
  assert.throws(() => tree(chain(HELPER_MAX_FILES)), new RegExp(`cap \\(${HELPER_MAX_FILES} files\\)`));
});

test("exactly the byte cap passes and one more is unparsed", () => {
  const base = "import './a';\n".length;
  const mk = (n) => ({ "m.ts": "import './a';\n", "a.ts": "x".repeat(n) });
  assert.doesNotThrow(() => tree(mk(HELPER_MAX_BYTES - base)));
  assert.throws(() => tree(mk(HELPER_MAX_BYTES - base + 1)), new RegExp(`cap \\(${HELPER_MAX_BYTES} bytes\\)`));
});

test("a cycle between files terminates", () => {
  assert.equal(Object.keys(tree({ "m.ts": 'import "./a";', "a.ts": 'import "./m";' })).length, 2);
});

test("an over-cap tree reaches the scan as unparsed, an unresolved or ambiguous import too", () => {
  const big = withResolve((s) => s.replace(TENANT_IMPORT, `${TENANT_IMPORT}\nimport "./pad";`));
  const r = run({ ...big, read: (p) => (p.endsWith("tenancy/pad.ts") ? "x".repeat(HELPER_MAX_BYTES + 1) : big.read(p)) });
  assert.ok(r.unparsed.some((u) => /cap/.test(u.reason)), JSON.stringify([r.unparsed, r.ungated]));
});

test("require reached through a member, or written with an escape, makes the tree unparsed", () => {
  for (const code of ['module.require("./a");', 'globalThis.require("./a");', 'import.meta.require("./a");', '\\u0072equire("./a");']) {
    assert.throws(() => tree({ "m.ts": code, "a.ts": "" }), /require/, code);
  }
});

test("a JSX file in the tree is unparsed, never scanned with the non-JSX tokenizer", () => {
  const code = `<p>don't</p>; import("./a"); const b = <p>'</p>;`;
  assert.throws(() => tree({ "m.tsx": code, "a.ts": "" }), /JSX/);
});

test("a symlink in the tree is unreadable, so it is never hashed under a repo-relative name", () => {
  const dir = mkdtempSync(join(tmpdir(), "authz-"));
  try {
    const core = join(dir, "repo", "packages", "core", "src");
    mkdirSync(join(dir, "out"));
    mkdirSync(core, { recursive: true });
    writeFileSync(join(dir, "out", "m.ts"), 'import "./dep";');
    writeFileSync(join(dir, "out", "dep.ts"), "export {};");
    writeFileSync(join(core, "dep.ts"), "export {};");
    writeFileSync(join(core, "tenant-app.ts"), "");
    symlinkSync(join(dir, "out", "m.ts"), join(core, "m.ts"));
    const src = diskSources(join(dir, "repo"));
    assert.equal(src.read(join(core, "dep.ts")), "export {};");
    assert.throws(() => helperManifest("./m", src), /resolves to 0 files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
