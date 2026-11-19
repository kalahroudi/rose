// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHandoff } from "../src/control/sessions";
import { countOwnedWorkspaces, createTenant } from "../src/control/tenants";
import { addMembership, ensureUser } from "../src/control/users";
import { DEFAULT_MAX_WORKSPACES_PER_USER, maxWorkspacesPerUser } from "../src/env";
import { createTestTenant } from "../src/testing";

const root = `https://${env.APP_BASE_DOMAIN}`;
const post = (path: string, body: unknown) =>
  SELF.fetch(root + path, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
const rnd = () => Math.random().toString(36).slice(2, 10);
const freshEmail = (p: string) => `${p}-${rnd()}@example.com`;

const verify = async (email: string) => {
  const { devCode } = await (await post("/api/root/code/request", { email })).json<{ devCode: string }>();
  return (await (await post("/api/root/code/verify", { email, code: devCode })).json<{ ticket: string }>()).ticket;
};
const own = async (email: string, n: number, opts: { status?: string; role?: "owner" | "admin" | "member" } = {}) => {
  const user = await ensureUser(env.DB, email);
  const slugs: string[] = [];
  for (let i = 0; i < n; i++) {
    const slug = `adv-${rnd()}`;
    const t = await createTenant(env.DB, { name: slug, slug });
    await addMembership(env.DB, t.id, user.id, opts.role ?? "owner");
    if (opts.status) await env.DB.prepare("UPDATE tenants SET status = ? WHERE id = ?").bind(opts.status, t.id).run();
    slugs.push(slug);
  }
  return { user, slugs };
};
const counts = async () => {
  const one = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
  return {
    tenants: await one("SELECT COUNT(*) AS n FROM tenants"),
    memberships: await one("SELECT COUNT(*) AS n FROM memberships"),
    audit: await one("SELECT COUNT(*) AS n FROM platform_audit"),
    handoffs: await one("SELECT COUNT(*) AS n FROM handoffs"),
  };
};
const create = (ticket: string, slug = `new-${rnd()}`) => post("/api/root/enter", { ticket, create: { name: "New Ws", slug } });

describe("MAX_WORKSPACES_PER_USER parsing (adversarial)", () => {
  const p = (v: unknown) => maxWorkspacesPerUser({ MAX_WORKSPACES_PER_USER: v as string });

  it("default is 5", () => {
    expect(DEFAULT_MAX_WORKSPACES_PER_USER).toBe(5);
    expect(p(undefined)).toBe(5);
  });

  it.each([
    ["1", 1],
    ["1000000", 1_000_000],
    ["007", 7],
    [" 3 ", 3],
  ])("accepts positive integer %j -> %d", (v, n) => {
    expect(p(v)).toBe(n);
  });

  it.each(["", "   ", "0", "00", "-1", "-0", "abc", "2.5", "3.0", "1e3", "0x10", "+3", "3abc", "Infinity", "NaN", "１", "3 4", "null"])(
    "falls back to 5 for %j",
    (v) => {
      expect(p(v)).toBe(5);
    },
  );

  it("never returns a non-finite or non-integer cap, even for absurdly long digit strings", () => {
    const n = p("9".repeat(400));
    expect(Number.isFinite(n) || n === 5).toBe(true);
    expect(n >= 1).toBe(true);
  });

  it("does not crash on non-string config values", () => {
    for (const v of [null, 3, true, {}, []]) expect(() => p(v)).not.toThrow();
  });
});

describe("workspace cap on POST /api/root/enter (adversarial)", () => {
  it("end to end: creates through the API up to the cap, then refuses the next one", async () => {
    const email = freshEmail("e2e");
    await own(email, 3);
    expect((await create(await verify(email))).status).toBe(200);
    expect((await create(await verify(email))).status).toBe(200);
    const res = await create(await verify(email));
    expect(res.status).toBe(403);
    const { user } = await own(email, 0);
    expect(await countOwnedWorkspaces(env.DB, user.id)).toBe(5);
  });

  it("rejection writes no tenant, membership, audit row and does not consume the ticket", async () => {
    const email = freshEmail("norow");
    const { user, slugs } = await own(email, 5);
    const ticket = await verify(email);
    const before = await counts();
    const slug = `blocked-${rnd()}`;
    const res = await create(ticket, slug);
    expect(res.status).toBe(403);
    const body = await res.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).toMatch(/limit/i);
    expect(await counts()).toEqual(before);
    expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?").bind(slug).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM platform_audit WHERE actor = ? AND action = 'tenant.signup'").bind(user.id).first()).toBeNull();
    // Repeated rejections also keep the ticket alive.
    expect((await create(ticket)).status).toBe(403);
    expect((await create(ticket)).status).toBe(403);
    expect((await post("/api/root/enter", { ticket, slug: slugs[2] })).status).toBe(200);
    // ...and it is spent exactly once.
    expect((await post("/api/root/enter", { ticket, slug: slugs[2] })).status).toBe(401);
  });

  it("an invalid, expired or wrong-purpose ticket at the cap is 401, never 403 (no information about the cap)", async () => {
    const email = freshEmail("badticket");
    const { user } = await own(email, 5);
    expect((await create("not-a-real-ticket")).status).toBe(401);
    expect((await create("")).status).not.toBe(200);
    const expired = await createHandoff(env.DB, { purpose: "signup", userId: user.id, scope: "root", ttlMs: 60_000 });
    await env.DB.prepare("UPDATE handoffs SET expires_at = 1 WHERE user_id = ? AND purpose = 'signup'").bind(user.id).run();
    expect((await create(expired)).status).toBe(401);
    const session = await createHandoff(env.DB, { purpose: "session", userId: user.id, scope: "root", ttlMs: 60_000 });
    expect((await create(session)).status).toBe(401);
  });

  it("a ticket issued for another scope cannot be used to probe or bypass the cap", async () => {
    const a = await createTestTenant(env, SELF);
    await own(a.email, 5);
    const foreign = await createHandoff(env.DB, { purpose: "signup", userId: a.userId, scope: a.id, ttlMs: 60_000 });
    expect((await create(foreign)).status).toBe(401);
  });

  it("admin and member roles are not counted, owner at deleting tenants is not counted", async () => {
    const email = freshEmail("roles");
    await own(email, 4);
    await own(email, 3, { role: "admin" });
    await own(email, 3, { role: "member" });
    await own(email, 3, { status: "deleting" });
    expect((await create(await verify(email))).status).toBe(200);
    expect((await create(await verify(email))).status).toBe(403);
  });

  it("pending_deletion and suspended owned tenants count toward the cap", async () => {
    const email = freshEmail("pd");
    await own(email, 2, { status: "pending_deletion" });
    await own(email, 3, { status: "suspended" });
    expect((await create(await verify(email))).status).toBe(403);
  });

  it("another user's ownership does not count against me", async () => {
    await own(freshEmail("other"), 6);
    expect((await create(await verify(freshEmail("me")))).status).toBe(200);
  });

  it("email casing does not create a second identity with a fresh cap", async () => {
    const email = freshEmail("case");
    await own(email, 5);
    expect((await create(await verify(email.toUpperCase()))).status).toBe(403);
  });

  it("entering an existing workspace via slug is unaffected at and above the cap", async () => {
    const email = freshEmail("slug");
    const { slugs } = await own(email, 8);
    for (const s of [slugs[0], slugs[7]]) {
      const res = await post("/api/root/enter", { ticket: await verify(email), slug: s });
      expect(res.status).toBe(200);
      expect((await res.json<{ url: string }>()).url).toContain("/auth/handoff?token=");
    }
  });

  it("taken slug at the cap: refused, nothing written, ticket survives", async () => {
    const email = freshEmail("taken");
    const { slugs } = await own(email, 5);
    const ticket = await verify(email);
    const before = await counts();
    const res = await create(ticket, slugs[0]);
    expect([403, 409]).toContain(res.status);
    expect(await counts()).toEqual(before);
    expect((await post("/api/root/enter", { ticket, slug: slugs[0] })).status).toBe(200);
  });

  it("taken slug below the cap is still 409 (cap check does not mask it)", async () => {
    const email = freshEmail("taken2");
    const { slugs } = await own(email, 1);
    expect((await create(await verify(email), slugs[0])).status).toBe(409);
  });

  it("concurrent creates with separate tickets cannot exceed the cap", async () => {
    const email = freshEmail("race");
    const { user } = await own(email, 4);
    const tickets: string[] = [];
    for (let i = 0; i < 4; i++) tickets.push(await verify(email));
    const results = await Promise.all(tickets.map((t) => create(t)));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeLessThanOrEqual(1);
    expect(await countOwnedWorkspaces(env.DB, user.id)).toBeLessThanOrEqual(5);
  });
});
