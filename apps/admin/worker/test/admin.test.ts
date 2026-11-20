// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { createInvitation, createTenant } from "@rose/core/platform";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) =>
  SELF.fetch(ORIGIN + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { Origin: init.origin ?? ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
// Tenants are created only by self-serve sign-up, so the console has no create route; tests seed them directly.
const seed = (slug: string, name = slug) => createTenant(env.DB, { name, slug });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

async function signIn(email: string): Promise<string | null> {
  const { devCode } = await json<{ devCode?: string }>(call("/api/auth/code/request", { body: { email } }));
  if (!devCode) return null;
  const res = await call("/api/auth/code/verify", { body: { email, code: devCode } });
  return res.ok ? (res.headers.get("Set-Cookie") ?? "").split(";")[0]! : null;
}

// Storage is shared within this file, so sign the bootstrap owner in once (codes are rate limited).
let rootCookie: string | null = null;
const root = async () => (rootCookie ??= await signIn("root@example.com"))!;

/** A session as a passkey sign-in would leave it, optionally backdated. */
async function sessionFor(email: string, method: string, ageMs = 0): Promise<string> {
  const { createSession } = await import("../../../../packages/core/src/control/sessions");
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  const { token } = await createSession(env.DB, { userId: user!.id, scope: "platform", method });
  if (ageMs) await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE user_id = ? AND scope = 'platform'").bind(ageMs, user!.id).run();
  return `__Host-rose_admin=${token}`;
}

describe("operator console", () => {
  it("has no path to tenant data: no tenant database binding, no tenant key", () => {
    expect(Object.keys(env)).not.toContain("TENANT_DO");
  });

  it("only the bootstrap address can become the first operator; strangers get nothing", async () => {
    expect(await signIn("stranger@example.com")).toBeNull();
    const cookie = await root();
    expect(cookie).toMatch(/^__Host-rose_admin=/);
    const boot = await json<{ session: { role: string } }>(call("/api/bootstrap", { cookie }));
    expect(boot.session.role).toBe("owner");
  });

  it("rejects unauthenticated and cross-site requests", async () => {
    expect((await call("/api/tenants")).status).toBe(401);
    const cookie = await root();
    expect((await call("/api/tenants/bulk", { cookie, origin: "https://evil.example", body: { action: "suspend", ids: ["tn_none"] } })).status).toBe(403);
  });

  it("a tenant session is not an operator session", async () => {
    await root();
    const t = await seed("acme", "Acme");
    // Forge the best case for an attacker: a real, valid session for a tenant, presented under the admin cookie name.
    const { createSession } = await import("../../../../packages/core/src/control/sessions");
    const { ensureUser, addMembership } = await import("@rose/core/platform");
    const user = await ensureUser(env.DB, "owner@acme.example");
    await addMembership(env.DB, t.id, user.id, "owner");
    const { token } = await createSession(env.DB, { userId: user.id, scope: t.id, method: "test" });
    expect((await call("/api/tenants", { cookie: `__Host-rose_admin=${token}` })).status).toBe(401);
  });

  it("manages the tenant lifecycle with audit trail", async () => {
    const cookie = await root();
    const t = await seed("globex", "Globex");

    const list = await json<{ total: number; items: { slug: string }[] }>(call("/api/tenants?q=glob&status=active", { cookie }));
    expect(list.items.map((i) => i.slug)).toEqual(["globex"]);

    expect(await json(call("/api/tenants/bulk", { cookie, body: { action: "suspend", filter: { q: "globex" } } }))).toEqual({ affected: 1 });
    expect((await json<{ status: string }>(call(`/api/tenants/${t.id}`, { cookie }))).status).toBe("suspended");

    const fresh = await sessionFor("root@example.com", "passkey");
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: fresh, body: { confirm: "nope" } })).status).toBe(422);
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: fresh, body: { confirm: "globex" } })).status).toBe(202);
    expect((await json<{ status: string }>(call(`/api/tenants/${t.id}`, { cookie }))).status).toBe("pending_deletion");
    // A tenant being deleted can not be resumed.
    expect(await json(call("/api/tenants/bulk", { cookie, body: { action: "resume", ids: [t.id] } }))).toEqual({ affected: 0 });

    const audit = await json<{ items: { action: string }[] }>(call("/api/audit?action=tenant.", { cookie }));
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.suspend", "tenant.delete.requested"]));
    const jobs = await json<{ items: { type: string; status: string }[] }>(call("/api/jobs", { cookie }));
    expect(jobs.items[0]).toMatchObject({ type: "tenant.purge", status: "queued" });
  });

  it("deletion needs a platform owner with a fresh passkey sign-in, enters a 48 hour grace period and can be cancelled", async () => {
    const cookie = await root();
    const t = await seed("initech", "Initech");
    const body = { confirm: "initech" };
    // Not an owner.
    // Adding operators needs a fresh passkey session: an ordinary code session is refused.
    const addOps2 = await call("/api/operators", { cookie, body: { email: "ops2@rose.test" } });
    expect(addOps2.status).toBe(403);
    expect((await json<{ error: { code: string } }>(addOps2)).error.code).toBe("reauth_required");
    expect((await call("/api/operators", { cookie: await sessionFor("root@example.com", "passkey", 11 * 60_000), body: { email: "ops2@rose.test" } })).status).toBe(403);
    expect((await call("/api/operators", { cookie: await sessionFor("root@example.com", "passkey"), body: { email: "ops2@rose.test" } })).status).toBe(201);
    const opCookie = await sessionFor("ops2@rose.test", "passkey");
    for (const path of [`/api/tenants/${t.id}/delete`, `/api/tenants/${t.id}/delete/cancel`]) {
      const r = await call(path, { cookie: opCookie, body });
      expect(r.status).toBe(403);
      expect((await json<{ error: { code: string } }>(r)).error.code).toBe("forbidden");
    }
    // An owner whose session is not from a passkey, or is older than 10 minutes.
    for (const c of [cookie, await sessionFor("root@example.com", "passkey", 11 * 60_000)]) {
      const r = await call(`/api/tenants/${t.id}/delete`, { cookie: c, body });
      expect(r.status).toBe(403);
      expect((await json<{ error: { code: string } }>(r)).error.code).toBe("reauth_required");
    }
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie, body: {} })).status).toBe(403);
    expect((await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(t.id).first<{ status: string }>())!.status).toBe("active");

    const fresh = await sessionFor("root@example.com", "passkey");
    const res = await json<{ deleteAfter: number }>(call(`/api/tenants/${t.id}/delete`, { cookie: fresh, body }));
    expect(res.deleteAfter).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    const row = await env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(t.id).first<{ status: string; delete_after: number }>();
    expect(row).toEqual({ status: "pending_deletion", delete_after: res.deleteAfter });
    const job = await env.DB.prepare("SELECT run_after FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(t.id).first<{ run_after: number }>();
    expect(job!.run_after).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    // Bulk resume can not revive it.
    expect(await json(call("/api/tenants/bulk", { cookie, body: { action: "resume", ids: [t.id] } }))).toEqual({ affected: 0 });

    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: fresh, body: {} })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(t.id).first())).toEqual({ status: "active", delete_after: null });
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(t.id).first()).toBeNull();
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: fresh, body: {} })).status).toBe(409);
    const audit = await json<{ items: { action: string }[] }>(call("/api/audit?action=tenant.delete", { cookie }));
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.delete.requested", "tenant.delete.cancelled"]));
  });

  it("custom domains can not shadow the platform namespace or another tenant", async () => {
    const cookie = await root();
    const a = await seed("dom-a", "A");
    const b = await seed("dom-b", "B");
    expect((await call(`/api/tenants/${a.id}/domains`, { cookie, body: { hostname: "dom-b.rose.test" } })).status).toBe(422);
    expect((await call(`/api/tenants/${a.id}/domains`, { cookie, body: { hostname: "App.Customer.com" } })).status).toBe(202);
    expect((await call(`/api/tenants/${b.id}/domains`, { cookie, body: { hostname: "app.customer.com" } })).status).toBe(409);
    expect((await json<{ items: { status: string }[] }>(call("/api/domains?q=customer", { cookie }))).items[0]!.status).toBe("pending");
  });

  it("only owners manage operators and connections; the last owner can not be removed", async () => {
    const cookie = await root();
    expect((await call("/api/operators", { cookie: await sessionFor("root@example.com", "passkey"), body: { email: "ops@rose.test" } })).status).toBe(201);
    const ops = (await signIn("ops@rose.test"))!;
    expect((await call("/api/operators", { cookie: ops, body: { email: "x@rose.test" } })).status).toBe(403);
    expect((await call("/api/setup/cloudflare", { cookie: ops, method: "PUT", body: { zoneId: "a".repeat(32), apiToken: "t".repeat(40) } })).status).toBe(403);
    const me = await json<{ session: { user: { id: string } } }>(call("/api/bootstrap", { cookie }));
    expect((await call(`/api/operators/${me.session.user.id}`, { cookie, method: "DELETE" })).status).toBe(403);
    expect((await call(`/api/operators/${me.session.user.id}`, { cookie: await sessionFor("root@example.com", "passkey"), method: "DELETE" })).status).toBe(409);
  });

  it("reports setup health and encrypts stored secrets", async () => {
    const cookie = await root();
    const setup = await json<{ checks: { id: string; status: string }[] }>(call("/api/setup", { cookie }));
    expect(setup.checks.find((c) => c.id === "master-key")!.status).toBe("ok");
    const { putSetting, getSetting } = await import("@rose/core/platform");
    await putSetting(env.DB, env.ROSE_MASTER_KEY, "cloudflare.api_token", "super-secret-token", true);
    const raw = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'cloudflare.api_token'").first<{ value: string }>();
    expect(raw!.value).not.toContain("super-secret-token");
    expect(await getSetting(env.DB, env.ROSE_MASTER_KEY, "cloudflare.api_token")).toBe("super-secret-token");
    // The API never returns the token.
    expect(JSON.stringify(await json(call("/api/setup", { cookie })))).not.toContain("super-secret-token");
  });

  it("reconnects GitHub with an empty token and keeps the stored one", async () => {
    const cookie = await root();
    const { putSetting, getSetting } = await import("@rose/core/platform");
    const secret = "stored-github-token";
    await putSetting(env.DB, env.ROSE_MASTER_KEY, "github.token", secret, true);
    const sealed = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'github.token'").first<{ value: string }>();
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (req.url !== "https://api.github.com/repos/acme/rose") return realFetch(input, init);
      if (req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("no", { status: 401 });
      return Response.json({ full_name: "acme/rose", default_branch: "main", private: true });
    };
    try {
      const res = await call("/api/setup/github", { cookie, method: "PUT", body: { repo: "acme/rose", token: "" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, repo: "acme/rose" });
      expect(await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'github.token'").first()).toEqual(sealed);
      expect(await getSetting(env.DB, env.ROSE_MASTER_KEY, "github.token")).toBe(secret);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a tenant-scoped job is neither listed nor retryable", async () => {
    const cookie = await root();
    const t = await seed("jobleak", "JobLeak");
    const allBefore = (await json<{ total: number }>(call("/api/jobs?pageSize=100", { cookie }))).total;
    const failedBefore = (await json<{ failedJobs: number }>(call("/api/overview", { cookie }))).failedJobs;
    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    const title = "Import contacts for jobleak";
    const error = "tenant-private import failed";
    const ts = Date.now();
    await env.DB.prepare(
      "INSERT INTO jobs (id, type, scope, title, status, payload, error, attempts, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', '{}', ?, 4, ?, NULL, ?, ?)",
    )
      .bind(id, "m.contacts.import", t.id, title, error, ts, ts, ts)
      .run();

    const listed = await json<{ total: number; items: { id: string }[] }>(call("/api/jobs?pageSize=100", { cookie }));
    expect(listed.total).toBe(allBefore);
    expect(listed.items.map((j) => j.id)).not.toContain(id);
    expect(JSON.stringify(listed)).not.toContain(title);
    expect(JSON.stringify(listed)).not.toContain(error);
    expect((await json<{ failedJobs: number }>(call("/api/overview", { cookie }))).failedJobs).toBe(failedBefore);

    expect((await call(`/api/jobs/${id}/retry`, { cookie })).status).toBe(404);
    expect(await env.DB.prepare("SELECT status, attempts, error, scope FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "failed", attempts: 4, error, scope: t.id });
    expect(await env.DB.prepare("SELECT 1 FROM platform_audit WHERE action = 'job.retry' AND target = ?").bind(id).first()).toBeNull();
  });
});

describe("pending deletion edge cases", () => {
  it("cancel restores a prior suspension, a repeat delete is idempotent, and a pending tenant takes no edits", async () => {
    const cookie = await root();
    const t = await seed("hooli", "Hooli");
    await call("/api/tenants/bulk", { cookie, body: { action: "suspend", ids: [t.id] } });
    const fresh = await sessionFor("root@example.com", "passkey");
    const body = { confirm: "hooli" };
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: fresh, body })).status).toBe(202);
    const again = await json<{ alreadyPending?: boolean }>(call(`/api/tenants/${t.id}/delete`, { cookie: fresh, body }));
    expect(again.alreadyPending).toBe(true);
    const n = (sql: string) => env.DB.prepare(sql).bind(t.id).first<{ n: number }>().then((r) => r!.n);
    expect(await n("SELECT COUNT(*) AS n FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?")).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'tenant.delete.requested' AND target = ?")).toBe(1);
    expect((await call(`/api/tenants/${t.id}`, { cookie, method: "PATCH", body: { name: "X" } })).status).toBe(409);
    expect((await call(`/api/tenants/${t.id}/domains`, { cookie, body: { hostname: "app.hooli.example.com" } })).status).toBe(409);
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: fresh, body: {} })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(t.id).first<{ status: string }>())!.status).toBe("suspended");
    const audit = await env.DB.prepare("SELECT meta FROM platform_audit WHERE action = 'tenant.delete.cancelled' AND target = ?").bind(t.id).first<{ meta: string }>();
    expect(audit!.meta).toContain("suspended");
  });

  it("a stale session can not enrol or remove passkeys", async () => {
    await root();
    const stale = await sessionFor("root@example.com", "code", 11 * 60_000);
    const r = await call("/api/auth/passkey/register/options", { cookie: stale, body: {} });
    expect(r.status).toBe(403);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe("reauth_required");
    expect((await call("/api/auth/passkeys/x", { cookie: stale, method: "DELETE" })).status).toBe(403);
  });
});

