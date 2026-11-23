// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../index";

const ORIGIN = "https://admin.rose.test";
const post = (path: string, json: unknown) =>
  SELF.fetch(ORIGIN + path, { method: "POST", redirect: "manual", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(json) });

describe("operators with a passkey can not sign in by emailed code", () => {
  it("refuses codes once a passkey is registered, even a valid one", async () => {
    const email = "root@example.com";
    // First sign-in (bootstrap or existing operator) by code works while there is no passkey.
    const first = await (await post("/api/auth/code/request", { email })).json<{ devCode?: string }>();
    const staleCode = first.devCode;
    expect(staleCode).toBeTruthy();
    const ok = await post("/api/auth/code/verify", { email, code: staleCode });
    expect(ok.status).toBe(200);

    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, 'platform', ?, 'k', ?)")
      .bind("cred-op-1", user!.id, "admin.rose.test", Date.now()).run();

    // No code is issued any more.
    const again = await (await post("/api/auth/code/request", { email })).json<{ devCode?: string }>();
    expect(again.devCode).toBeUndefined();
    // A code issued before the passkey existed is refused too.
    const late = await post("/api/auth/code/verify", { email, code: staleCode });
    expect(late.status).toBe(401);
    expect(late.headers.get("Set-Cookie")).toBeNull();
  });

  it("still sends codes when the only passkey belongs to another console host", async () => {
    const email = "moved@example.com";
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_moved', ?, 0)").bind(email).run();
    await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES ('us_moved', 'owner', 0)").run();
    await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES ('cred-old-host', 'us_moved', 'platform', 'old-admin.rose.test', 'k', ?)").bind(Date.now()).run();

    const { devCode } = await (await post("/api/auth/code/request", { email })).json<{ devCode?: string }>();
    expect(devCode).toBeTruthy();
    expect((await post("/api/auth/code/verify", { email, code: devCode })).status).toBe(200);
  });

  it("refuses sign-in on any host but the configured console host, so a second host can not bypass the passkey", async () => {
    const email = "second-host@example.com";
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_second', ?, 0)").bind(email).run();
    await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES ('us_second', 'owner', 0)").run();
    await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES ('cred-console', 'us_second', 'platform', 'admin.rose.test', 'k', ?)").bind(Date.now()).run();

    const prod = { ...env, ENVIRONMENT: "production", ADMIN_HOST: "admin.rose.test", RL_AUTH: { limit: () => Promise.resolve({ success: true }) } } as never;
    const request = async (origin: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(origin + "/api/auth/code/request", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email }) }), prod, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    for (const other of ["https://other-admin.rose.test", "https://admin.rose.test.evil.example"]) {
      const res = await request(other);
      expect(res.status, other).toBe(404);
      expect(await res.text()).not.toContain("devCode");
    }
    expect((await request(ORIGIN)).status).toBe(200);
  });

  it("fails closed in production when ADMIN_HOST is not configured", async () => {
    const ctx = createExecutionContext();
    const prod = { ...env, ENVIRONMENT: "production", ADMIN_HOST: undefined, RL_AUTH: { limit: () => Promise.resolve({ success: true }) } } as never;
    const res = await worker.fetch(new Request(ORIGIN + "/api/auth/code/request", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email: "root@example.com" }) }), prod, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });
});
