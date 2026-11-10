// SPDX-License-Identifier: Apache-2.0
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant, describeTenantIsolation } from "../src/testing";
import { modules } from "./worker";

describeTenantIsolation(env, SELF, modules);

describe("tenant resolution", () => {
  it("ignores client-supplied tenant hints", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "only-in-a" } });
    const res = await b.fetch(`/api/m/notes?tenant=${a.id}&tenant_id=${a.id}`, { headers: { "X-Tenant-Id": a.id, "X-Rose-Tenant-Id": a.id, "X-Forwarded-Host": a.host } });
    expect(await res.text()).not.toContain("only-in-a");
  });

  it("treats unknown and nested hosts as no tenant", async () => {
    const a = await createTestTenant(env, SELF);
    for (const host of [`nope.${env.APP_BASE_DOMAIN}`, `x.${a.host}`, "evil.example"]) {
      const res = await SELF.fetch(`https://${host}/api/m/notes`, { headers: { Cookie: a.cookie } });
      expect(res.status, host).toBe(404);
    }
  });

  it("stores each tenant in a physically separate database", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "a-note" } });
    const count = async (id: string) => {
      const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(id));
      return (await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM notes" })).rows[0]!.n;
    };
    expect(await count(a.id)).toBe(1);
    expect(await count(b.id)).toBe(0);
  });

  it("a tenant database refuses a caller presenting a different tenant id", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "pin" } });
    const stubA = env.TENANT_DO.get(env.TENANT_DO.idFromName(a.id));
    const error = await runInDurableObject(stubA, (instance) => instance.exec(b.id, { sql: "SELECT * FROM notes" }).then(() => null, (e: Error) => e.message));
    expect(error).toMatch(/Tenant mismatch/);
  });
});

