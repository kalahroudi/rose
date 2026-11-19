// SPDX-License-Identifier: Apache-2.0
// AUTHZ-07 pins every file in the import tree of the helpers the pre-auth middleware calls (whole-file hashes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, HELPER_MAX_BYTES, HELPER_MAX_FILES, REVIEWED_HELPERS, diskSources, scan } from "./route-authz-scan.mjs";

const disk = diskSources();
const tenantApp = disk.read(resolve(disk.srcDir, "tenant-app.ts"));
const run = (sources = disk, src = tenantApp) => scan(src, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, sources);
const withFile = (rel, edit) => {
  const path = resolve(disk.srcDir, rel);
  const before = disk.read(path);
  const after = edit(before);
  assert.notEqual(after, before, `the edit to ${rel} changed nothing`);
  return { ...disk, read: (p) => (p === path ? after : disk.read(p)) };
};
const clean = (r) => [r.unparsed, r.ungated, r.stalePublic];

test("the unmodified repo passes with every helper reviewed", () => {
  assert.deepEqual(clean(run()), [[], [], []]);
});

test("every helper the pre-auth middleware uses has a reviewed entry", () => {
  assert.deepEqual(Object.keys(REVIEWED_HELPERS).sort(), ["./env:assertEnvironment", "./http/base:csrfGuard", "./http/base:requestContext", "./tenancy/resolve:hostnameOf", "./tenancy/resolve:resolveHost", "hono/etag:etag"]);
});

const MUTATIONS = [
  ["csrfGuard answers the request", "http/base.ts", (s) => s.replace('if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();', 'if (m === "GET") return c.json({ leak: 1 });'), "./http/base:csrfGuard"],
  ["requestContext answers the request", "http/base.ts", (s) => s.replace('c.set("requestId", newId("req"));', 'return c.json({ leak: 1 });'), "./http/base:requestContext"],
  ["a module-level constant requestContext uses", "http/base.ts", (s) => s.replace("frame-ancestors 'none'", "frame-ancestors *"), "./http/base:requestContext"],
  ["a helper csrfGuard calls in another module", "errors.ts", (s) => s.replace('new AppError(403, "forbidden", message)', 'new AppError(200, "forbidden", message)'), "./http/base:csrfGuard"],
  ["assertEnvironment never throws", "env.ts", (s) => s.replace("if (v !== \"development\" && v !== \"production\") throw new EnvironmentMisconfigured();", ""), "./env:assertEnvironment"],
  ["resolveHost trusts another host", "tenancy/resolve.ts", (s) => s.replace("if (hostname === base) return { kind: \"root\" };", "if (hostname !== base) return { kind: \"root\" };"), "./tenancy/resolve:resolveHost"],
  ["hostnameOf reads a header", "tenancy/resolve.ts", (s) => s.replace("new URL(request.url).hostname.toLowerCase()", "request.headers.get(\"x-host\") ?? \"\""), "./tenancy/resolve:hostnameOf"],
];
for (const [label, file, edit, key] of MUTATIONS) {
  test(`mutating a helper fails the scan: ${label}`, () => {
    const r = run(withFile(file, edit));
    assert.ok(r.ungated.some((u) => u.key === `HELPER ${key}`), JSON.stringify(clean(r)));
  });
}

test("bumping hono in the lockfile fails the scan", () => {
  const lockfile = disk.lockfile.replaceAll("hono@4.13.17", "hono@4.13.18");
  assert.notEqual(lockfile, disk.lockfile);
  const r = run({ ...disk, lockfile });
  assert.ok(r.ungated.some((u) => u.key === "HELPER hono/etag:etag"));
});

test("lookups that find nothing fail instead of passing", () => {
  const missing = (r, re) => assert.ok(r.unparsed.some((u) => re.test(u.reason)), JSON.stringify(clean(r)));
  missing(run({ ...disk, lockfile: null }), /pnpm-lock\.yaml/);
  missing(run({ ...disk, lockfile: "lockfileVersion: '9.0'\n" }), /0 versions of `hono`/);
  missing(run({ ...disk, read: (p) => (p.endsWith("tenancy/resolve.ts") ? null : disk.read(p)) }), /resolves to 0 files/);
});

test("a statement right after an unreached function declaration is fingerprinted", () => {
  const r = run(withFile("tenancy/resolve.ts", (s) => s.replace(/(function invalidateHostCache[^]*?\n}\n)/, '$1cache.set("evil.example", { value: { kind: "root" }, expires: Infinity });\n')));
  assert.ok(r.ungated.some((u) => u.key === "HELPER ./tenancy/resolve:resolveHost"), JSON.stringify(clean(r)));
});

test("a patched or re-pointed hono in the lockfile fails the scan", () => {
  for (const edit of [
    (s) => s.replace("hono@4.13.17:\n    resolution: {integrity: sha512-", "hono@4.13.17:\n    resolution: {integrity: sha512-X"),
    (s) => s.replace("  hono@4.13.17: {}", "  hono@4.13.17(patch_hash=abc): {}"),
    (s) => s.replace("hono:\n        specifier: ^4.13.0\n        version: 4.13.17", "hono:\n        specifier: ^4.13.0\n        version: npm:evil-hono@1.0.0"),
  ]) {
    const lockfile = edit(disk.lockfile);
    assert.notEqual(lockfile, disk.lockfile);
    assert.ok(run({ ...disk, lockfile }).ungated.some((u) => u.key === "HELPER hono/etag:etag"));
  }
});

test("a same-named .tsx or .js file beside a helper module is ambiguous and unparsed", () => {
  for (const ext of ["tsx", "js"]) {
    const path = resolve(disk.srcDir, `http/base.${ext}`);
    const r = run({ ...disk, read: (p) => (p === path ? "export {};\n" : disk.read(p)) });
    assert.ok(r.unparsed.length > 0, `${ext}: ${JSON.stringify(clean(r))}`);
  }
});

test("docs/pentest.md quotes the caps the scan enforces", () => {
  const doc = readFileSync(resolve(disk.srcDir, "../../../docs/pentest.md"), "utf8");
  assert.ok(doc.includes(`\`HELPER_MAX_FILES\` = ${HELPER_MAX_FILES} files`));
  assert.ok(doc.includes(`\`HELPER_MAX_BYTES\` = ${HELPER_MAX_BYTES} bytes`));
});
