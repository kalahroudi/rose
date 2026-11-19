// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for M6: AUTHZ-07 pins the bodies of the helpers pre-auth middleware calls (relative imports
// followed recursively with a cap, packages pinned to their pnpm-lock.yaml version). Missing lookups must fail.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { CORE_EXEMPTIONS, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, PUBLIC_CORE_ROUTES, REVIEWED_HELPERS, diskSources, scan } from "./route-authz-scan.mjs";

const disk = diskSources();
const tenantApp = disk.read(resolve(disk.srcDir, "tenant-app.ts"));
const run = (sources = disk) => scan(tenantApp, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE, sources);
const show = (r) => JSON.stringify({ unparsed: r.unparsed, ungated: r.ungated, stalePublic: r.stalePublic });
const fails = (r) => r.ungated.length + r.unparsed.length > 0;
const isClean = (r) => r.ungated.length === 0 && r.unparsed.length === 0 && r.stalePublic.length === 0;

/** Sources where some files (relative to packages/core/src) are replaced or added; `null` removes one. */
const withFiles = (files) => {
  const over = new Map(Object.entries(files).map(([rel, v]) => [resolve(disk.srcDir, rel), v]));
  return { ...disk, read: (p) => (over.has(p) ? over.get(p) : disk.read(p)) };
};
const edit = (rel, fn) => {
  const before = disk.read(resolve(disk.srcDir, rel));
  const after = fn(before);
  assert.notEqual(after, before, `edit to ${rel} changed nothing`);
  return after;
};

test("scan() without the sixth argument reads this checkout and passes (the pentest call shape)", () => {
  const r = scan(tenantApp, CORE_EXEMPTIONS, PUBLIC_CORE_ROUTES, OUTSIDE_SCOPE_ROUTES, PUBLIC_CORE_MIDDLEWARE);
  assert.ok(isClean(r), show(r));
});

// ── Behaviour changes in code a helper reaches transitively ──

test("changing newId (called by requestContext from ../ids) fails the scan", () => {
  const r = run(withFiles({ "ids.ts": edit("ids.ts", (s) => s.replace("new Uint8Array(12)", "new Uint8Array(1)")) }));
  assert.ok(fails(r), show(r));
});

test("changing the AppError class body (reached by csrfGuard via forbidden) fails the scan", () => {
  const r = run(withFiles({ "errors.ts": edit("errors.ts", (s) => s.replace("    super(message);\n", "    super(message);\n    (this as { status: number }).status = 200;\n")) }));
  assert.ok(fails(r), show(r));
});

test("changing EnvironmentMisconfigured (declared after assertEnvironment, same module) fails the scan", () => {
  const r = run(withFiles({ "env.ts": edit("env.ts", (s) => s.replace("\nclass EnvironmentMisconfigured extends Error {", "\nclass EnvironmentMisconfigured extends Error {\n  override name = \"ok\";")) }));
  assert.ok(fails(r), show(r));
});

test("changing a module constant resolveHost uses (HOST_CACHE_TTL_MS) fails the scan", () => {
  const r = run(withFiles({ "tenancy/resolve.ts": edit("tenancy/resolve.ts", (s) => s.replace("HOST_CACHE_TTL_MS = 5_000", "HOST_CACHE_TTL_MS = 5_000_000")) }));
  assert.ok(fails(r), show(r));
});

test("re-pointing a helper's own import to another export (aliased) fails the scan", () => {
  const ids = edit("ids.ts", (s) => `${s}\nexport function fixedId(prefix: string): string {\n  return \`\${prefix}_0\`;\n}\n`);
  const base = edit("http/base.ts", (s) => s.replace('import { newId } from "../ids";', 'import { fixedId as newId } from "../ids";'));
  const r = run(withFiles({ "ids.ts": ids, "http/base.ts": base }));
  assert.ok(fails(r), show(r));
});

test("a top-level statement in the helper's module that changes what resolveHost answers fails the scan", () => {
  // resolveHost's own tokens are untouched; a module-level statement seeds its cache so every host maps to a tenant.
  const r = run(withFiles({
    "tenancy/resolve.ts": edit("tenancy/resolve.ts", (s) => s.replace(
      "const cache = new Map<string, { value: HostResolution; expires: number }>();\n",
      "const cache = new Map<string, { value: HostResolution; expires: number }>();\ncache.set(\"evil.example\", { value: { kind: \"tenant\", tenant: { id: \"t1\" } as TenantRow }, expires: Infinity });\n",
    )),
  }));
  assert.ok(fails(r), show(r));
});

test("a top-level statement in a transitively reached module (errors.ts) that changes AppError fails the scan", () => {
  const r = run(withFiles({
    "errors.ts": edit("errors.ts", (s) => `${s}\nObject.defineProperty(AppError.prototype, "status", { get: () => 200, set: () => {} });\n`),
  }));
  assert.ok(fails(r), show(r));
});

// ── Whole-file pin (M6 redesign): any edit to a file in a helper's import tree fails until re-reviewed ──

