// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the AUTHZ-07 whole-file pin of pre-auth helper import trees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { CORE_EXEMPTIONS, HELPER_MAX_BYTES, HELPER_MAX_FILES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, REVIEWED_HELPERS, diskSources, helperManifest, scan } from "./route-authz-scan.mjs";

// Built at runtime: the repo guard rejects literal deep paths into the core package.
const CORE = ["packages", "core", "src"].join("/");
const disk = diskSources();
const tenantApp = disk.read(resolve(disk.srcDir, "tenant-app.ts"));
const run = (sources = disk) => scan(tenantApp, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, sources);
const dump = (r) => JSON.stringify([r.unparsed, r.ungated]);
const withFile = (rel, edit) => {
  const path = resolve(disk.srcDir, rel);
  const before = disk.read(path);
  const after = edit(before);
  assert.notEqual(after, before, `edit to ${rel} changed nothing`);
  return { ...disk, read: (p) => (p === path ? after : disk.read(p)) };
};
const withExtra = (rel, text) => {
  const path = resolve(disk.srcDir, rel);
  return { ...disk, read: (p) => (p === path ? text : disk.read(p)) };
};

// Synthetic sources: srcDir "/s", repo root "/", manifest keys "s/<file>".
const synth = (map, lockfile = "") => ({ srcDir: "/s", lockfile, read: (p) => (p.startsWith("/s/") && Object.hasOwn(map, p.slice(3)) ? map[p.slice(3)] : null) });
const tree = (map, lockfile) => helperManifest("./m", synth({ "tenant-app.ts": "", ...map }, lockfile));
const files = (m) => Object.keys(m).filter((k) => k.startsWith("s/")).sort();
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- hashing ----

test("each file's value is a sha256 prefix (at least 64 bits) of its exact contents", () => {
  const text = "export const x = 1;\n// tail\n";
  const v = tree({ "m.ts": text })["s/m.ts"];
  assert.equal(typeof v, "string");
  assert.ok(v.length >= 16 && sha(text).startsWith(v), v);
});

test("CRLF is normalised to LF but a lone CR is not", () => {
  const lf = tree({ "m.ts": "a;\nb;\n" })["s/m.ts"];
  assert.equal(tree({ "m.ts": "a;\r\nb;\r\n" })["s/m.ts"], lf);
  assert.notEqual(tree({ "m.ts": "a;\rb;\r" })["s/m.ts"], lf);
  assert.ok(sha("a;\nb;\n").startsWith(lf));
});

test("a JSON file in the tree is hashed, so editing it changes the manifest", () => {
  const a = tree({ "m.ts": 'import d from "./d.json";\n', "d.json": '{"allow":false}' });
  const b = tree({ "m.ts": 'import d from "./d.json";\n', "d.json": '{"allow":true}' });
  assert.ok(Object.hasOwn(a, "s/d.json"), JSON.stringify(a));
  assert.notEqual(a["s/d.json"], b["s/d.json"]);
});

// ---- import extraction ----

for (const [label, code] of [
  ["default plus named", 'import d, { x } from "./a";'],
  ["default plus namespace", 'import d, * as ns from "./a";'],
  ["single quotes", "import { x } from './a';"],
  ["multi-line list with a comment holding a fake string", 'import {\n  x, // "./not-a-spec"\n  y,\n} from "./a";'],
  ["import attributes", 'import d from "./a" with { type: "json" };'],
  ["export default re-export", 'export { default } from "./a";'],
  ["export type list", 'export type { T } from "./a";'],
  ["dynamic import inside a template literal hole", "export const s = `${await import(\"./a\")}`;"],
  ["dynamic import with a comment before the argument", 'export const p = import(/* hi */ "./a");'],
  ["dynamic import inside a nested function", 'export function f() { return () => import("./a"); }'],
  ["dynamic import with whitespace and newline", 'export const p = import (\n  "./a"\n);'],
  ["side-effect import after code", 'export const k = 1;\nimport "./a";'],
  ["typeof import type query", 'export type T = typeof import("./a");'],
]) {
  test(`import form is followed: ${label}`, () => {
    const m = tree({ "m.ts": code, "a.ts": "export const x = 1, y = 2; export default 3; export type T = 1;" });
    assert.deepEqual(files(m), ["s/a.ts", "s/m.ts"], JSON.stringify(m));
  });
}

