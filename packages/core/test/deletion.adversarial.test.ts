// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the tenant deletion grace period (tenant side and purge job).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant, type TestTenant } from "../src/testing";
import { tenantJobHandlers, tenantTick } from "../src";
import { createSession } from "../src/control/sessions";
import { cancelTenantDeletion, requestTenantDeletion } from "../src/control/tenants";
import { invalidateHostCache } from "../src/tenancy/resolve";
import { modules } from "./worker";

const tenantRow = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const code = async (r: Response) => ((await r.clone().json()) as { error?: { code: string } }).error?.code;
const cookieFor = async (a: TestTenant, method: string, ageMs = 0) => {
  const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method });
  if (ageMs) await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE scope = ? AND method = ?").bind(ageMs, a.id, method).run();
  return `__Host-rose_session=${token}`;
};
const storageAlive = async (id: string) => {
  const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(id));
  return (await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM notes" })).rows[0]!.n as number;
};
const purgeJob = (id: string) =>
  env.DB.prepare("SELECT id, status, run_after FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(id).first<{ id: string; status: string; run_after: number }>();

describe("purge never runs before delete_after (adversarial)", () => {
  it("a purge job forced due (run_after in the past) still refuses while delete_after is in the future", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep" } });
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBe(202);
    const job = await purgeJob(a.id);
    const row = await tenantRow(a.id);
    expect(job!.run_after).toBeGreaterThanOrEqual(row!.delete_after! - 1000);
    // Simulate an early queue redelivery / clock skew: the job looks due.
    await env.DB.prepare("UPDATE jobs SET run_after = ? WHERE id = ?").bind(Date.now() - 1, job!.id).run();
    await tenantTick(env, modules);
    await tenantTick(env, modules);
    expect((await tenantRow(a.id))!.status).toBe("pending_deletion");
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("calling the purge handler directly is refused one second before the deadline", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep" } });
    await requestTenantDeletion(env.DB, a.id);
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() + 1000, a.id).run();
    const handler = tenantJobHandlers(modules)["tenant.purge"]!;
    const out = await handler(env, {} as never, { tenantId: a.id });
    expect(out.done).toBe(false);
    expect((await tenantRow(a.id))!.status).toBe("pending_deletion");
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("a pending tenant with no deadline recorded is never purged", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep" } });
    await env.DB.prepare("UPDATE tenants SET status = 'pending_deletion', delete_after = NULL WHERE id = ?").bind(a.id).run();
    const out = await tenantJobHandlers(modules)["tenant.purge"]!(env, {} as never, { tenantId: a.id });
    expect(out.done).toBe(false);
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("an active (cancelled) tenant is never purged by a stale job", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep" } });
    await requestTenantDeletion(env.DB, a.id);
    expect(await cancelTenantDeletion(env.DB, a.id)).toBe(true);
    const out = await tenantJobHandlers(modules)["tenant.purge"]!(env, {} as never, { tenantId: a.id });
    expect(out.done).toBe(true);
    expect((await tenantRow(a.id))!.status).toBe("active");
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("a suspended tenant is never purged by a forged job", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep" } });
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
    await tenantJobHandlers(modules)["tenant.purge"]!(env, {} as never, { tenantId: a.id });
    expect((await tenantRow(a.id))!.status).toBe("suspended");
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("requesting deletion again does not move the deadline earlier or later", async () => {
    const a = await createTestTenant(env, SELF);
    const first = await requestTenantDeletion(env.DB, a.id);
    const second = await requestTenantDeletion(env.DB, a.id);
    expect(second).toBe(first);
    expect((await tenantRow(a.id))!.delete_after).toBe(first);
  });

  it("delete, cancel, delete again gives a fresh 48h deadline, not the old one", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    // Pretend the first request was long ago.
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await cancelTenantDeletion(env.DB, a.id);
    const again = await requestTenantDeletion(env.DB, a.id);
    expect(again).toBeGreaterThan(Date.now() + 47 * 3_600_000);
  });
});

describe("tenant-side /api/workspace/delete (adversarial)", () => {
  it("an admin (not owner) can not delete, even with a fresh passkey session", async () => {
    const a = await createTestTenant(env, SELF, { role: "admin" });
    const r = await a.fetch("/api/workspace/delete", { cookie: await cookieFor(a, "passkey"), body: { confirm: a.slug } });
    expect(r.status).toBe(403);
    expect((await tenantRow(a.id))!.status).toBe("active");
  });

  it("an API key is refused even if a fresh owner cookie is also sent", async () => {
    const a = await createTestTenant(env, SELF);
    const key = ((await (await a.fetch("/api/api-keys", { body: { name: "k", role: "admin" } })).json()) as { key: string }).key;
    const r = await a.fetch("/api/workspace/delete", { cookie: await cookieFor(a, "passkey"), headers: { Authorization: `Bearer ${key}` }, body: { confirm: a.slug } });
    expect(r.status).toBe(403);
    expect((await tenantRow(a.id))!.status).toBe("active");
  });

  it("a session just over 10 minutes old is refused, regardless of method", async () => {
    const a = await createTestTenant(env, SELF);
    for (const m of ["passkey", "code"]) {
      const r = await a.fetch("/api/workspace/delete", { cookie: await cookieFor(a, m, 10 * 60_000 + 2000), body: { confirm: a.slug } });
      expect(r.status, m).toBe(403);
      expect(await code(r), m).toBe("reauth_required");
    }
    expect((await tenantRow(a.id))!.status).toBe("active");
  });

  it("the purge job queued by an owner delete is held for the full grace period", async () => {
    const a = await createTestTenant(env, SELF);
    const r = await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } });
    expect(r.status).toBe(202);
    const { deleteAfter } = (await r.json()) as { deleteAfter: number };
    expect(deleteAfter).toBeGreaterThan(Date.now() + 47.9 * 3_600_000);
    expect(deleteAfter).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000);
    expect((await tenantRow(a.id))).toEqual({ status: "pending_deletion", delete_after: deleteAfter });
    expect((await purgeJob(a.id))!.run_after).toBeGreaterThanOrEqual(deleteAfter - 1000);
    // A second request while pending is not served.
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBeGreaterThanOrEqual(401);
  });
});