describe("tenant lifecycle", () => {
  it("suspension cuts off sessions and API keys immediately", async () => {
    const a = await createTestTenant(env, SELF);
    const key = ((await (await a.fetch("/api/api-keys", { body: { name: "ci" } })).json()) as { key: string }).key;
    expect((await a.fetch("/api/m/notes", { cookie: null, headers: { Authorization: `Bearer ${key}` } })).status).toBe(200);
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
    // No cache invalidation on purpose: the host cache may still say "active".
    expect((await a.fetch("/api/m/notes")).status).toBeGreaterThanOrEqual(401);
    expect((await a.fetch("/api/m/notes", { cookie: null, headers: { Authorization: `Bearer ${key}` } })).status).toBe(403);
  });

  it("removing a member ends their access on the next request", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/m/notes")).status).toBe(200);
    await env.DB.prepare("DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?").bind(a.id, a.userId).run();
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
  });

  it("deleting a workspace needs the typed name, then destroys its data", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "doomed", secret: "s3cret" } });
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: "wrong" } })).status).toBe(422);
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBe(202);
    expect((await a.fetch("/api/m/notes")).status).toBe(404);
    const { tenantTick } = await import("../src");
    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE id = ?").bind(a.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ?").bind(a.id).first()).toBeNull();
    const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(a.id));
    const left = await stub.exec(a.id, { sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('notes', 'audit_log', 'api_keys')" });
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe("roles and API keys", () => {
  it("enforces module permissions by role", async () => {
    const m = await createTestTenant(env, SELF, { role: "member" });
    expect((await m.fetch("/api/m/notes")).status).toBe(200);
    expect((await m.fetch("/api/m/notes", { body: { title: "x" } })).status).toBe(403);
    expect((await m.fetch("/api/api-keys")).status).toBe(403);
    expect((await m.fetch("/api/workspace/delete", { body: { confirm: m.slug } })).status).toBe(403);
  });

  it("an API key works only on the tenant that issued it", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const key = ((await (await a.fetch("/api/api-keys", { body: { name: "agent", role: "admin" } })).json()) as { key: string }).key;
    const h = { Authorization: `Bearer ${key}` };
    expect((await a.fetch("/api/m/notes", { cookie: null, headers: h, body: { title: "via-key" } })).status).toBe(201);
    expect((await b.fetch("/api/m/notes", { cookie: null, headers: h })).status).toBe(401);
    expect((await a.fetch("/api/m/notes", { cookie: null, headers: { Authorization: `Bearer ${key}x` } })).status).toBe(401);
    // A valid cookie must not rescue a bad bearer token.
    expect((await a.fetch("/api/m/notes", { headers: { Authorization: "Bearer rose_bad" } })).status).toBe(401);
  });

  it("runs module jobs for the tenant that queued them only", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/m/notes/stamp", { body: {} })).status).toBe(201);
    const { tenantTick } = await import("../src");
    await tenantTick(env, modules);
    expect(await (await a.fetch("/api/m/notes")).text()).toContain("job:hello");
    expect(await (await b.fetch("/api/m/notes")).text()).not.toContain("job:hello");
    const jobs = (await (await a.fetch("/api/jobs")).json()) as { items: { status: string }[] };
    expect(jobs.items[0]!.status).toBe("succeeded");
    expect(((await (await b.fetch("/api/jobs")).json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe("queued work and deletion", () => {
  it("a deleted workspace's queued jobs are removed, not left to fail", async () => {
    const { tenantTick } = await import("../src");
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/m/notes/stamp", { body: {} })).status).toBe(201);
    expect((await a.fetch("/api/workspace/delete", { body: { confirm: a.slug } })).status).toBe(202);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE scope = ?").bind(a.id).first()).toEqual({ n: 0 });
    await tenantTick(env, modules);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'").first()).toEqual({ n: 0 });
  });
});

describe("job queue", () => {
  const fakeQueue = () => {
    const sent: { body: { jobId: string }; delaySeconds?: number }[] = [];
    return { sent, send: async (body: { jobId: string }, o?: { delaySeconds?: number }) => void sent.push({ body, delaySeconds: o?.delaySeconds }) };
  };
  const batchOf = (ids: unknown[]) => {
    const acked: number[] = [];
    return { acked, messages: ids.map((jobId, i) => ({ body: { jobId }, ack: () => void acked.push(i) })) };
  };

  it("queuing a job wakes the right worker, and the message runs it exactly once", async () => {
    const { enqueueJob, runJobMessages } = await import("../src/control/jobs");
    const app = fakeQueue();
    const admin = fakeQueue();
    const qenv = { DB: env.DB, APP_JOBS: app, ADMIN_JOBS: admin };
    const a = await enqueueJob(qenv, { type: "t.app", scope: "platform", title: "app job" });
    const d = await enqueueJob(qenv, { type: "domain.verify", scope: "platform", title: "admin job", delayMs: 30_000 });
    expect(app.sent).toEqual([{ body: { jobId: a.id }, delaySeconds: undefined }]);
    expect(admin.sent).toEqual([{ body: { jobId: d.id }, delaySeconds: 30 }]);

    let runs = 0;
    const handlers = { "t.app": async () => (runs++, { done: true as const }) };
    // The same message delivered twice, plus junk: one run, everything acknowledged.
    const batch = batchOf([a.id, a.id, "job_missing", null, { $ne: 1 }]);
    await runJobMessages(qenv, handlers, batch);
    expect(runs).toBe(1);
    expect(batch.acked).toHaveLength(5);
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(a.id).first()).toEqual({ status: "succeeded" });
    // A message for a job that is not due yet does nothing.
    await runJobMessages(qenv, { "domain.verify": async () => (runs++, { done: true as const }) }, batchOf([d.id]));
    expect(runs).toBe(1);
  });

  it("retries are scheduled with a delayed message and stop after five failures", async () => {
    const { enqueueJob, runJobMessages, retryJob } = await import("../src/control/jobs");
    const app = fakeQueue();
    const qenv = { DB: env.DB, APP_JOBS: app };
    const wait = await enqueueJob(qenv, { type: "t.wait", scope: "platform", title: "waits" });
    await runJobMessages(qenv, { "t.wait": async () => ({ done: false as const, retryInMs: 45_000 }) }, batchOf([wait.id]));
    expect(app.sent.at(-1)).toEqual({ body: { jobId: wait.id }, delaySeconds: 45 });

    const bad = await enqueueJob(qenv, { type: "t.bad", scope: "platform", title: "fails" });
    const boom = { "t.bad": async () => { throw new Error("boom"); } };
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").bind(bad.id).run();
      await runJobMessages(qenv, boom, batchOf([bad.id]));
    }
    expect(await env.DB.prepare("SELECT status, attempts, error FROM jobs WHERE id = ?").bind(bad.id).first()).toEqual({ status: "failed", attempts: 5, error: "boom" });
    const before = app.sent.length;
    await runJobMessages(qenv, boom, batchOf([bad.id]));
    expect(app.sent.length).toBe(before);
    await retryJob(qenv, bad.id);
    expect(app.sent.at(-1)).toEqual({ body: { jobId: bad.id }, delaySeconds: undefined });
  });

  it("a failing queue never loses the job: the sweep still runs it", async () => {
    const { enqueueJob, runDueJobs } = await import("../src/control/jobs");
    const qenv = { DB: env.DB, APP_JOBS: { send: async () => { throw new Error("queue down"); } } };
    const j = await enqueueJob(qenv, { type: "t.sweep", scope: "platform", title: "swept" });
    expect(await runDueJobs(qenv, { "t.sweep": async () => ({ done: true as const }) })).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(j.id).first()).toEqual({ status: "succeeded" });
  });
});