test("imports are followed transitively through every hop", () => {
  const m = tree({ "m.ts": 'export * from "./a";', "a.ts": 'export { q } from "./b";', "b.ts": 'import("./c");\nexport const q = 1;', "c.ts": 'import "./d";', "d.ts": "" });
  assert.deepEqual(files(m), ["s/a.ts", "s/b.ts", "s/c.ts", "s/d.ts", "s/m.ts"]);
});

for (const [label, code] of [
  ["non-literal dynamic import in a template hole", "export const s = `${await import(name)}`;"],
  ["dynamic import of a template literal with a hole", "export const p = import(`./${n}`);"],
  ["require in a nested function", 'export function f() { return require("./a"); }'],
  ["optional-call require", 'export const r = require?.("./a");'],
  ["require passed as a value", "export const r = [require];"],
]) {
  test(`unknowable import is unparsed: ${label}`, () => {
    assert.throws(() => tree({ "m.ts": code, "a.ts": "" }));
  });
}

// ---- resolution ----

test("an import that resolves to no file fails", () => {
  assert.throws(() => tree({ "m.ts": 'import "./missing";' }), /missing/);
});

for (const [label, extra] of [
  [".ts and .tsx shadow", { "a.ts": "", "a.tsx": "" }],
  [".ts and index.ts", { "a.ts": "", "a/index.ts": "" }],
  [".ts and .js", { "a.ts": "", "a.js": "" }],
  [".mts and .cts", { "a.mts": "", "a.cts": "" }],
  [".ts and .json", { "a.ts": "", "a.json": "{}" }],
]) {
  test(`more than one resolution candidate is unparsed: ${label}`, () => {
    assert.throws(() => tree({ "m.ts": 'import "./a";', ...extra }));
  });
}

test("index files are resolved", () => {
  assert.deepEqual(files(tree({ "m.ts": 'import "./dir";', "dir/index.ts": "" })), ["s/dir/index.ts", "s/m.ts"]);
});

test("a relative import escaping the repository fails", () => {
  assert.throws(() => tree({ "m.ts": 'import "../../../../etc/x";' }));
});

// ---- caps ----

test("the file cap counts distinct files: a diamond with exactly the cap passes", () => {
  const map = { "m.ts": "" };
  for (let k = 1; k < HELPER_MAX_FILES; k++) {
    map["m.ts"] += `import "./f${k}";\n`;
    map[`f${k}.ts`] = 'import "./f1";\nimport "./m";\n';
  }
  assert.equal(files(tree(map)).length, HELPER_MAX_FILES);
  map["m.ts"] += `import "./f${HELPER_MAX_FILES}";\n`;
  map[`f${HELPER_MAX_FILES}.ts`] = 'import "./f1";\n';
  assert.throws(() => tree(map));
});

test("the byte cap counts UTF-8 bytes, not characters", () => {
  const head = "import './a';\n";
  const room = HELPER_MAX_BYTES - Buffer.byteLength(head);
  assert.equal(room % 2, 0, "test assumes an even remainder");
  // exactly at the cap with two-byte characters: passes
  assert.doesNotThrow(() => tree({ "m.ts": head, "a.ts": "é".repeat(room / 2) }));
  // one character more is two bytes over: fails, although the character count is far under the cap
  assert.throws(() => tree({ "m.ts": head, "a.ts": "é".repeat(room / 2 + 1) }));
});

test("the byte cap counts all files together", () => {
  const half = Math.floor(HELPER_MAX_BYTES / 2);
  assert.throws(() => tree({ "m.ts": 'import "./a";\nimport "./b";\n', "a.ts": "x".repeat(half), "b.ts": "y".repeat(half) }));
});

