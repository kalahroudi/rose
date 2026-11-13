// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { createTenant } from "@rose/core/platform";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
type Init = { method?: string; body?: BodyInit | null; json?: unknown; cookie?: string; origin?: string; headers?: Record<string, string> };
const call = (path: string, init: Init = {}) =>
  SELF.fetch(ORIGIN + path, {
    method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
    redirect: "manual",
    headers: {
      Origin: init.origin ?? ORIGIN,
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? undefined),
  });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

let rootCookie: string | null = null;
async function root(): Promise<string> {
  if (rootCookie) return rootCookie;
  const email = "root@rose.test";
  const { devCode } = await json<{ devCode: string }>(call("/api/auth/code/request", { json: { email } }));
  const res = await call("/api/auth/code/verify", { json: { email, code: devCode } });
  return (rootCookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!);
}

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const payload = { name: "Sneaky", slug: "sneaky-create", ownerEmail: "attacker@evil.example", plan: "free" };

describe("operator tenant creation is gone", () => {
  it("no variant of the create request creates a tenant or an invitation", async () => {
    const cookie = await root();
    const tenantsBefore = await count("tenants");
    const invitesBefore = await count("invitations");
    const attempts: [string, Init][] = [
      ["/api/tenants", { json: payload, cookie }],
      ["/api/tenants/", { json: payload, cookie }],
      ["/api/TENANTS", { json: payload, cookie }],
      ["/api/tenants?ownerEmail=attacker@evil.example&slug=sneaky-create&name=x", { method: "POST", cookie }],
      ["/api/tenants", { json: payload, cookie, headers: { "X-HTTP-Method-Override": "POST" }, method: "PUT" }],
      ["/api/tenants", { json: payload, cookie, method: "PUT" }],
      ["/api/tenants", { json: payload, cookie, method: "PATCH" }],
      ["/api/tenants", { body: "name=x&slug=sneaky-create&ownerEmail=a@b.co", cookie, headers: { "Content-Type": "application/x-www-form-urlencoded" } }],
      ["/api/tenants", { body: "{not json", cookie, headers: { "Content-Type": "application/json" } }],
      ["/api/tenants", { body: new Uint8Array(2_000_000), cookie, headers: { "Content-Type": "application/json" } }],
      ["/api/tenants/new", { json: payload, cookie }],
      ["/api/tenants/%2e%2e/tenants", { json: payload, cookie }],
      ["/api/tenants/tn_x/owners", { json: { email: "attacker@evil.example" }, cookie }],
      ["/api/tenants/tn_x/invitations", { json: { email: "attacker@evil.example", role: "owner" }, cookie }],
      ["/api/tenants/bulk", { json: { action: "create", ...payload }, cookie }],
    ];
    for (const [path, init] of attempts) {
      const res = await call(path, init);
      expect([400, 404, 405, 413, 422], `${init.method ?? "POST"} ${path}`).toContain(res.status);
      expect(res.status, `${path} must not report success`).toBeGreaterThanOrEqual(400);
    }
    expect(await count("tenants")).toBe(tenantsBefore);
    expect(await count("invitations")).toBe(invitesBefore);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE slug = 'sneaky-create'").first()).toBeNull();
  });

  it("unauthenticated and cross-site callers are rejected before routing and nothing is created", async () => {
    const cookie = await root();
    const before = await count("tenants");
    expect((await call("/api/tenants", { json: payload })).status).toBe(401);
    expect((await call("/api/tenants", { json: payload, cookie: "__Host-rose_admin=forged" })).status).toBe(401);
    expect((await call("/api/tenants", { json: payload, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/tenants", { json: payload, cookie, origin: "null" })).status).toBe(403);
    expect((await call("/api/tenants/tn_x/owners", { json: { email: "a@evil.example" }, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(await count("tenants")).toBe(before);
  });

  it("a tenant-scoped session cookie can not reach the removed routes either", async () => {
    const { createSession } = await import("../../../../packages/core/src/control/sessions");
    const { ensureUser, addMembership } = await import("@rose/core/platform");
    const t = await createTenant(env.DB, { name: "Victim", slug: "victim" });
    const u = await ensureUser(env.DB, "member@victim.example");
    await addMembership(env.DB, t.id, u.id, "owner");
    const s = await createSession(env.DB, { userId: u.id, scope: t.id } as never).catch(() => null);
    const token = s && typeof s === "object" && "token" in s ? String((s as { token: string }).token) : "invalid";
    for (const path of ["/api/tenants", `/api/tenants/${t.id}/owners`]) {
      const res = await call(path, { json: payload, cookie: `__Host-rose_admin=${token}` });
      expect([401, 403]).toContain(res.status);
    }
    expect(await env.DB.prepare("SELECT 1 FROM invitations WHERE tenant_id = ?").bind(t.id).first()).toBeNull();
  });
});

describe("tenant management that remains", () => {
  it("lists tenants with a bounded page size and rejects anonymous callers", async () => {
    const cookie = await root();
    for (let i = 0; i < 3; i++) await createTenant(env.DB, { name: `Seed ${i}`, slug: `seed-list-${i}` });
    expect((await call("/api/tenants")).status).toBe(401);
    for (const size of ["100000", "-1", "0", "abc", "1e9"]) {
      const res = await call(`/api/tenants?pageSize=${size}`, { cookie });
      if (res.status === 200) expect((await res.json<{ items: unknown[] }>()).items.length).toBeLessThanOrEqual(100);
      else expect(res.status).toBeLessThan(500);
    }
    const page = await json<{ total: number; items: { slug: string }[] }>(call("/api/tenants?q=seed-list&pageSize=2", { cookie }));
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("treats search input as data, not SQL", async () => {
    const cookie = await root();
    for (const q of ["'; DROP TABLE tenants; --", "%", "_", "\" OR 1=1 --", "a".repeat(5000)]) {
      expect((await call(`/api/tenants?q=${encodeURIComponent(q)}`, { cookie })).status).toBeLessThan(500);
    }
    expect(await count("tenants")).toBeGreaterThan(0);
  });

  it("get, update and members still work, and unknown or malformed ids are 404", async () => {
    const cookie = await root();
    const t = await createTenant(env.DB, { name: "Keep", slug: "keep-me" });
    expect((await call(`/api/tenants/${t.id}`, { cookie })).status).toBe(200);
    expect((await json<{ name: string }>(call(`/api/tenants/${t.id}`, { cookie, method: "PATCH", json: { name: "Kept" } }))).name).toBe("Kept");
    expect((await json<{ total: number }>(call(`/api/tenants/${t.id}/members`, { cookie }))).total).toBe(0);
    for (const id of ["tn_nope", "' OR 1=1 --", "..%2f", "%00"]) {
      expect((await call(`/api/tenants/${encodeURIComponent(id)}`, { cookie })).status).toBe(404);
      expect((await call(`/api/tenants/${encodeURIComponent(id)}/members`, { cookie })).status).toBe(404);
    }
  });

  it("PATCH can not smuggle ownership, slug or status changes", async () => {
    const cookie = await root();
    const t = await createTenant(env.DB, { name: "Fixed", slug: "fixed-slug" });
    await call(`/api/tenants/${t.id}`, { cookie, method: "PATCH", json: { name: "Fixed2", slug: "hijack", status: "deleting", ownerEmail: "x@evil.example", id: "tn_other" } });
    const row = await env.DB.prepare("SELECT slug, status FROM tenants WHERE id = ?").bind(t.id).first<{ slug: string; status: string }>();
    expect(row).toEqual({ slug: "fixed-slug", status: "active" });
    expect(await env.DB.prepare("SELECT 1 FROM invitations WHERE tenant_id = ?").bind(t.id).first()).toBeNull();
  });

  it("bulk actions only accept suspend/resume and cap the id list", async () => {
    const cookie = await root();
    expect((await call("/api/tenants/bulk", { cookie, json: { action: "delete", ids: ["tn_x"] } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("/api/tenants/bulk", { cookie, json: { action: "suspend", ids: Array.from({ length: 101 }, (_, i) => `tn_${i}`) } })).status).toBe(422);
    expect((await call("/api/tenants/bulk", { cookie, json: { action: "suspend" } })).status).toBe(422);
  });
});
