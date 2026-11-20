// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant } from "../src/testing";
import { tenantJobHandlers } from "../src";
import { retryJob, runJobMessages, type JobRow } from "../src/control/jobs";
import { modules } from "./worker";

const noteCount = async (id: string) => {
  const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(id));
  const r = await stub.exec(id, { sql: "SELECT COUNT(*) AS n FROM notes" });
  return Number(r.rows[0]!.n);
};

const batchOf = (ids: unknown[]) => ({
  messages: ids.map((jobId) => ({ body: { jobId }, ack: () => undefined })),
});

const fakeQueue = () => {
  const sent: { body: { jobId: string }; delaySeconds?: number }[] = [];
  return {
    sent,
    send: (body: { jobId: string }, o?: { delaySeconds?: number }) => {
      sent.push(o?.delaySeconds === undefined ? { body } : { body, delaySeconds: o.delaySeconds });
      return Promise.resolve();
    },
  };
};

const insertJob = (row: { id: string; type: string; scope: string; title: string; status: string; payload: string; attempts: number }) => {
  const ts = Date.now();
  return env.DB
    .prepare("INSERT INTO jobs (id, type, scope, title, status, payload, error, attempts, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)")
    .bind(row.id, row.type, row.scope, row.title, row.status, row.payload, row.attempts, ts, ts, ts)
    .run();
};

describe("operator retry of a failed job", () => {
  it("a platform job keeps its payload on final failure, so a retry re-queues it intact", async () => {
    const app = fakeQueue();
    const qenv = { DB: env.DB, APP_JOBS: app };
    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    await insertJob({ id, type: "t.platform", scope: "platform", title: "Platform job", status: "queued", payload: JSON.stringify({ tenantId: "tn_keep" }), attempts: 0 });

    const handlers = { "t.platform": () => Promise.reject(new Error("boom")) };
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").bind(id).run();
      await runJobMessages(qenv, handlers, batchOf([id]));
    }
    expect(await env.DB.prepare("SELECT status, attempts, payload FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "failed", attempts: 5, payload: JSON.stringify({ tenantId: "tn_keep" }) });

    await retryJob(qenv, id, "platform");
    expect(await env.DB.prepare("SELECT status, attempts, error, payload FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "queued", attempts: 0, error: null, payload: JSON.stringify({ tenantId: "tn_keep" }) });
    expect(app.sent.at(-1)?.body).toEqual({ jobId: id });
  });

  it("a tenant-scoped job still wipes its payload on final failure", async () => {
    const qenv = { DB: env.DB, APP_JOBS: fakeQueue() };
    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    await insertJob({ id, type: "t.tenant", scope: "tn_wiped", title: "Tenant job", status: "queued", payload: JSON.stringify({ secret: "do not linger" }), attempts: 0 });

    const handlers = { "t.tenant": () => Promise.reject(new Error("boom")) };
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").bind(id).run();
      await runJobMessages(qenv, handlers, batchOf([id]));
    }
    expect(await env.DB.prepare("SELECT status, attempts, payload FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "failed", attempts: 5, payload: "{}" });
  });

  it("a legacy wiped tenant.purge row is retried and then fails honestly without purging", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep-a" } });
    await b.fetch("/api/m/notes", { body: { title: "keep-b" } });
    await env.DB.prepare("UPDATE tenants SET status = 'deleting' WHERE id = ?").bind(a.id).run();

    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    await insertJob({ id, type: "tenant.purge", scope: "platform", title: "Delete a workspace", status: "failed", payload: "{}", attempts: 5 });

    await retryJob(env, id, "platform");
    expect(await env.DB.prepare("SELECT status, attempts, error FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "queued", attempts: 0, error: null });

    const handlers = tenantJobHandlers(modules);
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").bind(id).run();
      await runJobMessages(env, handlers, batchOf([id]));
    }
    expect(await env.DB.prepare("SELECT status, attempts, error FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "failed", attempts: 5, error: "This deletion task has no workspace id." });

    expect(await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(a.id).first()).toEqual({ status: "deleting" });
    expect(await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(b.id).first()).toEqual({ status: "active" });
    expect(await noteCount(a.id)).toBe(1);
    expect(await noteCount(b.id)).toBe(1);
  });
});

describe("the tenant.purge handler refuses an empty payload", () => {
  it("throws before any purge work and leaves every tenant untouched", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/m/notes", { body: { title: "keep-a" } });
    await b.fetch("/api/m/notes", { body: { title: "keep-b" } });
    await env.DB.prepare("UPDATE tenants SET status = 'deleting' WHERE id = ?").bind(a.id).run();

    const handler = tenantJobHandlers(modules)["tenant.purge"]!;
    const job: JobRow = {
      id: "job_empty", type: "tenant.purge", scope: "platform", title: "Delete tenant", status: "running", payload: "{}",
      result: null, error: null, attempts: 1, claim: null, run_after: 0, created_by: null, created_at: 0, updated_at: 0,
    };
    await expect(handler(env, job, {})).rejects.toMatchObject({ status: 409, message: "This deletion task has no workspace id." });

    expect(await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(a.id).first()).toEqual({ status: "deleting" });
    expect(await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(b.id).first()).toEqual({ status: "active" });
    expect(await noteCount(a.id)).toBe(1);
    expect(await noteCount(b.id)).toBe(1);
  });
});
