// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../src/control/users";
import {
  createTenant,
  createTenantForOwner,
  listTenants,
  setTenantStatus,
  tenantCounts,
  tenantSignupSeries,
  updateTenant,
  validateSlug,
} from "../src/control/tenants";
import { AppError } from "../src/errors";

const rnd = () => Math.random().toString(36).slice(2, 10);
const slug = () => `tn-${rnd()}`;
const throwOf = (fn: () => unknown): AppError => {
  try { fn(); } catch (e) { return e as AppError; }
  throw new Error("expected an error to be thrown");
};
const statusOf = (id: string) => env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(id).first<{ status: string }>();

describe("validateSlug", () => {
  it("trims, lower-cases and accepts a valid slug", () => {
    expect(validateSlug("  My-Slug ")).toBe("my-slug");
    expect(validateSlug("a1-b2")).toBe("a1-b2");
  });

  it.each(["a", "ab", "-abc", "abc-", "a--b", "a.b", "A B", `${"x".repeat(41)}`, ""])(
    "rejects malformed or out-of-range slug %j",
    (s) => {
      expect(throwOf(() => validateSlug(s)).code).toBe("invalid");
    },
  );

  it("rejects reserved platform slugs", () => {
    for (const s of ["admin", "www", "api", "app", "console"]) {
      expect(throwOf(() => validateSlug(s)).code).toBe("invalid");
    }
  });
});

describe("createTenant", () => {
  it("creates an active tenant on the free plan by default, honouring a plan override", async () => {
    const s = slug();
    const t = await createTenant(env.DB, { name: "Acme", slug: s, plan: "pro" });
    expect(t.slug).toBe(s);
    expect(t.status).toBe("active");
    expect(t.plan).toBe("pro");
    expect(await statusOf(t.id)).toMatchObject({ status: "active" });
  });

  it("rejects an empty or over-long name", async () => {
    for (const name of ["", "   ", "x".repeat(81)]) {
      await expect(createTenant(env.DB, { name, slug: slug() })).rejects.toMatchObject({ code: "invalid", status: 422 });
    }
  });

  it("rejects a duplicate slug with a conflict", async () => {
    const s = slug();
    await createTenant(env.DB, { name: "One", slug: s });
    await expect(createTenant(env.DB, { name: "Two", slug: s })).rejects.toMatchObject({ code: "conflict", status: 409 });
  });
});

