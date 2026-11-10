// SPDX-License-Identifier: Apache-2.0
// Test helpers. Only usable inside the Workers test runtime (`cloudflare:test`).
import { describe, expect, it } from "vitest";
import { createSession } from "../control/sessions";
import { createTenant } from "../control/tenants";
import { addMembership, ensureUser, type Role } from "../control/users";
import type { TenantWorkerEnv } from "../env";
import { newId } from "../ids";
import type { ModuleDefinition } from "../modules";

export interface TestTenant {
  id: string;
  slug: string;
  host: string;
  origin: string;
  /** Session cookie header for a user of this tenant. */
  cookie: string;
  userId: string;
  email: string;
  /** Call the worker as this tenant's user. */
  fetch(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string | null }): Promise<Response>;
}

type Fetcher = { fetch(input: Request): Promise<Response> };

/** Create a tenant with one signed-in user. Each call yields a fully separate tenant. */
export async function createTestTenant(env: TenantWorkerEnv, worker: Fetcher, opts: { role?: Role; slug?: string } = {}): Promise<TestTenant> {
  const slug = opts.slug ?? `t${newId("x").slice(2, 14)}`;
  const tenant = await createTenant(env.DB, { name: `Tenant ${slug}`, slug });
  const email = `${opts.role ?? "owner"}@${slug}.example`;
  const user = await ensureUser(env.DB, email);
  await addMembership(env.DB, tenant.id, user.id, opts.role ?? "owner");
  const { token } = await createSession(env.DB, { userId: user.id, scope: tenant.id, method: "test" });
  const host = `${slug}.${env.APP_BASE_DOMAIN}`;
  const origin = `https://${host}`;
  const cookie = `__Host-rose_session=${token}`;
  return {
    id: tenant.id, slug, host, origin, cookie, userId: user.id, email,
    fetch(path, init = {}) {
      const headers: Record<string, string> = { Origin: origin, ...init.headers };
      const useCookie = init.cookie === undefined ? cookie : init.cookie;
      if (useCookie) headers.Cookie = useCookie;
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      return worker.fetch(new Request(origin + path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
    },
  };
}

/**
 * The tenant-isolation contract, run against every module. A module passes only if
 * nothing tenant A stores is visible to, or changeable by, tenant B, an anonymous
 * caller, or A's own cookie replayed on B's host.
 *
 * Usage (in a test file):  describeTenantIsolation(env, SELF, modules)
 */
export function describeTenantIsolation(env: TenantWorkerEnv, worker: Fetcher, modules: ModuleDefinition[]): void {
  describe.each(modules.map((m) => [m.id, m] as const))("tenant isolation: module %s", (_id, mod) => {
    const base = `/api/m/${mod.id}`;
    const setup = async () => {
      const a = await createTestTenant(env, worker);
      const b = await createTestTenant(env, worker);
      const marker = `MARKER-${newId("m")}`;
      const req = mod.isolationProbe.create(marker);
      const res = await a.fetch(base + (req.path === "/" ? "" : req.path), { body: req.body });
      expect(res.status, `probe create failed: ${await res.clone().text()}`).toBeLessThan(300);
      const created = (await res.json()) as Record<string, unknown>;
      const item = base + mod.isolationProbe.itemPath(created);
      const list = base + (mod.isolationProbe.listPath === "/" ? "" : mod.isolationProbe.listPath);
      return { a, b, marker, item, list };
    };

    it("owner tenant can read what it created (probe is meaningful)", async () => {
      const { a, marker, item, list } = await setup();
      expect(await (await a.fetch(list)).text()).toContain(marker);
      expect((await a.fetch(item)).status).toBe(200);
    });

    it("another tenant can not list it", async () => {
      const { b, marker, list } = await setup();
      const res = await b.fetch(list);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(marker);
    });

    it("another tenant can not read, change or delete it by id", async () => {
      const { a, b, marker, item } = await setup();
      const read = await b.fetch(item);
      expect(read.status).toBe(404);
      expect(await read.text()).not.toContain(marker);
      for (const method of ["PATCH", "PUT", "DELETE"]) {
        const res = await b.fetch(item, { method, body: method === "DELETE" ? undefined : {} });
        expect([404, 405, 422]).toContain(res.status);
      }
      expect((await a.fetch(item)).status).toBe(200);
    });

    it("a session from one tenant is rejected on another tenant's host", async () => {
      const { a, b, item, list } = await setup();
      expect((await b.fetch(list, { cookie: a.cookie })).status).toBe(401);
      expect((await b.fetch(item, { cookie: a.cookie })).status).toBe(401);
    });

    it("anonymous callers get nothing", async () => {
      const { a, marker, item, list } = await setup();
      for (const path of [list, item]) {
        const res = await a.fetch(path, { cookie: null });
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain(marker);
      }
    });

    it("every route requires authentication", async () => {
      const { a } = await setup();
      for (const route of mod.routes) {
        const path = base + (route.path === "/" ? "" : route.path.replace(/:[a-zA-Z]+/g, "x"));
        const res = await a.fetch(path, { method: route.method, cookie: null, body: route.method === "GET" || route.method === "DELETE" ? undefined : {} });
        expect(res.status, `${route.method} ${path}`).toBe(401);
      }
    });

    it("cross-site writes are blocked", async () => {
      const { a, list } = await setup();
      const res = await a.fetch(list, { method: "POST", body: {}, headers: { Origin: "https://evil.example" } });
      expect(res.status).toBe(403);
    });
  });
}
