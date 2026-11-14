// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
const EMAIL = "root@example.com";
const post = (path: string, json: unknown) =>
  SELF.fetch(ORIGIN + path, { method: "POST", redirect: "manual", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(json) });
const body = async <T>(r: Response) => (await r.json()) as T;
const strip = (j: unknown) => JSON.parse(JSON.stringify(j).replace(/"requestId":"[^"]*"/, "\"requestId\":\"-\""));
const codeFor = async (email: string) => (await body<{ devCode?: string }>(await post("/api/auth/code/request", { email }))).devCode;

async function addPasskey(email: string, scope: string, cred: string) {
  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, ?, 'admin.rose.test', 'k', ?)")
    .bind(cred, u!.id, scope, Date.now()).run();
}
const clearPasskeys = () => env.DB.prepare("DELETE FROM passkeys").run();

describe("operator passkey enforcement: edge cases", () => {
  it("a passkey in another scope does not lock codes; one in this scope does; removing it restores codes", async () => {
    const code = await codeFor(EMAIL);
    expect(code).toBeTruthy();
    expect((await post("/api/auth/code/verify", { email: EMAIL, code })).status).toBe(200);

    await addPasskey(EMAIL, "tenant", "cred-other-scope");
    expect(await codeFor(EMAIL)).toBeTruthy();

    await addPasskey(EMAIL, "platform", "cred-this-scope");
    expect(await codeFor(EMAIL)).toBeUndefined();

    await clearPasskeys();
    const again = await codeFor(EMAIL);
    expect(again).toBeTruthy();
    expect((await post("/api/auth/code/verify", { email: EMAIL, code: again })).status).toBe(200);
  });

  it("email case and whitespace variants do not bypass the block", async () => {
    await addPasskey(EMAIL, "platform", "cred-case");
    for (const variant of ["ROOT@example.com", "Root@Example.Com", " root@example.com "]) {
      expect(await codeFor(variant), variant).toBeUndefined();
      const r = await post("/api/auth/code/verify", { email: variant, code: "000000" });
      expect(r.status, variant).toBe(401);
      expect(r.headers.get("Set-Cookie"), variant).toBeNull();
    }
  });

  it("a blocked operator looks the same as a stranger (no passkey oracle)", async () => {
    const blocked = await post("/api/auth/code/request", { email: EMAIL });
    const stranger = await post("/api/auth/code/request", { email: "nobody@example.org" });
    expect(blocked.status).toBe(stranger.status);
    expect(await blocked.json()).toEqual(await stranger.json());
    const a = await post("/api/auth/code/verify", { email: EMAIL, code: "123456" });
    const b = await post("/api/auth/code/verify", { email: "nobody@example.org", code: "123456" });
    expect(a.status).toBe(b.status);
    expect(strip(await a.json())).toEqual(strip(await b.json()));
  });

  it("malformed input never yields a session", async () => {
    for (const payload of [{}, { email: 1 }, { email: EMAIL }, { email: EMAIL, code: "12345" }, { email: EMAIL, code: ["000000"] }, { email: "x".repeat(300), code: "000000" }]) {
      const r = await post("/api/auth/code/verify", payload);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.headers.get("Set-Cookie")).toBeNull();
    }
  });
});
