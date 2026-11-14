// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
const post = (path: string, json: unknown) =>
  SELF.fetch(ORIGIN + path, { method: "POST", redirect: "manual", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(json) });

describe("operators with a passkey can not sign in by emailed code", () => {
  it("refuses codes once a passkey is registered, even a valid one", async () => {
    const email = "root@example.com";
    // First sign-in (bootstrap or existing operator) by code works while there is no passkey.
    const first = (await (await post("/api/auth/code/request", { email })).json()) as { devCode?: string };
    const staleCode = first.devCode;
    expect(staleCode).toBeTruthy();
    const ok = await post("/api/auth/code/verify", { email, code: staleCode });
    expect(ok.status).toBe(200);

    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, 'platform', ?, 'k', ?)")
      .bind("cred-op-1", user!.id, "admin.rose.test", Date.now()).run();

    // No code is issued any more.
    const again = (await (await post("/api/auth/code/request", { email })).json()) as { devCode?: string };
    expect(again.devCode).toBeUndefined();
    // A code issued before the passkey existed is refused too.
    const late = await post("/api/auth/code/verify", { email, code: staleCode });
    expect(late.status).toBe(401);
    expect(late.headers.get("Set-Cookie")).toBeNull();
  });
});
