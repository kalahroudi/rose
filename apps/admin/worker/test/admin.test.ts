// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { createInvitation, createTenant } from "@rose/core/platform";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) =>
  SELF.fetch(ORIGIN + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { Origin: init.origin ?? ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
const root = async () => (rootCookie ??= await signIn("root@rose.test"))!;

describe("operator console", () => {
  it("has no path to tenant data: no tenant database binding, no tenant key", () => {
    expect(Object.keys(env)).not.toContain("TENANT_DO");
  });

  it("only the bootstrap address can become the first operator; strangers get nothing", async () => {
    expect(await signIn("stranger@example.com")).toBeNull();
    const cookie = await root();
    expect(cookie).toMatch(/^__Host-rose_admin=/);
    const boot = await json<{ session: { role: string } }>(call("/api/bootstrap", { cookie: cookie! }));
    expect(boot.session.role).toBe("owner");
  });

  it("rejects unauthenticated and cross-site requests", async () => {
    expect((await call("/api/tenants")).status).toBe(401);
    const cookie = await root();
    expect((await call("/api/tenants/bulk", { cookie, origin: "https://evil.example", body: { action: "suspend", ids: ["tn_none"] } })).status).toBe(403);
  });

  it("a tenant session is not an operator session", async () => {
    const cookie = await root();
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

    expect((await call(`/api/tenants/${t.id}/delete`, { cookie, body: { confirm: "nope" } })).status).toBe(422);
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie, body: { confirm: "globex" } })).status).toBe(202);
    expect((await json<{ status: string }>(call(`/api/tenants/${t.id}`, { cookie }))).status).toBe("deleting");
    // A tenant being deleted can not be resumed.
    expect(await json(call("/api/tenants/bulk", { cookie, body: { action: "resume", ids: [t.id] } }))).toEqual({ affected: 0 });

    const audit = await json<{ items: { action: string }[] }>(call("/api/audit?action=tenant.", { cookie }));
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.suspend", "tenant.delete.requested"]));
    const jobs = await json<{ items: { type: string; status: string }[] }>(call("/api/jobs", { cookie }));
    expect(jobs.items[0]).toMatchObject({ type: "tenant.purge", status: "queued" });
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
    expect((await call("/api/operators", { cookie, body: { email: "ops@rose.test" } })).status).toBe(201);
    const ops = (await signIn("ops@rose.test"))!;
    expect((await call("/api/operators", { cookie: ops, body: { email: "x@rose.test" } })).status).toBe(403);
    expect((await call("/api/setup/cloudflare", { cookie: ops, method: "PUT", body: { zoneId: "a".repeat(32), apiToken: "t".repeat(40) } })).status).toBe(403);
    const me = await json<{ session: { user: { id: string } } }>(call("/api/bootstrap", { cookie }));
    expect((await call(`/api/operators/${me.session.user.id}`, { cookie, method: "DELETE" })).status).toBe(409);
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
