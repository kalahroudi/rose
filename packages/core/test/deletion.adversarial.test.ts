// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the tenant deletion grace period (tenant side and purge job).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant, type TestTenant } from "../src/testing";
import { createTenantApp, tenantJobHandlers, tenantTick } from "../src";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { createSession } from "../src/control/sessions";
import { beginTenantPurge, cancelTenantDeletion, requestTenantDeletion } from "../src/control/tenants";
import { invalidateHostCache } from "../src/tenancy/resolve";
import { modules } from "./worker";

const tenantRow = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const code = async (r: Response) => (await r.clone().json<{ error?: { code: string } }>()).error?.code;
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
    expect(await cancelTenantDeletion(env.DB, a.id)).toMatchObject({ status: "active" });
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
    expect(first.created).toBe(true);
    expect(first.jobId).toBeTruthy();
    expect(second.created).toBe(false);
    expect(second.jobId).toBeUndefined();
    expect(second.deleteAfter).toBe(first.deleteAfter);
    expect((await tenantRow(a.id))!.delete_after).toBe(first.deleteAfter);
  });

  it("a repeat delete on a pending tenant leaves a session inserted after the first request untouched", async () => {
    const a = await createTestTenant(env, SELF);
    const first = await requestTenantDeletion(env.DB, a.id);
    expect(first.created).toBe(true);
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(first.deleteAfter - 1000, a.id).run();
    await createSession(env.DB, { userId: a.userId, scope: a.id, method: "code" });
    const inserted = await env.DB.prepare("SELECT public_id FROM sessions WHERE scope = ?").bind(a.id).first<{ public_id: string }>();
    expect(inserted).not.toBeNull();
    const second = await requestTenantDeletion(env.DB, a.id);
    expect(second.created).toBe(false);
    expect(second.deleteAfter).toBe(first.deleteAfter - 1000);
    expect(await env.DB.prepare("SELECT public_id FROM sessions WHERE scope = ?").bind(a.id).first<{ public_id: string }>()).toEqual(inserted);
  });

  it("delete, cancel, delete again gives a fresh 48h deadline, not the old one", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    // Pretend the first request was long ago.
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await cancelTenantDeletion(env.DB, a.id);
    const again = await requestTenantDeletion(env.DB, a.id);
    expect(again.created).toBe(true);
    expect(again.deleteAfter).toBeGreaterThan(Date.now() + 47 * 3_600_000);
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
    const key = (await (await a.fetch("/api/api-keys", { body: { name: "k", role: "admin" } })).json<{ key: string }>()).key;
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
    const { deleteAfter } = await r.json<{ deleteAfter: number }>();
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
    const key = (await (await a.fetch("/api/api-keys", { body: { name: "k", role: "admin" } })).json<{ key: string }>()).key;
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
    const boot = await (await a.fetch("/api/bootstrap", { cookie: c })).json<{ session: unknown }>();
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
    const devCode = req.ok ? (await req.json<{ devCode?: string }>()).devCode : undefined;
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
    expect(await cancelTenantDeletion(env.DB, a.id)).toMatchObject({ status: "active" });
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
    expect(await cancelTenantDeletion(env.DB, a.id)).toBeNull();
    expect((await tenantRow(a.id))!.status).toBe("deleting");
  });
});

