// SPDX-License-Identifier: Apache-2.0
// Adversarial tests: a stale owner/admin session must not be able to mint lasting admin
// access (admin API key, admin invitation, promotion to admin) without a fresh sign-in.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession, FRESH_SIGN_IN_MS } from "../src/control/sessions";
import { addMembership, ensureUser } from "../src/control/users";
import { createTestTenant, type TestTenant } from "../src/testing";

const code = async (r: Response) => ((await r.clone().json()) as { error?: { code: string } }).error?.code;

async function sessionFor(t: TestTenant, userId: string, method: string, ageMs = 0) {
  const { token } = await createSession(env.DB, { userId, scope: t.id, method });
  if (ageMs) {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE id_hash = ?").bind(ageMs, hash).run();
  }
  return `__Host-rose_session=${token}`;
}

async function addUser(t: TestTenant, role: "owner" | "admin" | "member") {
  const u = await ensureUser(env.DB, `${role}-${crypto.randomUUID().slice(0, 8)}@${t.slug}.example`);
  await addMembership(env.DB, t.id, u.id, role);
  return u;
}

const STALE = 11 * 60_000;

describe("stale session cannot mint admin access", () => {
  it("stale owner: admin invitation refused, nothing persisted, nothing audited", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = await sessionFor(a, a.userId, "code", STALE);
    const email = `stale-inv-${crypto.randomUUID().slice(0, 8)}@x.example`;
    const r = await a.fetch("/api/invitations", { cookie: stale, body: { email, role: "admin" } });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("reauth_required");
    expect(await (await a.fetch("/api/invitations")).text()).not.toContain(email);
    expect(await (await a.fetch("/api/audit")).text()).not.toContain(email);
  });

  it("stale owner: admin API key refused and no key is created", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = await sessionFor(a, a.userId, "code", STALE);
    const r = await a.fetch("/api/api-keys", { cookie: stale, body: { name: "stale-admin-key", role: "admin" } });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("reauth_required");
    expect(await r.text()).not.toMatch(/"key"/);
    expect(await (await a.fetch("/api/api-keys")).text()).not.toContain("stale-admin-key");
  });

  it("stale admin (not owner) is also refused for admin invite and admin key", async () => {
    const a = await createTestTenant(env, SELF);
    const admin = await addUser(a, "admin");
    const stale = await sessionFor(a, admin.id, "code", STALE);
    const inv = await a.fetch("/api/invitations", { cookie: stale, body: { email: "x-admin@x.example", role: "admin" } });
    expect(inv.status).toBe(403);
    expect(await code(inv)).toBe("reauth_required");
    const key = await a.fetch("/api/api-keys", { cookie: stale, body: { name: "k", role: "admin" } });
    expect(key.status).toBe(403);
    expect(await code(key)).toBe("reauth_required");
  });

  it("stale session at exactly the freshness boundary is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = await sessionFor(a, a.userId, "code", FRESH_SIGN_IN_MS + 1000);
    expect((await a.fetch("/api/api-keys", { cookie: stale, body: { name: "edge", role: "admin" } })).status).toBe(403);
    expect((await a.fetch("/api/invitations", { cookie: stale, body: { email: "edge@x.example", role: "admin" } })).status).toBe(403);
  });

  it("stale session promoting a member to admin is refused and role unchanged", async () => {
    const a = await createTestTenant(env, SELF);
    const member = await addUser(a, "member");
    const stale = await sessionFor(a, a.userId, "code", STALE);
    const r = await a.fetch(`/api/members/${member.id}`, { method: "PATCH", cookie: stale, body: { role: "admin" } });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("reauth_required");
    const row = await env.DB.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?").bind(a.id, member.id).first<{ role: string }>();
    expect(row!.role).toBe("member");
  });

  it("an admin API key cannot be used to invite an admin or mint an admin key", async () => {
    const a = await createTestTenant(env, SELF);
    const key = ((await (await a.fetch("/api/api-keys", { body: { name: "ci", role: "admin" } })).json()) as { key: string }).key;
    const auth = { Authorization: `Bearer ${key}` };
    expect((await a.fetch("/api/invitations", { cookie: null, headers: auth, body: { email: "via-key@x.example", role: "admin" } })).status).toBe(403);
    expect((await a.fetch("/api/api-keys", { cookie: null, headers: auth, body: { name: "chain", role: "admin" } })).status).toBe(403);
  });
});

describe("no regression for ordinary, non-escalating actions", () => {
  it("stale session can still invite a member and create a member key (explicit and default role)", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = await sessionFor(a, a.userId, "code", STALE);
    expect((await a.fetch("/api/invitations", { cookie: stale, body: { email: "m1@x.example", role: "member" } })).status).toBe(201);
    expect((await a.fetch("/api/invitations", { cookie: stale, body: { email: "m2@x.example" } })).status).toBe(201);
    expect((await a.fetch("/api/api-keys", { cookie: stale, body: { name: "m", role: "member" } })).status).toBe(201);
    const def = await a.fetch("/api/api-keys", { cookie: stale, body: { name: "d" } });
    expect(def.status).toBe(201);
    expect(((await def.json()) as { item: { role: string } }).item.role).toBe("member");
  });

  it("fresh email-code session may mint admin key/invite even when the owner has a passkey", async () => {
    const a = await createTestTenant(env, SELF);
    await env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, ?, ?, 'k', ?)").bind(`cred-${crypto.randomUUID()}`, a.userId, a.id, a.host, Date.now()).run();
    const fresh = await sessionFor(a, a.userId, "code");
    expect((await a.fetch("/api/api-keys", { cookie: fresh, body: { name: "fresh-admin", role: "admin" } })).status).toBe(201);
    expect((await a.fetch("/api/invitations", { cookie: fresh, body: { email: "fa@x.example", role: "admin" } })).status).toBe(201);
    const member = await addUser(a, "member");
    expect((await a.fetch(`/api/members/${member.id}`, { method: "PATCH", cookie: fresh, body: { role: "admin" } })).status).toBe(200);
  });

  it("stale session can still demote an admin to member (reducing access)", async () => {
    const a = await createTestTenant(env, SELF);
    const admin = await addUser(a, "admin");
    const stale = await sessionFor(a, a.userId, "code", STALE);
    expect((await a.fetch(`/api/members/${admin.id}`, { method: "PATCH", cookie: stale, body: { role: "member" } })).status).toBe(200);
  });

  it("role values with odd casing are rejected by validation, not silently treated as member", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = await sessionFor(a, a.userId, "code", STALE);
    for (const role of ["Admin", "ADMIN", " admin"]) {
      expect((await a.fetch("/api/invitations", { cookie: stale, body: { email: "c@x.example", role } })).status, role).toBe(422);
      expect((await a.fetch("/api/api-keys", { cookie: stale, body: { name: "c", role } })).status, role).toBe(422);
    }
  });
});