describe("pending tenants are unreachable and restorable (adversarial)", () => {
  it("existing sessions and API keys stop working as soon as deletion is requested", async () => {
    const a = await createTestTenant(env, SELF);
    const key = ((await (await a.fetch("/api/api-keys", { body: { name: "k", role: "admin" } })).json()) as { key: string }).key;
    const other = await cookieFor(a, "passkey");
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBe(202);
    expect((await a.fetch("/api/m/notes", { cookie: other })).status).toBeGreaterThanOrEqual(401);
    expect((await a.fetch("/api/m/notes", { cookie: null, headers: { Authorization: `Bearer ${key}` } })).status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE scope = ?").bind(a.id).first()).toBeNull();
  });

  it("a session row created while pending (e.g. via a race) is not usable", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    const c = await cookieFor(a, "passkey");
    expect((await a.fetch("/api/m/notes", { cookie: c })).status).toBeGreaterThanOrEqual(401);
    const boot = (await (await a.fetch("/api/bootstrap", { cookie: c })).json()) as { session: unknown };
    expect(boot.session).toBeNull();
  });

  it("sign-in by emailed code is refused for a pending tenant (cache invalidated)", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    invalidateHostCache();
    const req = await a.fetch("/api/auth/code/request", { cookie: null, body: { email: a.email } });
    expect(req.status).toBe(403);
  });

  it("sign-in by emailed code is refused for a pending tenant even while this isolate's host cache still says active", async () => {
    const a = await createTestTenant(env, SELF);
    // Warm the host cache with the tenant as active.
    await a.fetch("/api/bootstrap", { cookie: null });
    // Deletion requested from elsewhere (the operator console is a different worker; it can not clear this cache).
    await requestTenantDeletion(env.DB, a.id);
    const req = await a.fetch("/api/auth/code/request", { cookie: null, body: { email: a.email } });
    const devCode = req.ok ? ((await req.json()) as { devCode?: string }).devCode : undefined;
    let verifyStatus = req.status;
    let sessionCreated = false;
    if (devCode) {
      const v = await a.fetch("/api/auth/code/verify", { cookie: null, body: { email: a.email, code: devCode } });
      verifyStatus = v.status;
      sessionCreated = !!(await env.DB.prepare("SELECT 1 FROM sessions WHERE scope = ?").bind(a.id).first());
    }
    expect(verifyStatus, "sign-in completed for a pending tenant").not.toBe(200);
    expect(sessionCreated, "a session row was minted for a pending tenant").toBe(false);
  });

  it("a session handoff into a pending tenant mints no session", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/bootstrap", { cookie: null });
    const { createHandoff } = await import("../src/control/sessions");
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id });
    await requestTenantDeletion(env.DB, a.id);
    const r = await a.fetch(`/auth/handoff?token=${token}`, { cookie: null });
    expect(r.headers.get("Set-Cookie") ?? "").not.toMatch(/rose_session=[^;]+/);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE scope = ?").bind(a.id).first()).toBeNull();
  });

  it("cancel restores the tenant with its data, and members can sign in again", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "survivor" } });
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBe(202);
    expect(await cancelTenantDeletion(env.DB, a.id)).toBe(true);
    invalidateHostCache();
    expect(await tenantRow(a.id)).toEqual({ status: "active", delete_after: null });
    expect(await purgeJob(a.id)).toBeNull();
    const c = await cookieFor(a, "code");
    const res = await a.fetch("/api/m/notes", { cookie: c });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("survivor");
    // Running the sweep afterwards must not purge it.
    await tenantTick(env, modules);
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("cancel refuses a tenant whose purge already began", async () => {
    const a = await createTestTenant(env, SELF);
    await env.DB.prepare("UPDATE tenants SET status = 'deleting' WHERE id = ?").bind(a.id).run();
    expect(await cancelTenantDeletion(env.DB, a.id)).toBe(false);
    expect((await tenantRow(a.id))!.status).toBe("deleting");
  });
});
