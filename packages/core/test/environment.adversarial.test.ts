// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker, guardFetch, isDev } from "../src";
import { createSession } from "../src/control/sessions";
import { createTestTenant } from "../src/testing";
import { notes } from "./worker";

const MASTER = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const odd: unknown[] = [
  undefined, null, "", "test", "staging", "Production", "PRODUCTION", "production ", " production", "Development",
  "development\n", "development\u0000", "dеvelopment" /* Cyrillic e */, "dev", "local", 0, 1, true, false,
  ["development"], { toString: () => "development" }, new String("development"),
];
const withEnv = (v: unknown, extra: Record<string, unknown> = {}) => ({ ...env, ENVIRONMENT: v, ...extra }) as never;
const label = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const worker = createTenantWorker({ modules: [notes] });

async function insertJob(type: string, payload: unknown): Promise<string> {
  const id = `job_adv_${crypto.randomUUID().replace(/-/g, "")}`;
  const t = Date.now() - 5_000;
  await env.DB.prepare("INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, type, "adv", "adv", JSON.stringify(payload), t, null, t, t).run();
  return id;
}
const jobStatus = async (id: string) => (await env.DB.prepare("SELECT status, attempts FROM jobs WHERE id = ?").bind(id).first<{ status: string; attempts: number }>())!;

describe("adversarial: tenant worker ENVIRONMENT fails closed", () => {
  it("isDev is false for every odd value", () => {
    for (const v of odd) expect(isDev({ ENVIRONMENT: v as never }), label(v)).toBe(false);
  });

  it("fetch refuses every route with a generic 500 that leaks nothing, sets no cookie, is not cacheable", async () => {
    const a = await createTestTenant(env, SELF);
    const reqs = () => [
      new Request(`${a.origin}/api/bootstrap`, { headers: { Cookie: a.cookie } }),
      new Request(`${a.origin}/api/auth/code/request`, { method: "POST", headers: { Origin: a.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email }) }),
      new Request(`${a.origin}/api/m/notes`, { headers: { Cookie: a.cookie, Origin: a.origin } }),
      new Request(`${a.origin}/__dev/tick`, { method: "POST" }),
      new Request(`http://${a.host}/api/bootstrap`, { headers: { Cookie: a.cookie.replace("__Host-", "") } }),
      new Request(`${a.origin}/does-not-exist`),
    ];
    for (const v of odd) {
      for (const req of reqs()) {
        const ctx = createExecutionContext();
        const res = await worker.fetch(req, withEnv(v), ctx);
        await waitOnExecutionContext(ctx);
        const text = await res.text();
        expect(res.status, `${label(v)} ${req.url}`).toBe(500);
        expect(res.headers.get("Set-Cookie"), label(v)).toBeNull();
        expect(res.headers.get("Cache-Control") ?? "", label(v)).toMatch(/no-store/);
        expect(text).not.toMatch(/devCode|staging|Production|PRODUCTION|local|\btest\b/);
        expect(text).not.toContain(MASTER);
        expect(text).not.toContain(a.email);
        expect(text).not.toMatch(/ENVIRONMENT|at .*\.ts/);
      }
    }
  });

  it("an odd value does not issue a sign-in code at all (nothing written to login_codes)", async () => {
    const a = await createTestTenant(env, SELF);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${a.origin}/api/auth/code/request`, { method: "POST", headers: { Origin: a.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email }) }),
      withEnv("staging"), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(await env.DB.prepare("SELECT 1 FROM login_codes WHERE email = ?").bind(a.email).first()).toBeNull();
  });

  it("queue with an odd value runs no job and does not ack", async () => {
    for (const v of odd) {
      const id = await insertJob("tenant.purge", { tenantId: "tn_nope" });
      let acked = 0;
      await expect(worker.queue({ messages: [{ body: { jobId: id }, ack: () => { acked++; } }] }, withEnv(v)), label(v)).rejects.toThrow();
      expect(acked).toBe(0);
      expect(await jobStatus(id)).toEqual({ status: "queued", attempts: 0 });
      await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
    }
  });

  it("scheduled with an odd value runs no due job and sweeps nothing", async () => {
    const id = await insertJob("tenant.purge", { tenantId: "tn_nope" });
    for (const v of odd) {
      await expect(worker.scheduled({}, withEnv(v), {}), label(v)).rejects.toThrow();
      expect(await jobStatus(id)).toEqual({ status: "queued", attempts: 0 });
    }
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
  });

  it("the thrown queue/scheduled error message does not echo the configured value", async () => {
    for (const v of ["staging-secret-xyz", "Production"]) {
      const err = await worker.scheduled({}, withEnv(v), {}).then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain(v);
      expect(String(err!.stack ?? "")).not.toContain(v);
    }
  });

  it("guardFetch never calls the inner handler for an odd value", async () => {
    let called = 0;
    const f = guardFetch(() => { called++; return Promise.resolve(new Response("inner")); });
    for (const v of odd) {
      const res = await f(new Request("https://x.rose.test/"), withEnv(v));
      expect(res.status).toBe(500);
    }
    expect(called).toBe(0);
  });
});

describe("adversarial: production disables every dev behaviour", () => {
  const prodNoRl = (extra: Record<string, unknown> = {}) => withEnv("production", { RL_AUTH: undefined, ...extra });
  const allow = { limit: () => Promise.resolve({ success: true }) };

  it("missing RL_AUTH fails closed on code request and verify, with no devCode", async () => {
    const a = await createTestTenant(env, SELF);
    for (const path of ["/api/auth/code/request", "/api/auth/code/verify"]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(a.origin + path, { method: "POST", headers: { Origin: a.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email, code: "000000" }) }),
        prodNoRl(), ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBeGreaterThanOrEqual(500);
      const text = await res.text();
      expect(text).not.toMatch(/devCode/);
      expect(text).not.toContain(MASTER);
    }
  });

  it("with a limiter bound, production code request returns exactly {ok:true} (no devCode)", async () => {
    const a = await createTestTenant(env, SELF);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${a.origin}/api/auth/code/request`, { method: "POST", headers: { Origin: a.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email }) }),
      withEnv("production", { RL_AUTH: allow }), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("production refuses a session over plain HTTP", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`http://${a.host}/api/bootstrap`, { headers: { Cookie: `rose_session=${token}` } }), withEnv("production", { RL_AUTH: allow }), ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json().catch(() => ({}))) as { session?: unknown };
    expect(res.status).not.toBe(200);
    expect(body.session ?? null).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("production bootstrap reports dev:false", async () => {
    const a = await createTestTenant(env, SELF);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${a.origin}/api/bootstrap`), withEnv("production", { RL_AUTH: allow }), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await res.json<{ dev: boolean }>()).dev).toBe(false);
  });

  it("/__dev/tick is not available in production", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x.rose.test/__dev/tick", { method: "POST" }), withEnv("production", { RL_AUTH: allow }), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).not.toBe(200);
  });
});

describe("adversarial: development still works", () => {
  it("dev returns a devCode, tolerates missing RL_AUTH, and allows an HTTP session", async () => {
    const a = await createTestTenant(env, SELF);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${a.origin}/api/auth/code/request`, { method: "POST", headers: { Origin: a.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email }) }),
      withEnv("development", { RL_AUTH: undefined }), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await res.json<{ devCode?: string }>()).devCode).toMatch(/^\d{6}$/);

    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(new Request(`http://${a.host}/api/bootstrap`, { headers: { Cookie: `rose_session=${token}` } }), withEnv("development"), ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);
    const boot = await res2.json<{ dev: boolean; session: { user: { email: string } } | null }>();
    expect(boot.dev).toBe(true);
    expect(boot.session?.user.email).toBe(a.email);
  });

  it("dev queue and scheduled run normally", async () => {
    const id = await insertJob("tenant.purge", { tenantId: "tn_nope_dev" });
    const acked: number[] = [];
    await worker.queue({ messages: [{ body: { jobId: id }, ack: () => { acked.push(1); } }] }, withEnv("development"));
    expect(acked.length).toBe(1);
    expect((await jobStatus(id)).attempts).toBe(1);
    await expect(worker.scheduled({}, withEnv("development"), {})).resolves.toBeUndefined();
  });
});
