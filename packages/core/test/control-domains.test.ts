// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addDomain, domainCounts, getDomain, listDomains, removeDomain, setDomainState, validateHostname, type DomainRow } from "../src/control/domains";
import { createTenant } from "../src/control/tenants";
import { AppError } from "../src/errors";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tenants").run();
});

const base = "rose.test";
const throwOf = (fn: () => unknown): AppError => {
  try { fn(); } catch (e) { return e as AppError; }
  throw new Error("expected an error to be thrown");
};
const tenant = () => createTenant(env.DB, { name: `T ${Math.random().toString(36).slice(2, 8)}`, slug: `t${Math.random().toString(36).slice(2, 12)}` });
const domain = async (hostname: string) => {
  const t = await tenant();
  await addDomain(env.DB, t.id, hostname);
  return t;
};
const row = (hostname: string) => env.DB.prepare("SELECT * FROM tenant_domains WHERE hostname = ?").bind(hostname).first<DomainRow>();

describe("validateHostname", () => {
  it("accepts a full domain, trimming, lower-casing and dropping a trailing dot", () => {
    expect(validateHostname("  App.Customer.com. ", base)).toBe("app.customer.com");
    expect(validateHostname("api.example.org", base)).toBe("api.example.org");
  });

  it.each(["app", "foo_bar.com", "-app.com", "app-.com", "app..com", "app.c", `x.${"a".repeat(64)}.com`, ""])(
    "rejects a malformed hostname %j",
    (host) => {
      expect(throwOf(() => validateHostname(host, base)).code).toBe("invalid");
    },
  );

  it("never lets a custom domain shadow the platform namespace", () => {
    for (const host of [base, `sub.${base}`, `deep.sub.${base}`]) {
      expect(throwOf(() => validateHostname(host, base)).code).toBe("invalid");
    }
    expect(validateHostname(`not${base}`, base)).toBe(`not${base}`);
  });
});

describe("addDomain", () => {
  it("registers a pending domain and returns its row", async () => {
    const t = await tenant();
    const d = await addDomain(env.DB, t.id, "shop.example.com");
    expect(d.hostname).toBe("shop.example.com");
    expect(d.tenant_id).toBe(t.id);
    expect(d.status).toBe("pending");
    expect((await row("shop.example.com"))!.status).toBe("pending");
  });

  it("rejects a hostname already connected anywhere (global uniqueness)", async () => {
    const a = await tenant();
    const b = await tenant();
    await addDomain(env.DB, a.id, "dup.example.com");
    await expect(addDomain(env.DB, b.id, "dup.example.com")).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(addDomain(env.DB, a.id, "dup.example.com")).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("rethrows a foreign-tenant failure as a generic error, not a domain conflict", async () => {
    let err: unknown;
    try { await addDomain(env.DB, "missing-tenant", "fk.example.com"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as AppError).code).not.toBe("conflict");
  });
});

describe("getDomain and setDomainState", () => {
  it("getDomain returns the row or null", async () => {
    const t = await tenant();
    await addDomain(env.DB, t.id, "g.example.com");
    expect((await getDomain(env.DB, "g.example.com"))!.tenant_id).toBe(t.id);
    expect(await getDomain(env.DB, "missing.example.com")).toBeNull();
  });

  it("setDomainState updates status and detail, keeping an existing provider id when none is given", async () => {
    const t = await tenant();
    await addDomain(env.DB, t.id, "s.example.com");
    await setDomainState(env.DB, "s.example.com", { status: "active", providerId: "prov_1", detail: "ok" });
    await setDomainState(env.DB, "s.example.com", { status: "failed" });
    const r = (await row("s.example.com"))!;
    expect(r.status).toBe("failed");
    expect(r.provider_id).toBe("prov_1");
    expect(r.detail).toBeNull();
  });
});

describe("removeDomain", () => {
  it("deletes and returns the removed row, or 404s for a missing hostname", async () => {
    const t = await tenant();
    await addDomain(env.DB, t.id, "r.example.com");
    expect((await removeDomain(env.DB, "r.example.com")).tenant_id).toBe(t.id);
    expect(await getDomain(env.DB, "r.example.com")).toBeNull();
    await expect(removeDomain(env.DB, "r.example.com")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("listDomains", () => {
  it("joins tenant slug and name, filters by status and tenant, and paginates", async () => {
    const a = await domain("l-a.example.com");
    await domain("l-b.example.com");
    await domain("l-c.example.com");
    await setDomainState(env.DB, "l-a.example.com", { status: "active" });
    await setDomainState(env.DB, "l-c.example.com", { status: "failed" });

    const all = await listDomains(env.DB, { page: 1, pageSize: 25, q: "", sort: "" });
    expect(all.total).toBe(3);
    expect(all.items.map((d) => d.hostname).sort()).toEqual(["l-a.example.com", "l-b.example.com", "l-c.example.com"]);
    expect(all.items.every((d) => typeof d.tenant_slug === "string" && typeof d.tenant_name === "string")).toBe(true);

    const active = await listDomains(env.DB, { page: 1, pageSize: 25, q: "", sort: "", status: "active" });
    expect(active.total).toBe(1);
    expect(active.items[0]!.hostname).toBe("l-a.example.com");

    const one = await listDomains(env.DB, { page: 1, pageSize: 25, q: "", sort: "", tenantId: a.id });
    expect(one.total).toBe(1);
    expect(one.items[0]!.hostname).toBe("l-a.example.com");

    const page = await listDomains(env.DB, { page: 2, pageSize: 1, q: "", sort: "" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);

    const byName = await listDomains(env.DB, { page: 1, pageSize: 25, q: a.name.slice(0, 6), sort: "" });
    expect(byName.items.some((d) => d.hostname === "l-a.example.com")).toBe(true);
  });

  it("ignores an unknown status filter rather than leaking rows", async () => {
    await domain("u.example.com");
    const r = await listDomains(env.DB, { page: 1, pageSize: 25, q: "", sort: "", status: "bogus" });
    expect(r.total).toBe(1);
  });
});

describe("domainCounts", () => {
  it("counts pending, active and failed domains", async () => {
    await domain("c-a.example.com");
    await domain("c-b.example.com");
    await domain("c-c.example.com");
    await setDomainState(env.DB, "c-a.example.com", { status: "active" });
    await setDomainState(env.DB, "c-c.example.com", { status: "failed" });
    expect(await domainCounts(env.DB)).toEqual({ pending: 1, active: 1, failed: 1 });
  });
});