describe("concurrent deletion request and cancel races (adversarial)", () => {
  const queuedPurgeJobs = (id: string) =>
    env.DB
      .prepare("SELECT id, run_after FROM jobs WHERE type = 'tenant.purge' AND status = 'queued' AND json_extract(payload, '$.tenantId') = ?")
      .bind(id)
      .all<{ id: string; run_after: number }>();

  it("20 parallel requestTenantDeletion calls create one purge job and return the stored deleteAfter", async () => {
    const a = await createTestTenant(env, SELF);
    const results = await Promise.all(Array.from({ length: 20 }, () => requestTenantDeletion(env.DB, a.id)));
    const stored = await tenantRow(a.id);
    expect(stored!.status).toBe("pending_deletion");
    expect(stored!.delete_after).not.toBeNull();
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    for (const r of results) expect(r.deleteAfter).toBe(stored!.delete_after);
    const winner = results.find((r) => r.created)!;
    const jobs = (await queuedPurgeJobs(a.id)).results;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(winner.jobId);
    expect(jobs[0]!.run_after).toBe(stored!.delete_after);
  });

  it("20 parallel owner /api/workspace/delete requests create one purge job, one audit row, one queue notify and match stored deleteAfter", async () => {
    const a = await createTestTenant(env, SELF);
    const sent: { body: { jobId: string }; delaySeconds?: number }[] = [];
    const app = createTenantApp({ modules });
    const qenv = {
      ...env,
      APP_JOBS: {
        send: (body: { jobId: string }, o?: { delaySeconds?: number }) => {
          sent.push(o?.delaySeconds === undefined ? { body } : { body, delaySeconds: o.delaySeconds });
          return Promise.resolve();
        },
      },
    };
    const cookies = await Promise.all(Array.from({ length: 20 }, () => cookieFor(a, "code")));
    const responses = await Promise.all(
      cookies.map((cookie) =>
        Promise.resolve(
          app.fetch(
            new Request(`https://${a.host}/api/workspace/delete`, {
              method: "POST",
              headers: { Origin: `https://${a.host}`, Cookie: cookie, "Content-Type": "application/json" },
              body: JSON.stringify({ confirm: a.slug }),
            }),
            qenv,
          ),
        ),
      ),
    );
    for (const r of responses) expect([202, 401, 403]).toContain(r.status);
    const accepted = responses.filter((r) => r.status === 202);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const stored = await tenantRow(a.id);
    expect(stored!.status).toBe("pending_deletion");
    expect(stored!.delete_after).not.toBeNull();
    for (const r of accepted) {
      const body = await r.json<{ ok: boolean; deleteAfter: number }>();
      expect(body.ok).toBe(true);
      expect(body.deleteAfter).toBe(stored!.delete_after);
    }
    const jobs = (await queuedPurgeJobs(a.id)).results;
    expect(jobs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.jobId).toBe(jobs[0]!.id);
    expect(sent[0]!.delaySeconds).toBeGreaterThan(0);
    const audits = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'tenant.delete.requested' AND target = ?")
      .bind(a.id)
      .first<{ n: number }>();
    expect(audits!.n).toBe(1);
  });

  it("50 rounds of parallel requestTenantDeletion and cancelTenantDeletion always end in a consistent status and purge-job count", async () => {
    const a = await createTestTenant(env, SELF);
    for (let i = 0; i < 50; i++) {
      if (i === 25) {
        const cur = await tenantRow(a.id);
        if (cur!.status === "pending_deletion") await cancelTenantDeletion(env.DB, a.id);
        await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
      } else if (i % 2 === 1 && (await tenantRow(a.id))!.status !== "pending_deletion") {
        await requestTenantDeletion(env.DB, a.id);
      }
      if (i % 2 === 0) {
        await Promise.all([requestTenantDeletion(env.DB, a.id), cancelTenantDeletion(env.DB, a.id)]);
      } else {
        await Promise.all([cancelTenantDeletion(env.DB, a.id), requestTenantDeletion(env.DB, a.id)]);
      }
      const state = await tenantRow(a.id);
      const jobs = (await queuedPurgeJobs(a.id)).results;
      if (state!.status === "pending_deletion") {
        expect(state!.delete_after).not.toBeNull();
        expect(jobs).toHaveLength(1);
      } else {
        expect(["active", "suspended"]).toContain(state!.status);
        expect(state!.delete_after).toBeNull();
        expect(jobs).toHaveLength(0);
      }
    }
  });

  const withBatchGate = (db: D1Database) => {
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      arrived = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wrapped: D1Database = {
      prepare: (query: string) => db.prepare(query),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        arrived();
        await gate;
        return db.batch<T>(statements);
      },
      exec: (query: string) => db.exec(query),
      dump: () => db.dump(),
      withSession: (constraintOrBookmark?: string) => db.withSession(constraintOrBookmark),
    };
    return { db: wrapped, reached, release };
  };

  it("two concurrent cancels: a session and sign-in code created after the winner survive the loser", async () => {
    const a = await createTestTenant(env, SELF);
    const del = await requestTenantDeletion(env.DB, a.id);
    const gated = withBatchGate(env.DB);
    const loserPromise = cancelTenantDeletion(gated.db, a.id);
    await gated.reached;
    const winner = await cancelTenantDeletion(env.DB, a.id);
    expect(winner).toEqual({ status: "active", deleteAfter: del.deleteAfter });
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "code" });
    const loginCode = await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1");
    gated.release();
    const loser = await loserPromise;
    expect(loser).toBeNull();
    expect(await tenantRow(a.id)).toEqual({ status: "active", delete_after: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope = ?").bind(a.id).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE scope = ?").bind(a.id).first<{ n: number }>()).toEqual({ n: 1 });
    invalidateHostCache();
    expect((await a.fetch("/api/m/notes", { cookie: `__Host-rose_session=${token}` })).status).toBe(200);
    expect(await verifyLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, loginCode, "127.0.0.1")).toBe(true);
  });

  it("a losing cancel against a deleting tenant leaves its queued purge job intact", async () => {
    const a = await createTestTenant(env, SELF);
    const del = await requestTenantDeletion(env.DB, a.id);
    expect((await queuedPurgeJobs(a.id)).results).toHaveLength(1);
    const gated = withBatchGate(env.DB);
    const loserPromise = cancelTenantDeletion(gated.db, a.id);
    await gated.reached;
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    expect(await beginTenantPurge(env.DB, a.id)).toBe(true);
    gated.release();
    expect(await loserPromise).toBeNull();
    expect((await tenantRow(a.id))!.status).toBe("deleting");
    const jobs = (await queuedPurgeJobs(a.id)).results;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(del.jobId);
  });

  it("a delete/cancel race on a suspended tenant returns status suspended", async () => {
    const a = await createTestTenant(env, SELF);
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
    const gated = withBatchGate(env.DB);
    const cancelPromise = cancelTenantDeletion(gated.db, a.id);
    await gated.reached;
    const del = await requestTenantDeletion(env.DB, a.id);
    expect(del.created).toBe(true);
    gated.release();
    const cancelled = await cancelPromise;
    expect(cancelled).toEqual({ status: "suspended", deleteAfter: del.deleteAfter });
    expect(await tenantRow(a.id)).toEqual({ status: "suspended", delete_after: null });
    expect((await queuedPurgeJobs(a.id)).results).toEqual([]);
  });
});
