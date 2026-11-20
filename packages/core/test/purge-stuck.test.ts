// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant } from "../src/testing";
import { tenantJobHandlers, tenantTick } from "../src";
import { runDueJobs } from "../src/control/jobs";
import { cancelTenantDeletion, requestTenantDeletion } from "../src/control/tenants";
import { modules } from "./worker";

const tenantRow = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const purgeJobs = (id: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(id).first<{ n: number }>();
const storageAlive = async (id: string) => {
  const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(id));
  const tables = await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'notes'" });
  if (tables.rows[0]!.n === 0) return 0;
  return (await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM notes" })).rows[0]!.n as number;
};

const failingDb: D1Database = {
  prepare: (query: string) => env.DB.prepare(query),
  batch: async <_T = unknown>() => {
    throw new Error("simulated tenant storage failure");
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

    await runDueJobs({ ...env, DB: failingDb }, tenantJobHandlers(modules));

    expect((await tenantRow(a.id))!.status).toBe("deleting");
    expect(
      await env.DB.prepare("SELECT status, attempts, payload FROM jobs WHERE id = ?").bind(job!.id).first<{ status: string; attempts: number; payload: string }>(),
    ).toMatchObject({ status: "failed", attempts: 5, payload: "{}" });

    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ?").bind(a.id).first()).toBeNull();
    expect(await storageAlive(a.id)).toBe(0);
  });

  it("a tenant whose purge job row was lost is recovered by the sweep", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "doomed" } });
    await requestTenantDeletion(env.DB, a.id);
    await env.DB.prepare("UPDATE tenants SET delete_after = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    await env.DB.prepare("DELETE FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(a.id).run();

    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).toBeNull();
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
    await env.DB.prepare("UPDATE tenants SET status = 'deleting', delete_after = ? WHERE id = ?").bind(Date.now() + 3_600_000, a.id).run();

    await tenantTick(env, modules);
    await tenantTick(env, modules);

    expect(await purgeJobs(a.id)).toEqual({ n: 1 });
    expect((await tenantRow(a.id))!.status).toBe("deleting");
    expect(await storageAlive(a.id)).toBe(1);
  });
});
