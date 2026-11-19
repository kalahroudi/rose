// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { addDomain, createTenant, getDomain } from "@rose/core/platform";
import { describe, expect, it } from "vitest";
import worker from "../index";

const ORIGIN = "https://admin.rose.test";
const MASTER = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const odd: unknown[] = [
  undefined, null, "", "test", "staging", "Production", "PRODUCTION", "production ", " development", "development ",
  "Development", "dеvelopment", "dev", 0, true, ["development"], new String("development"),
];
const withEnv = (v: unknown, extra: Record<string, unknown> = {}) => ({ ...env, ENVIRONMENT: v, ...extra }) as never;
const label = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const allow = { limit: () => Promise.resolve({ success: true }) };

async function fetchWith(e: never, path: string, init: RequestInit = {}, origin = ORIGIN): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(origin + path, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const codeReq = (email = "root@example.com"): RequestInit => ({ method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });

let seq = 0;
/** A pending custom domain plus a queued domain.verify job inserted directly (no queue send, so nothing runs it behind our back). */
async function pendingDomain(): Promise<{ hostname: string; jobId: string }> {
  seq++;
  const slug = `adv${seq}${crypto.randomUUID().slice(0, 6)}`;
  const t = await createTenant(env.DB, { name: slug, slug });
  const hostname = `${slug}.customer.example`;
  await addDomain(env.DB, t.id, hostname);
  const jobId = `job_adv_${crypto.randomUUID().replace(/-/g, "")}`;
  const ts = Date.now() - 5_000;
  await env.DB.prepare("INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(jobId, "domain.verify", "platform", "adv", JSON.stringify({ hostname }), ts, null, ts, ts).run();
  return { hostname, jobId };
}
const status = async (h: string) => (await getDomain(env.DB, h))!.status;
const job = async (id: string) => (await env.DB.prepare("SELECT status, attempts FROM jobs WHERE id = ?").bind(id).first<{ status: string; attempts: number }>())!;

describe("adversarial: operator console ENVIRONMENT fails closed", () => {
  it("fetch refuses every route with a generic 500, no cookie, no devCode, no leak", async () => {
    for (const v of odd) {
      for (const [path, init, origin] of [
        ["/api/bootstrap", {}, ORIGIN],
        ["/api/auth/code/request", codeReq(), ORIGIN],
        ["/api/setup", {}, ORIGIN],
        ["/api/bootstrap", {}, "http://admin.rose.test"],
        ["/", {}, ORIGIN],
      ] as const) {
        const res = await fetchWith(withEnv(v), path, init, origin);
        const text = await res.text();
        expect(res.status, `${label(v)} ${path}`).toBe(500);
        expect(res.headers.get("Set-Cookie")).toBeNull();
        expect(text).not.toMatch(/devCode|staging|Production|PRODUCTION|ENVIRONMENT|root@example\.com/);
        expect(text).not.toContain(MASTER);
      }
    }
    expect(await env.DB.prepare("SELECT 1 FROM login_codes WHERE email = 'root@example.com'").first()).toBeNull();
  });

  it("queue: domain.verify does not auto-activate, job untouched, message not acked", async () => {
    for (const v of odd) {
      const { hostname, jobId } = await pendingDomain();
      let acked = 0;
      await expect(worker.queue({ messages: [{ body: { jobId }, ack: () => { acked++; } }] }, withEnv(v)), label(v)).rejects.toThrow();
      expect(acked).toBe(0);
      expect(await status(hostname), label(v)).toBe("pending");
      expect(await job(jobId)).toEqual({ status: "queued", attempts: 0 });
    }
  });

  it("scheduled: the safety-net sweep does not auto-activate a domain", async () => {
    const { hostname, jobId } = await pendingDomain();
    for (const v of odd) {
      await expect(worker.scheduled({}, withEnv(v)), label(v)).rejects.toThrow();
      expect(await status(hostname)).toBe("pending");
      expect(await job(jobId)).toEqual({ status: "queued", attempts: 0 });
    }
  });

  it("queue/scheduled error message does not echo the configured value", async () => {
    const v = "staging-secret-xyz";
    const e1 = await worker.scheduled({}, withEnv(v)).then(() => null, (e: unknown) => e as Error);
    const e2 = await worker.queue({ messages: [] }, withEnv(v)).then(() => null, (e: unknown) => e as Error);
    for (const e of [e1, e2]) {
      expect(e).toBeInstanceOf(Error);
      expect(`${e!.message} ${e!.stack ?? ""}`).not.toContain(v);
    }
  });
});

describe("adversarial: operator console in production", () => {
  it("domain.verify without a Cloudflare connection fails the domain instead of activating it", async () => {
    const { hostname, jobId } = await pendingDomain();
    await worker.queue({ messages: [{ body: { jobId }, ack() {} }] }, withEnv("production", { RL_AUTH: allow }));
    expect(await status(hostname)).toBe("failed");
  });

  it("scheduled sweep in production does not activate either", async () => {
    const { hostname } = await pendingDomain();
    await worker.scheduled({}, withEnv("production", { RL_AUTH: allow }));
    expect(await status(hostname)).not.toBe("active");
  });

  it("code request returns no devCode", async () => {
    const res = await fetchWith(withEnv("production", { RL_AUTH: allow }), "/api/auth/code/request", codeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("missing RL_AUTH fails closed", async () => {
    const res = await fetchWith(withEnv("production", { RL_AUTH: undefined }), "/api/auth/code/request", codeReq());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const text = await res.text();
    expect(text).not.toMatch(/devCode/);
    expect(text).not.toContain(MASTER);
  });

  it("refuses a session over plain HTTP", async () => {
    // Obtain a real operator session through development sign-in, then replay it over HTTP in production.
    const dev = withEnv("development");
    const { devCode } = await (await fetchWith(dev, "/api/auth/code/request", codeReq())).json<{ devCode: string }>();
    const v = await fetchWith(dev, "/api/auth/code/verify", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email: "root@example.com", code: devCode }) });
    expect(v.status).toBe(200);
    const token = (v.headers.get("Set-Cookie") ?? "").split(";")[0]!.split("=")[1]!;
    expect(token.length).toBeGreaterThan(10);
    const res = await fetchWith(withEnv("production", { RL_AUTH: allow }), "/api/bootstrap", { headers: { Cookie: `rose_admin=${token}` } }, "http://admin.rose.test");
    expect(res.status).not.toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("adversarial: operator console in development still works", () => {
  it("devCode is returned, missing RL_AUTH tolerated, domain auto-activates without Cloudflare", async () => {
    const res = await fetchWith(withEnv("development", { RL_AUTH: undefined }), "/api/auth/code/request", codeReq("root@example.com"));
    expect(res.status).toBe(200);
    expect((await res.json<{ devCode?: string }>()).devCode).toMatch(/^\d{6}$/);

    const { hostname, jobId } = await pendingDomain();
    await worker.queue({ messages: [{ body: { jobId }, ack() {} }] }, withEnv("development"));
    expect(await status(hostname)).toBe("active");
    await expect(worker.scheduled({}, withEnv("development"))).resolves.toBeUndefined();
  });
});
