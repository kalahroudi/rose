// SPDX-License-Identifier: Apache-2.0
// Adversarial cases for the `deployment-values` guard rule and the committed wrangler configs.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { checkFile } from "./guard.mjs";

const flagged = (file, body) => checkFile(file, body).violations.some((v) => v.rule === "deployment-values");
const APP = "apps/app/wrangler.jsonc";

test("deployment-values: committed wrangler.jsonc files are placeholders only", () => {
  for (const f of [APP, "apps/admin/wrangler.jsonc"]) {
    const v = checkFile(f, readFileSync(f, "utf8")).violations.filter((x) => x.rule === "deployment-values");
    assert.deepEqual(v, [], f);
  }
});

test("deployment-values: lookalike hosts are not accepted as example.com", () => {
  for (const host of ["evilexample.com", "example.com.evil.io", "notexample.com", "example.co", "admin.example.com.attacker.dev", "xn--exmple-cua.com"]) {
    assert.ok(flagged(APP, `{\n  "APP_BASE_DOMAIN": "${host}"\n}`), host);
    assert.ok(flagged(APP, `{\n  "routes": [{ "pattern": "${host}/*", "zone_name": "${host}" }]\n}`), host);
  }
});

test("deployment-values: real mailboxes are rejected in every address var", () => {
  for (const v of ['"BOOTSTRAP_OPERATOR_EMAIL": "mo@acme-mail.dev"', '"EMAIL_FROM": "Rose <no-reply@update.acme-corp.dev>"', '"BOOTSTRAP_OPERATOR_EMAIL": "a@b.io"']) {
    assert.ok(flagged("apps/admin/wrangler.jsonc", `{\n  ${v}\n}`), v);
  }
});

test("deployment-values: database ids that merely resemble the placeholder are rejected", () => {
  for (const id of ["00000000-0000-0000-0000-000000000001", "0000000000000000000000000000000", "", " 00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000x"]) {
    assert.ok(flagged(APP, `{\n  "database_id": "${id}"\n}`), JSON.stringify(id));
  }
});

test("deployment-values: a real value after a placeholder on the same line is still caught", () => {
  assert.ok(flagged(APP, '{\n  "routes": [{ "pattern": "example.com/*", "zone_name": "example.com" }, { "pattern": "acme.io/*", "zone_name": "acme.io" }]\n}'));
});

test("deployment-values: a real value hidden in a comment does not hide the one in code, and comments are not flagged", () => {
  assert.deepEqual(checkFile(APP, '{\n  // "APP_BASE_DOMAIN": "acme.io"\n  "name": "x"\n}').violations.filter((v) => v.rule === "deployment-values"), []);
  assert.ok(flagged(APP, '{\n  /* ok */ "APP_BASE_DOMAIN": "acme.io"\n}'));
});

test("deployment-values: other apps' configs and nested paths follow the same rule", () => {
  assert.ok(flagged("apps/other/wrangler.jsonc", '{\n  "APP_BASE_DOMAIN": "acme.io"\n}'));
  assert.ok(!flagged("apps/app/wrangler.production.jsonc", '{\n  "APP_BASE_DOMAIN": "acme.io"\n}'));
  assert.ok(!flagged("apps/app/wrangler.dev.jsonc", '{\n  "APP_BASE_DOMAIN": "acme.io"\n}'));
});

test("deployment-values: a value split from its key across lines is still caught", () => {
  // Known weak spot of a per-line regex: report rather than silently pass.
  assert.ok(flagged(APP, '{\n  "APP_BASE_DOMAIN":\n    "acme.io"\n}'));
});

test("git-ignore keeps wrangler.production.jsonc out of the repo", () => {
  assert.match(readFileSync(".gitignore", "utf8"), /^wrangler\.production\.jsonc$/m);
});