describe("createTenantForOwner", () => {
  const user = () => ensureUser(env.DB, `owner-${rnd()}@example.com`);
  const ownedCount = (id: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.role = 'owner' AND t.status != 'deleting'").bind(id).first<{ n: number }>();

  it("creates the tenant and an owner membership while under the cap", async () => {
    const u = await user();
    const t = await createTenantForOwner(env.DB, u.id, { name: "New", slug: slug() }, 5);
    expect(t).not.toBeNull();
    expect((await ownedCount(u.id))!.n).toBe(1);
    const m = await env.DB.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?").bind(t!.id, u.id).first<{ role: string }>();
    expect(m!.role).toBe("owner");
  });

  it("writes nothing and returns null once the cap is reached", async () => {
    const u = await user();
    await createTenantForOwner(env.DB, u.id, { name: "A", slug: slug() }, 1);
    const before = (await ownedCount(u.id))!.n;
    const t = await createTenantForOwner(env.DB, u.id, { name: "B", slug: slug() }, 1);
    expect(t).toBeNull();
    expect((await ownedCount(u.id))!.n).toBe(before);
  });

  it("rejects a duplicate slug and an invalid name", async () => {
    const u = await user();
    const s = slug();
    await createTenantForOwner(env.DB, u.id, { name: "One", slug: s }, 5);
    await expect(createTenantForOwner(env.DB, u.id, { name: "Two", slug: s }, 5)).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(createTenantForOwner(env.DB, u.id, { name: "", slug: slug() }, 5)).rejects.toMatchObject({ code: "invalid", status: 422 });
  });

  it("parallel creates with cap 1 yield exactly one workspace", async () => {
    const u = await user();
    const results = await Promise.all([
      createTenantForOwner(env.DB, u.id, { name: "R1", slug: slug() }, 1),
      createTenantForOwner(env.DB, u.id, { name: "R2", slug: slug() }, 1),
      createTenantForOwner(env.DB, u.id, { name: "R3", slug: slug() }, 1),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await ownedCount(u.id))!.n).toBe(1);
  });
});

describe("listTenants", () => {
  it("filters by status and search, and paginates", async () => {
    const a = await createTenant(env.DB, { name: "Alpha Co", slug: slug() });
    const b = await createTenant(env.DB, { name: "Beta Co", slug: slug() });
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(b.id).run();

    const all = await listTenants(env.DB, { page: 1, pageSize: 25, q: "", sort: "", status: "" });
    expect(all.total).toBeGreaterThanOrEqual(2);

    const suspended = await listTenants(env.DB, { page: 1, pageSize: 25, q: "", sort: "", status: "suspended" });
    expect(suspended.items.every((t) => t.status === "suspended")).toBe(true);
    expect(suspended.items.some((t) => t.id === b.id)).toBe(true);

    const byName = await listTenants(env.DB, { page: 1, pageSize: 25, q: "Alpha", sort: "" });
    expect(byName.items.some((t) => t.id === a.id)).toBe(true);
    expect(byName.items.some((t) => t.id === b.id)).toBe(false);

    const page = await listTenants(env.DB, { page: 1, pageSize: 1, q: "", sort: "" });
    expect(page.items).toHaveLength(1);

    const sorted = await listTenants(env.DB, { page: 1, pageSize: 25, q: "", sort: "-created", status: "" });
    expect(sorted.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("updateTenant", () => {
  it("404s for a missing tenant, validates the name, and otherwise updates", async () => {
    await expect(updateTenant(env.DB, "missing", { name: "X" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    const t = await createTenant(env.DB, { name: "Before", slug: slug() });
    await expect(updateTenant(env.DB, t.id, { name: "   " })).rejects.toMatchObject({ code: "invalid", status: 422 });
    await expect(updateTenant(env.DB, t.id, { name: "x".repeat(81) })).rejects.toMatchObject({ code: "invalid", status: 422 });
    const updated = await updateTenant(env.DB, t.id, { name: "After", plan: "pro" });
    expect(updated.name).toBe("After");
    expect(updated.plan).toBe("pro");
    expect(await statusOf(t.id)).toMatchObject({ status: "active" });
  });
});

describe("setTenantStatus", () => {
  it("returns 0 for an empty id list", async () => {
    expect(await setTenantStatus(env.DB, { ids: [] }, "suspended")).toBe(0);
  });

  it("never revives a deleting tenant, whether by id or by filter", async () => {
    const a = await createTenant(env.DB, { name: "Active", slug: slug() });
    const d = await createTenant(env.DB, { name: "Deleting", slug: slug() });
    await env.DB.prepare("UPDATE tenants SET status = 'deleting' WHERE id = ?").bind(d.id).run();

    const byIds = await setTenantStatus(env.DB, { ids: [a.id, d.id] }, "suspended");
    expect(byIds).toBe(1);
    expect((await statusOf(a.id))!.status).toBe("suspended");
    expect((await statusOf(d.id))!.status).toBe("deleting");

    const byFilter = await setTenantStatus(env.DB, { filter: { q: "", status: "" } }, "suspended");
    expect(byFilter).toBeGreaterThanOrEqual(1);
    expect((await statusOf(d.id))!.status).toBe("deleting");
  });
});

describe("setTenantStatus with many ids", () => {
  it.each([1, 99, 100])("suspends %i tenants by id", async (n) => {
    const made = await Promise.all(Array.from({ length: n }, (_, i) => createTenant(env.DB, { name: `Bulk ${i}`, slug: slug() })));
    expect(await setTenantStatus(env.DB, { ids: made.map((t) => t.id) }, "suspended")).toBe(n);
    expect((await statusOf(made[n - 1]!.id))!.status).toBe("suspended");
  });
});

describe("tenantCounts", () => {
  it("totals every status and reconciles", async () => {
    await createTenant(env.DB, { name: "Active", slug: slug() });
    const suspended = await createTenant(env.DB, { name: "Suspended", slug: slug() });
    const deleting = await createTenant(env.DB, { name: "Deleting", slug: slug() });
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(suspended.id).run();
    await env.DB.prepare("UPDATE tenants SET status = 'deleting' WHERE id = ?").bind(deleting.id).run();

    const c = await tenantCounts(env.DB);
    expect(c.total).toBe(c.active + c.suspended + c.pending_deletion + c.deleting);
    expect(c.active).toBeGreaterThanOrEqual(1);
    expect(c.suspended).toBeGreaterThanOrEqual(1);
    expect(c.deleting).toBeGreaterThanOrEqual(1);
  });
});

describe("tenantSignupSeries", () => {
  it("returns a zero-filled series ending today", async () => {
    await createTenant(env.DB, { name: "Today", slug: slug() });
    const series = await tenantSignupSeries(env.DB, 7);
    expect(series).toHaveLength(7);
    expect(series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.day))).toBe(true);
    expect(series.slice(0, 6).every((s) => s.count === 0)).toBe(true);
    expect(series[6]!.count).toBeGreaterThanOrEqual(1);
  });
});
