// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant } from "../src/testing";
import { tenantJobHandlers, tenantTick } from "../src";
import { runDueJobs } from "../src/control/jobs";
import { cancelTenantDeletion, recoverStuckPurges, requestTenantDeletion } from "../src/control/tenants";
import { modules } from "./worker";

const tenantRow = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const purgeJobs = (id: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(id).first<{ n: number }>();
const recoveredAudits = (id: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'tenant.purge_recovered' AND target = ?").bind(id).first<{ n: number }>();
const storageAlive = async (id: string) => {
  const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(id));
  const tables = await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'notes'" });
  if (tables.rows[0]!.n === 0) return 0;
  return (await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM notes" })).rows[0]!.n as number;
};

const failingRecordsDb: D1Database = {
  prepare: (query: string) => env.DB.prepare(query),
  batch: async <_T = unknown>() => {
    throw new Error("simulated deleteTenantRecords failure");
  },
  exec: (query: string) => env.DB.exec(query),
  dump: () => env.DB.dump(),
  withSession: (constraintOrBookmark?: string) => env.DB.withSession(constraintOrBookmark),
};

describe("stuck tenant purges are recovered by the hourly sweep", () => {
  it("a purge that fails on its final attempt is re-enqueued and finishes on the next tick", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "doomed" } });
    await requestTenantDeletion(env.DB, a.id);
    const job = await env.DB.prepare("SELECT id FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(a.id).first<{ id: string }>();
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await env.DB.prepare("UPDATE jobs SET run_after = 0, attempts = 4 WHERE id = ?").bind(job!.id).run();

    await runDueJobs({ ...env, DB: failingRecordsDb }, tenantJobHandlers(modules));

    expect((await tenantRow(a.id))!.status).toBe("deleting");
    expect(
      await env.DB.prepare("SELECT status, attempts, payload FROM jobs WHERE id = ?").bind(job!.id).first<{ status: string; attempts: number; payload: string }>(),
    ).toMatchObject({ status: "failed", attempts: 5, payload: "{}" });
    expect(await storageAlive(a.id)).toBe(0);

    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).not.toBeNull();
    expect(await recoveredAudits(a.id)).toEqual({ n: 1 });

    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ?").bind(a.id).first()).toBeNull();
    expect(await recoveredAudits(a.id)).toEqual({ n: 1 });
  });

  it("a tenant whose purge job row was lost is recovered by the sweep", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "doomed" } });
    await requestTenantDeletion(env.DB, a.id);
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await env.DB.prepare("DELETE FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(a.id).run();

    const sent: { jobId: string }[] = [];
    const qenv = { ...env, APP_JOBS: { send: (body: { jobId: string }) => { sent.push(body); return Promise.resolve(); } } };
    await tenantTick(qenv, modules);

    expect(sent).toHaveLength(1);
    expect(await recoveredAudits(a.id)).toEqual({ n: 1 });

    await tenantTick(qenv, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).toBeNull();
    expect(await recoveredAudits(a.id)).toEqual({ n: 1 });
  });

  it("a cancelled tenant is never re-enqueued", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    await cancelTenantDeletion(env.DB, a.id);

    await tenantTick(env, modules);
    expect((await tenantRow(a.id))!.status).toBe("active");
    expect(await purgeJobs(a.id)).toEqual({ n: 0 });
  });

  it("two ticks enqueue only one job and still honor the grace period", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "doomed" } });
    await requestTenantDeletion(env.DB, a.id);
    await env.DB.prepare("UPDATE tenants SET status = 'deleting', delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await env.DB.prepare("UPDATE jobs SET run_after = ? WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(Date.now() + 60_000, a.id).run();

    await tenantTick(env, modules);
    await tenantTick(env, modules);

    expect(await purgeJobs(a.id)).toEqual({ n: 1 });
    expect((await tenantRow(a.id))!.status).toBe("deleting");
    expect(await storageAlive(a.id)).toBe(1);
  });

  it("a tenant still inside its grace period whose job row was lost gets no new job", async () => {
    const a = await createTestTenant(env, SELF);
    await requestTenantDeletion(env.DB, a.id);
    await env.DB.prepare("DELETE FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(a.id).run();

    await tenantTick(env, modules);
    expect(await purgeJobs(a.id)).toEqual({ n: 0 });
    expect((await tenantRow(a.id))!.status).toBe("pending_deletion");
  });

  it("the sweep recovers at most 100 stuck tenants and never duplicates a job", async () => {
    const t = Date.now();
    await env.DB
      .prepare(
        `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 101)
         INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at)
         SELECT 'tn_stuck_' || n, 'stuck' || n, 'Stuck ' || n, 'deleting', 'free', ?, ?
         FROM c`,
      )
      .bind(t, t)
      .run();

    const first = await recoverStuckPurges(env.DB);
    const second = await recoverStuckPurges(env.DB);

    expect(first).toHaveLength(100);
    expect(second).toHaveLength(1);
    expect(first.every((j) => j.id.startsWith("job_") && j.tenantId.startsWith("tn_stuck_"))).toBe(true);
    expect(new Set([...first, ...second].map((j) => j.tenantId)).size).toBe(101);
  });

  it("the sweep recovers the oldest stuck tenants first", async () => {
    const t = Date.now();
    await env.DB
      .prepare(
        `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 101)
         INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at)
         SELECT 'tn_order_' || n, 'order' || n, 'Order ' || n, 'deleting', 'free', ?, ? + n
         FROM c`,
      )
      .bind(t, t)
      .run();

    const first = await recoverStuckPurges(env.DB);
    const second = await recoverStuckPurges(env.DB);

    expect(first).toHaveLength(100);
    expect(first.every((j) => j.tenantId !== "tn_order_101")).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0]!.tenantId).toBe("tn_order_101");
  });
});
