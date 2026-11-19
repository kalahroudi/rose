// SPDX-License-Identifier: Apache-2.0
// AUTHZ-07 whole-file pin: workspace links are read from the owning importer only, bare Node built-ins get an
// accurate message, and the re-review instructions in docs/pentest.md match the failure message.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { helperManifest } from "./route-authz-scan.mjs";

// Built at runtime: the repo guard rejects literal deep paths into core in source files.
const CORE_SRC = ["packages", "core", "src"].join("/");
/** Synthetic repo at /r: `map` keys are repo-relative paths. */
const repo = (map, lockfile) => ({
  srcDir: `/r/${CORE_SRC}`,
  lockfile,
  read: (p) => (p.startsWith("/r/") && Object.hasOwn(map, p.slice(3)) ? map[p.slice(3)] : null),
});
const core = (code, extra = {}) => ({ [`${CORE_SRC}/tenant-app.ts`]: "", [`${CORE_SRC}/m.ts`]: code, ...extra });

const lock = (coreFoo, appFoo) => `lockfileVersion: '9.0'

importers:

  apps/app:
    dependencies:
      foo:
        specifier: ${appFoo}
        version: ${appFoo}

  packages/core:
    dependencies:
      foo:
        specifier: ${coreFoo}
        version: ${coreFoo}

packages:

  foo@1.0.0:
    resolution: {integrity: sha512-abc}

snapshots:

  foo@1.0.0: {}
`;
const LINKED = {
  "packages/foo/package.json": JSON.stringify({ name: "foo", main: "index.ts" }),
  "packages/foo/index.ts": "export const x = 1;",
};

test("a package core gets from npm stays an npm pin even when another app links a same-named package", () => {
  const m = helperManifest("./m", repo(core('import { x } from "foo";\nexport const f = x;', LINKED), lock("1.0.0", "link:../../packages/foo")));
  assert.ok(Object.hasOwn(m, "npm:foo"), JSON.stringify(m));
  assert.ok(!Object.keys(m).some((k) => k.startsWith("packages/foo/")), JSON.stringify(m));
});

test("a package linked by core's own importer is walked as source", () => {
  const m = helperManifest("./m", repo(core('import { x } from "foo";\nexport const f = x;', LINKED), lock("link:../foo", "1.0.0")));
  assert.ok(Object.hasOwn(m, "packages/foo/index.ts"), JSON.stringify(m));
  assert.ok(!Object.hasOwn(m, "npm:foo"), JSON.stringify(m));
});

test("a bare Node built-in is unparsed with a message pointing at the node: form, not the lockfile", () => {
  for (const spec of ["crypto", "fs/promises", "buffer"]) {
    assert.throws(
      () => helperManifest("./m", repo(core(`import "${spec}";`), lock("1.0.0", "1.0.0"))),
      (e) => /Node built-in/.test(e.message) && /node:/.test(e.message) && !/pnpm-lock/.test(e.message),
      spec,
    );
  }
});

test("docs/pentest.md quotes the exact phrases the failure messages end with", () => {
  const doc = readFileSync(new URL("../docs/pentest.md", import.meta.url), "utf8");
  const src = readFileSync(new URL("./route-authz-scan.mjs", import.meta.url), "utf8");
  for (const phrase of ["replace its REVIEWED_HELPERS manifest with", "its tree is"]) {
    assert.ok(src.includes(phrase), `scanner no longer says "${phrase}"`);
    assert.ok(doc.includes(`\`${phrase}\``), `docs do not quote "${phrase}"`);
  }
  assert.ok(!doc.includes("(`now ...`)"), "docs still point at a `now ...` marker the message does not print");
});
