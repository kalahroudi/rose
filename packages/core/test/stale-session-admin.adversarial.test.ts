// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for stale owner/admin sessions minting admin API keys or inviting admins.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant } from "../src/testing";
import { createSession } from "../src/control/sessions";

const tenantRow = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const code = async (r: Response) => ((await r.clone().json()) as { error?: { code: string } }).error?.code;

describe("stale owner/admin session cannot mint an admin API key", () => {
  it("a fresh owner session can mint an admin API key", async () => {
    const a = await createTestTenant(env, SELF);
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" } });
    expect(r.status).toBe(201);
    expect((await tenantRow(a.id))!.status).toBe("active");
  });

  it("a stale owner session (backdated 11 minutes) is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(11 * 60_000, a.id).run();
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a stale owner session (backdated 10 minutes) is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(10 * 60_000, a.id).run();
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a session created exactly 10 minutes ago is refused (boundary)", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(10 * 60_000, a.id).run();
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a session created just under 10 minutes ago is accepted", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(9 * 60_000, a.id).run();
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBe(201);
    expect((await tenantRow(a.id))!.status).toBe("active");
  });
});

describe("stale owner/admin session cannot invite an admin", () => {
  it("a fresh owner session can invite an admin", async () => {
    const a = await createTestTenant(env, SELF);
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" } });
    expect(r.status).toBe(201);
  });

  it("a stale owner session (backdated 11 minutes) is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(11 * 60_000, a.id).run();
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a stale owner session (backdated 10 minutes) is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(10 * 60_000, a.id).run();
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a session at exactly 10 minutes is refused (boundary)", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(10 * 60_000, a.id).run();
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(await code(r)).toBe("reauth_required");
  });

  it("a session just under 10 minutes ago is accepted", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(9 * 60_000, a.id).run();
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBe(201);
  });
});

describe("stale admin sessions cannot create persistent admin access", () => {
  it("refuses to mint an admin API key", async () => {
    const a = await createTestTenant(env, SELF, { role: "admin" });
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(11 * 60_000, a.id).run();
    const r = await a.fetch("/api/api-keys", { body: { name: "admin-key", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("reauth_required");
  });

  it("refuses to invite another admin", async () => {
    const a = await createTestTenant(env, SELF, { role: "admin" });
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = 'test'").bind(11 * 60_000, a.id).run();
    const r = await a.fetch("/api/invitations", { body: { email: "new-admin@example.com", role: "admin" }, cookie: `__Host-rose_session=${token}` });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("reauth_required");
  });
});
