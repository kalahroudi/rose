// SPDX-License-Identifier: Apache-2.0
// Run: node --test "examples/upstream-service/*.test.mjs"
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker, { verifyRoseToken } from "./worker.js";

const SECRET = "example-signing-secret-example-signing-secret";
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims, { secret = SECRET, alg = "HS256" } = {}) {
  const head = enc({ alg, typ: "JWT" });
  const body = enc(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (over = {}) => ({ iss: "rose", aud: "upstream", iat: now(), exp: now() + 60, tid: "tn_a", tslug: "acme", sub: "us_1", sub_type: "user", role: "admin", ...over });

test("accepts a token signed by Rose", async () => {
  assert.equal((await verifyRoseToken(sign(good()), SECRET)).tid, "tn_a");
});

test("rejects forged, expired, mis-addressed and alg-swapped tokens", async () => {
  assert.equal(await verifyRoseToken(sign(good(), { secret: "x".repeat(40) }), SECRET), null);
  assert.equal(await verifyRoseToken(sign(good({ exp: now() - 1 })), SECRET), null);
  assert.equal(await verifyRoseToken(sign(good({ aud: "other" })), SECRET), null);
  assert.equal(await verifyRoseToken(sign(good({ tid: "" })), SECRET), null);
  assert.equal(await verifyRoseToken(sign(good(), { alg: "none" }), SECRET), null);
  const [h, , s] = sign(good()).split(".");
  assert.equal(await verifyRoseToken(`${h}.${enc(good({ tid: "tn_b" }))}.${s}`, SECRET), null, "payload swapped after signing");
  assert.equal(await verifyRoseToken("", SECRET), null);
  assert.equal(await verifyRoseToken("a.b", SECRET), null);
});

test("data is scoped by the verified tenant only", async () => {
  const env = { UPSTREAM_SIGNING_SECRET: SECRET };
  const call = (claims, path, init = {}) => worker.fetch(new Request(`https://upstream${path}`, { ...init, headers: { "X-Rose-Tenant-Token": sign(claims), "X-Rose-Tenant-Id": "tn_b", "Content-Type": "application/json" } }), env);
  assert.equal((await call(good(), "/orders", { method: "POST", body: JSON.stringify({ item: "widget" }) })).status, 201);
  assert.equal((await (await call(good(), "/orders")).json()).orders.length, 1);
  assert.equal((await (await call(good({ tid: "tn_b", tslug: "globex" }), "/orders")).json()).orders.length, 0);
  assert.equal((await call(good({ role: "member" }), "/orders", { method: "POST", body: JSON.stringify({ item: "x" }) })).status, 403);
  assert.equal((await worker.fetch(new Request("https://upstream/orders"), env)).status, 401);
});