test("comment and whitespace edits inside a helper body fail the scan (whole-file pin)", () => {
  const base = edit("http/base.ts", (s) => s.replace("  const m = c.req.method;\n", "  // reviewed\n  const   m =   c.req.method ;\n"));
  const r = run(withFiles({ "http/base.ts": base }));
  assert.ok(fails(r), show(r));
});

test("editing a declaration no pre-auth helper calls (randomDigits in ids.ts) fails the scan (whole-file pin)", () => {
  const r = run(withFiles({ "ids.ts": edit("ids.ts", (s) => s.replace("if (b < 250)", "if (b < 200)")) }));
  assert.ok(fails(r), show(r));
});

// ── Lockfile pinning ──

test("two locked versions of hono is not a pin: the scan fails", () => {
  const lockfile = disk.lockfile.replace("  hono@4.13.17: {}", "  hono@4.13.17: {}\n\n  hono@4.14.0: {}");
  assert.notEqual(lockfile, disk.lockfile);
  const r = run({ ...disk, lockfile });
  assert.ok(r.unparsed.length > 0 || r.ungated.some((u) => /hono/.test(u.key)), show(r));
});

test("a similarly named package in the lockfile does not count as hono", () => {
  const lockfile = disk.lockfile.replace("  hono@4.13.17: {}", "  hono@4.13.17: {}\n\n  hono-extra@9.9.9: {}\n\n  '@hono/x@1.0.0': {}");
  const r = run({ ...disk, lockfile });
  assert.ok(isClean(r), show(r));
});

test("hono present only as a differently named package fails (no loose match)", () => {
  const lockfile = disk.lockfile.replaceAll("hono@4.13.17", "honox@4.13.17");
  const r = run({ ...disk, lockfile });
  assert.ok(fails(r), show(r));
});

// ── Missing / ambiguous lookups fail closed ──

test("an import of a helper that resolves to two files (x.ts and x/index.ts) fails", () => {
  const r = run(withFiles({ "ids/index.ts": "export function newId(p: string): string { return p; }\n" }));
  assert.ok(fails(r), show(r));
});

test("a helper module that is missing entirely fails", () => {
  const r = run(withFiles({ "ids.ts": null }));
  assert.ok(r.unparsed.length > 0, show(r));
});

test("an export removed from a module a helper imports from fails", () => {
  const r = run(withFiles({ "ids.ts": edit("ids.ts", (s) => s.replace("export function newId", "function newId")) }));
  assert.ok(fails(r), show(r));
});

test("a named middleware with no REVIEWED_HELPERS entry fails", () => {
  const key = "./http/base:csrfGuard";
  const saved = REVIEWED_HELPERS[key];
  delete REVIEWED_HELPERS[key];
  try {
    const r = run();
    assert.ok(fails(r), show(r));
  } finally {
    REVIEWED_HELPERS[key] = saved;
  }
});

test("the hono entry with no REVIEWED_HELPERS entry fails", () => {
  const key = "hono/etag:etag";
  const saved = REVIEWED_HELPERS[key];
  delete REVIEWED_HELPERS[key];
  try {
    const r = run();
    assert.ok(fails(r), show(r));
  } finally {
    REVIEWED_HELPERS[key] = saved;
  }
});

// ── Caps and cycles ──

const chainFiles = (n) => {
  const files = {};
  for (let k = 1; k <= n; k++) {
    files[`tenancy/d${k}.ts`] = k < n
      ? `import { d${k + 1} } from "./d${k + 1}";\nexport function d${k}(r: Request): string {\n  return d${k + 1}(r);\n}\n`
      : `export function d${k}(r: Request): string {\n  return new URL(r.url).hostname;\n}\n`;
  }
  files["tenancy/resolve.ts"] = edit("tenancy/resolve.ts", (s) => s
    .replace('import type { TenantRow } from "../control/tenants";', 'import type { TenantRow } from "../control/tenants";\nimport { d1 } from "./d1";')
    .replace("return new URL(request.url).hostname.toLowerCase();", "return d1(request).toLowerCase();"));
  return files;
};

// The file/byte caps of the whole-file pin are tested at the exact boundary in route-authz-scan.wholefile.adversarial.test.mjs.

test("a short relative-import chain is followed (fails as changed, not as unreadable)", () => {
  const r = run(withFiles(chainFiles(3)));
  assert.ok(r.ungated.length > 0, show(r));
  assert.equal(r.unparsed.length, 0, show(r));
});

test("a cycle between relative modules terminates and still fails the changed helper", () => {
  const files = {
    "tenancy/ca.ts": 'import { cb } from "./cb";\nexport function ca(r: Request): string {\n  return r.url ? cb(r) : "";\n}\n',
    "tenancy/cb.ts": 'import { ca } from "./ca";\nexport function cb(r: Request): string {\n  return r.method ? ca(r) : new URL(r.url).hostname;\n}\n',
    "tenancy/resolve.ts": edit("tenancy/resolve.ts", (s) => s
      .replace('import type { TenantRow } from "../control/tenants";', 'import type { TenantRow } from "../control/tenants";\nimport { ca } from "./ca";')
      .replace("return new URL(request.url).hostname.toLowerCase();", "return ca(request).toLowerCase();")),
  };
  const r = run(withFiles(files));
  assert.ok(fails(r), show(r));
});