describe("no operator tenant creation", () => {
  it("the console has no route to create a tenant or invite its owner; sign-up is the only path", async () => {
    const cookie = await root();
    const body = { name: "Nope", slug: "nope-create", ownerEmail: "owner@nope.example" };
    expect([404, 405]).toContain((await call("/api/tenants", { cookie, body })).status);
    expect([401, 404, 405]).toContain((await call("/api/tenants", { body })).status);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE slug = 'nope-create'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM invitations WHERE email = 'owner@nope.example'").first()).toBeNull();
  });
});

describe("no break-glass owner grants", () => {
  it("the console has no route to add an owner to a tenant, for owners or anonymous callers", async () => {
    const cookie = await root();
    const t = await seed("noglass", "NoGlass");
    await createInvitation(env.DB, t.id, { email: "o@noglass.example", role: "owner", invitedBy: "signup", actorRole: "owner" });
    for (const email of ["attacker@rose.test", "ATTACKER@rose.test", "not-an-address", ""]) {
      const res = await call(`/api/tenants/${t.id}/owners`, { cookie, body: { email } });
      expect([404, 405]).toContain(res.status);
    }
    for (const method of ["PUT", "PATCH", "DELETE", "GET"]) expect([404, 405]).toContain((await call(`/api/tenants/${t.id}/owners`, { cookie, method })).status);
    expect([401, 404, 405]).toContain((await call(`/api/tenants/${t.id}/owners`, { body: { email: "attacker@rose.test" } })).status);
    // Nothing was created by the attempts: only the original owner invitation exists.
    const invs = await env.DB.prepare("SELECT email, role FROM invitations WHERE tenant_id = ?").bind(t.id).all<{ email: string; role: string }>();
    expect(invs.results).toEqual([{ email: "o@noglass.example", role: "owner" }]);
    expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ?").bind(t.id).first()).toBeNull();
    const audit = await json<{ items: { action: string }[] }>(call("/api/audit?pageSize=100", { cookie }));
    expect(audit.items.map((a) => a.action)).not.toContain("tenant.owner.invite");
  });
});