test("docs/pentest.md quotes the same cap numbers as the constants", () => {
  const doc = readFileSync(new URL("../docs/pentest.md", import.meta.url), "utf8");
  const authz07 = doc.split("\n").filter((l) => l.includes("HELPER_MAX_FILES") || l.includes("HELPER_MAX_BYTES")).join("\n");
  assert.ok(authz07.length > 0, "docs do not mention the caps");
  for (const n of [HELPER_MAX_FILES, HELPER_MAX_BYTES]) assert.ok(new RegExp(`\\b${n}\\b`).test(authz07), `docs do not quote ${n}`);
  for (const m of authz07.matchAll(/HELPER_MAX_(FILES|BYTES)`?\s*=\s*([\d,_]+)/g)) {
    assert.equal(Number(m[2].replace(/[,_]/g, "")), m[1] === "FILES" ? HELPER_MAX_FILES : HELPER_MAX_BYTES, m[0]);
  }
});

// ---- non-relative specifiers ----

for (const spec of ["bun:ffi", "jsr:@std/path", "npm:left-pad", "node:/fs", "cloudflare:Workers", "http://x.example/a.js", "//x.example/a.js", "data:,", "NODE:crypto", "node:crypto?x"]) {
  test(`unclassifiable specifier is unparsed and named, never a lockfile miss: ${spec}`, () => {
    const lock = "  left-pad@1.0.0:\n    resolution: {integrity: sha512-a}\n";
    assert.throws(() => tree({ "m.ts": `import x from "${spec}";` }, lock), (e) => e.message.includes(spec) && !/0 versions/.test(e.message));
  });
}

test("a builtin is recorded under its exact specifier, so swapping it changes the manifest", () => {
  const a = tree({ "m.ts": 'import "node:crypto";' });
  const b = tree({ "m.ts": 'import "node:child_process";' });
  assert.ok(Object.hasOwn(a, "node:crypto") && !Object.hasOwn(a, "node:child_process"));
  assert.notDeepEqual(a, b);
});

const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  packages/core:",
  "    dependencies:",
  "      left-pad:",
  "        specifier: ^1.0.0",
  "        version: 1.0.0",
  "",
  "packages:",
  "",
  "  left-pad@1.0.0:",
  "    resolution: {integrity: sha512-aaaa}",
  "",
  "snapshots:",
  "",
  "  left-pad@1.0.0: {}",
  "",
].join("\n");
const pin = (lock) => tree({ "m.ts": 'import "left-pad";' }, lock)["npm:left-pad"];

for (const [label, edit] of [
  ["resolution integrity swapped", (l) => l.replace("sha512-aaaa", "sha512-bbbb")],
  ["resolution switched to a tarball", (l) => l.replace("{integrity: sha512-aaaa}", "{tarball: https://evil.example/left-pad.tgz}")],
  ["a patch added", (l) => l.replace("importers:", "patchedDependencies:\n  left-pad@1.0.0:\n    hash: abc\n    path: patches/left-pad.patch\n\nimporters:")],
  ["importer specifier changed", (l) => l.replace("specifier: ^1.0.0", "specifier: github:evil/left-pad")],
  ["an override added", (l) => l.replace("importers:", "overrides:\n  left-pad: npm:evil-pad@1.0.0\n\nimporters:")],
  ["snapshot gains a patch_hash", (l) => l.replace("  left-pad@1.0.0: {}", "  left-pad@1.0.0(patch_hash=abc): {}")],
]) {
  test(`npm pin changes when the lockfile changes: ${label}`, () => {
    const after = edit(LOCK);
    assert.notEqual(after, LOCK);
    assert.notEqual(pin(after), pin(LOCK));
  });
}

test("a lookalike package in the lockfile does not satisfy the lookup", () => {
  const lock = "packages:\n\n  left-pad-evil@1.0.0:\n    resolution: {integrity: sha512-a}\n  '@x/left-pad@1.0.0':\n    resolution: {integrity: sha512-a}\n";
  assert.throws(() => pin(lock));
});

test("an unknown @rose workspace package fails instead of being skipped", () => {
  assert.throws(() => tree({ "m.ts": 'import "@rose/nope";' }));
});

// ---- scan level, real repo ----

test("a CRLF-only rewrite of a tree file still passes the scan", () => {
  const r = run(withFile("tenancy/resolve.ts", (s) => s.replaceAll("\n", "\r\n")));
  assert.deepEqual([r.unparsed, r.ungated], [[], []]);
});

test("a comment-only edit to a transitive file fails every entry whose tree contains it, naming the file", () => {
  const r = run(withFile("ids.ts", (s) => `${s}\n// harmless?\n`));
  for (const key of Object.keys(REVIEWED_HELPERS).filter((k) => Object.hasOwn(REVIEWED_HELPERS[k], `${CORE}/ids.ts`))) {
    assert.ok(r.ungated.some((u) => u.key === `HELPER ${key}` && u.reason.includes(`${CORE}/ids.ts`)), `${key}: ${dump(r)}`);
  }
});

test("a .tsx shadow next to a helper module is unparsed", () => {
  const r = run(withExtra("tenancy/resolve.tsx", "export const resolveHost = () => ({ kind: 'root' });"));
  assert.ok(r.unparsed.some((u) => /resolve/.test(u.reason)), dump(r));
});

test("an index file that shadows a helper module directory form is unparsed", () => {
  const r = run(withExtra("tenancy/resolve/index.ts", "export const resolveHost = () => ({ kind: 'root' });"));
  assert.ok(r.unparsed.length > 0, dump(r));
});

test("a hono patch added to the lockfile fails the etag entry", () => {
  const lockfile = disk.lockfile.replace(/^importers:/m, "patchedDependencies:\n  hono@4.13.17:\n    hash: deadbeef\n    path: patches/hono.patch\n\nimporters:");
  assert.notEqual(lockfile, disk.lockfile);
  const r = run({ ...disk, lockfile });
  assert.ok(r.ungated.some((u) => u.key === "HELPER hono/etag:etag"), dump(r));
});

test("a new import of a fresh file is reported as added, naming the file", () => {
  const s = withFile("tenancy/resolve.ts", (t) => `import "./extra";\n${t}`);
  const extra = resolve(disk.srcDir, "tenancy/extra.ts");
  const r = run({ ...s, read: (p) => (p === extra ? "export {};\n" : s.read(p)) });
  assert.ok(r.ungated.some((u) => u.key === "HELPER ./tenancy/resolve:resolveHost" && u.reason.includes(`${CORE}/tenancy/extra.ts`)), dump(r));
});

// Reviewed-manifest tampering: mutate the loaded allow-list, restore after each test.
const saved = JSON.parse(JSON.stringify(REVIEWED_HELPERS));
afterEach(() => {
  for (const k of Object.keys(REVIEWED_HELPERS)) delete REVIEWED_HELPERS[k];
  Object.assign(REVIEWED_HELPERS, JSON.parse(JSON.stringify(saved)));
});
const KEY = "./tenancy/resolve:resolveHost";
const helperFail = (r) => r.ungated.find((u) => u.key === `HELPER ${KEY}`);

test("a file missing from the reviewed manifest is reported, naming it", () => {
  delete REVIEWED_HELPERS[KEY][`${CORE}/ids.ts`];
  const f = helperFail(run());
  assert.ok(f && f.reason.includes(`${CORE}/ids.ts`), dump(run()));
});

test("a reviewed file no longer in the tree is reported, naming it", () => {
  REVIEWED_HELPERS[KEY][`${CORE}/gone.ts`] = "0".repeat(32);
  const f = helperFail(run());
  assert.ok(f && f.reason.includes(`${CORE}/gone.ts`), dump(run()));
});

test("a wrong reviewed hash is reported, naming the file", () => {
  REVIEWED_HELPERS[KEY][`${CORE}/errors.ts`] = "f".repeat(32);
  const f = helperFail(run());
  assert.ok(f && f.reason.includes(`${CORE}/errors.ts`), dump(run()));
});

test("an empty reviewed manifest fails instead of passing", () => {
  REVIEWED_HELPERS[KEY] = {};
  assert.ok(helperFail(run()), dump(run()));
});

test("a missing reviewed entry fails instead of passing", () => {
  delete REVIEWED_HELPERS[KEY];
  assert.ok(helperFail(run()), dump(run()));
});

test("a reviewed builtin that is not imported fails", () => {
  REVIEWED_HELPERS[KEY]["node:child_process"] = "builtin";
  const f = helperFail(run());
  assert.ok(f && f.reason.includes("node:child_process"), dump(run()));
});
