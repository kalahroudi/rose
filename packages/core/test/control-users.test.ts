// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/control/sessions";
import { createTenant } from "../src/control/tenants";
import {
  addMembership,
  addOperator,
  changeMemberRole,
  createInvitation,
  ensureUser,
  getMembership,
  getOperator,
  getUserByEmail,
  isOperatorEmail,
  listMembers,
  listOperators,
  normalizeEmail,
  operatorCount,
  removeMember,
  removeOperator,
  revokeInvitation,
  setUserName,
  userCount,
} from "../src/control/users";
import { AppError } from "../src/errors";

const rnd = () => Math.random().toString(36).slice(2, 10);
const email = () => `${rnd()}@example.com`;
const throwOf = (fn: () => unknown): AppError => {
  try { fn(); } catch (e) { return e as AppError; }
  throw new Error("expected an error to be thrown");
};
const tenant = async () => createTenant(env.DB, { name: `T ${rnd()}`, slug: `tn-${rnd()}` });
const member = async (t: { id: string }, role: "owner" | "admin" | "member") => {
  const u = await ensureUser(env.DB, email());
  await addMembership(env.DB, t.id, u.id, role);
  return u;
};
const passkey = (userId: string, scope: string) =>
  env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, name, created_at) VALUES (?, ?, ?, 'rose.test', 'key', 'pk', 0)").bind(`cred-${rnd()}`, userId, scope).run();

describe("normalizeEmail and setUserName", () => {
  it("rejects malformed addresses and normalises valid ones", () => {
    expect(throwOf(() => normalizeEmail("nope")).code).toBe("invalid");
    expect(throwOf(() => normalizeEmail("")).code).toBe("invalid");
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("setUserName trims and caps at 80 characters", async () => {
    const u = await ensureUser(env.DB, email());
    await setUserName(env.DB, u.id, `  ${"a".repeat(90)}  `);
    const row = await getUserByEmail(env.DB, u.email);
    expect(row!.name).toBe("a".repeat(80));
  });
});

describe("memberships", () => {
  it("lists only the requested tenant's members and filters by role", async () => {
    const a = await tenant();
    const b = await tenant();
    const ownerA = await member(a, "owner");
    const adminA = await member(a, "admin");
    await member(a, "member");
    await member(b, "member");

    const all = await listMembers(env.DB, a.id, { page: 1, pageSize: 25, q: "", sort: "" });
    expect(all.total).toBe(3);
    expect(all.items.some((m) => m.user_id === ownerA.id && m.role === "owner")).toBe(true);

    const admins = await listMembers(env.DB, a.id, { page: 1, pageSize: 25, q: "", sort: "", role: "admin" });
    expect(admins.total).toBe(1);
    expect(admins.items[0]!.user_id).toBe(adminA.id);
  });

  it("changeMemberRole updates a member's role", async () => {
    const t = await tenant();
    const m = await member(t, "member");
    await changeMemberRole(env.DB, t.id, "owner", m.id, "admin");
    expect((await getMembership(env.DB, t.id, m.id))!.role).toBe("admin");
  });

  it("removeMember clears membership, sessions and passkeys", async () => {
    const t = await tenant();
    const m = await member(t, "member");
    await createSession(env.DB, { userId: m.id, scope: t.id, method: "test" });
    await passkey(m.id, t.id);
    await removeMember(env.DB, t.id, "owner", m.id);
    expect(await getMembership(env.DB, t.id, m.id)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = ?").bind(m.id, t.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = ?").bind(m.id, t.id).first()).toBeNull();
  });

  it("protects the last owner and refuses a non-owner removing an owner", async () => {
    const t = await tenant();
    const o = await member(t, "owner");
    await createSession(env.DB, { userId: o.id, scope: t.id, method: "test" });
    await passkey(o.id, t.id);
    await expect(removeMember(env.DB, t.id, "owner", o.id)).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = ?").bind(o.id, t.id).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = ?").bind(o.id, t.id).first()).not.toBeNull();
    await expect(changeMemberRole(env.DB, t.id, "owner", o.id, "admin")).rejects.toMatchObject({ code: "conflict", status: 409 });
    await changeMemberRole(env.DB, t.id, "owner", o.id, "owner");
    expect((await getMembership(env.DB, t.id, o.id))!.role).toBe("owner");
    await expect(removeMember(env.DB, t.id, "admin", o.id)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(changeMemberRole(env.DB, t.id, "admin", o.id, "member")).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("concurrent cross-removal of two owners keeps one owner and preserves their session and passkey", async () => {
    for (let i = 0; i < 20; i++) {
      const t = await tenant();
      const a = await member(t, "owner");
      const b = await member(t, "owner");
      await createSession(env.DB, { userId: a.id, scope: t.id, method: "test" });
      await createSession(env.DB, { userId: b.id, scope: t.id, method: "test" });
      await passkey(a.id, t.id);
      await passkey(b.id, t.id);
      const results = await Promise.allSettled([
        removeMember(env.DB, t.id, "owner", a.id),
        removeMember(env.DB, t.id, "owner", b.id),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const fail = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(fail).toHaveLength(1);
      expect(fail[0]!.reason).toMatchObject({
        code: "conflict",
        status: 409,
        message: "A workspace needs at least one owner. Make someone else an owner first.",
      });
      const owners = await env.DB
        .prepare("SELECT user_id FROM memberships WHERE tenant_id = ? AND role = 'owner'")
        .bind(t.id)
        .all<{ user_id: string }>();
      expect(owners.results).toHaveLength(1);
      const survivor = owners.results[0]!.user_id;
      const removed = survivor === a.id ? b.id : a.id;
      expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = ?").bind(survivor, t.id).first()).not.toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = ?").bind(survivor, t.id).first()).not.toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = ?").bind(removed, t.id).first()).toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = ?").bind(removed, t.id).first()).toBeNull();
    }
  });

  it("concurrent cross-demotion of two owners keeps one owner", async () => {
    for (let i = 0; i < 20; i++) {
      const t = await tenant();
      const a = await member(t, "owner");
      const b = await member(t, "owner");
      const results = await Promise.allSettled([
        changeMemberRole(env.DB, t.id, "owner", a.id, "admin"),
        changeMemberRole(env.DB, t.id, "owner", b.id, "member"),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const fail = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(fail).toHaveLength(1);
      expect(fail[0]!.reason).toMatchObject({
        code: "conflict",
        status: 409,
        message: "A workspace needs at least one owner. Make someone else an owner first.",
      });
      const owners = await env.DB
        .prepare("SELECT user_id FROM memberships WHERE tenant_id = ? AND role = 'owner'")
        .bind(t.id)
        .all<{ user_id: string }>();
      expect(owners.results).toHaveLength(1);
    }
  });

  it("membership actions are scoped to the tenant: another tenant's member is not found", async () => {
    const a = await tenant();
    const b = await tenant();
    const bMember = await member(b, "member");
    await expect(removeMember(env.DB, a.id, "owner", bMember.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(changeMemberRole(env.DB, a.id, "owner", bMember.id, "admin")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("invitations", () => {
  it("revokeInvitation deletes the invitation and 404s for missing or foreign ones", async () => {
    const a = await tenant();
    const b = await tenant();
    const inv = await createInvitation(env.DB, a.id, { email: email(), role: "member", invitedBy: null, actorRole: "owner" });
    await revokeInvitation(env.DB, a.id, inv.id);
    await expect(revokeInvitation(env.DB, a.id, inv.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(revokeInvitation(env.DB, b.id, inv.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("only an owner may invite another owner", async () => {
    const a = await tenant();
    await expect(createInvitation(env.DB, a.id, { email: email(), role: "owner", invitedBy: null, actorRole: "admin" })).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("operators", () => {
  it("addOperator creates the user and operator, then refuses a duplicate", async () => {
    const e = email();
    await addOperator(env.DB, e, "operator");
    const u = (await getUserByEmail(env.DB, e))!;
    expect((await getOperator(env.DB, u.id))!.role).toBe("operator");
    expect(await isOperatorEmail(env.DB, e)).toBe(true);
    expect(await operatorCount(env.DB)).toBeGreaterThanOrEqual(1);
    await expect(addOperator(env.DB, e, "operator")).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("removeOperator clears the operator, platform session and platform passkey", async () => {
    const e = email();
    await addOperator(env.DB, e, "operator");
    const u = (await getUserByEmail(env.DB, e))!;
    await createSession(env.DB, { userId: u.id, scope: "platform", method: "test" });
    await passkey(u.id, "platform");
    await removeOperator(env.DB, u.id);
    expect(await getOperator(env.DB, u.id)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = 'platform'").bind(u.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = 'platform'").bind(u.id).first()).toBeNull();
  });

  it("protects the last platform owner and 404s for a non-operator", async () => {
    await expect(removeOperator(env.DB, "missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
    const e = email();
    await addOperator(env.DB, e, "owner");
    const u = (await getUserByEmail(env.DB, e))!;
    await createSession(env.DB, { userId: u.id, scope: "platform", method: "test" });
    await passkey(u.id, "platform");
    await expect(removeOperator(env.DB, u.id)).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = 'platform'").bind(u.id).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = 'platform'").bind(u.id).first()).not.toBeNull();
  });

  it("concurrent cross-removal of two platform owners keeps one owner and preserves their session and passkey", async () => {
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare("DELETE FROM operators").run();
      const ea = email();
      const eb = email();
      await addOperator(env.DB, ea, "owner");
      await addOperator(env.DB, eb, "owner");
      const a = (await getUserByEmail(env.DB, ea))!;
      const b = (await getUserByEmail(env.DB, eb))!;
      await createSession(env.DB, { userId: a.id, scope: "platform", method: "test" });
      await createSession(env.DB, { userId: b.id, scope: "platform", method: "test" });
      await passkey(a.id, "platform");
      await passkey(b.id, "platform");
      const results = await Promise.allSettled([
        removeOperator(env.DB, a.id),
        removeOperator(env.DB, b.id),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const fail = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(fail).toHaveLength(1);
      expect(fail[0]!.reason).toMatchObject({
        code: "conflict",
        status: 409,
        message: "The platform needs at least one owner.",
      });
      const owners = await env.DB
        .prepare("SELECT user_id FROM operators WHERE role = 'owner'")
        .all<{ user_id: string }>();
      expect(owners.results).toHaveLength(1);
      const survivor = owners.results[0]!.user_id;
      const removed = survivor === a.id ? b.id : a.id;
      expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = 'platform'").bind(survivor).first()).not.toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = 'platform'").bind(survivor).first()).not.toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = 'platform'").bind(removed).first()).toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = 'platform'").bind(removed).first()).toBeNull();
    }
  });

  it("listOperators filters by email and counts users", async () => {
    const e = `op-${rnd()}@example.com`;
    await addOperator(env.DB, e, "operator");
    const r = await listOperators(env.DB, { page: 1, pageSize: 25, q: "op-", sort: "" });
    expect(r.items.some((o) => o.email === e)).toBe(true);
    expect(await userCount(env.DB)).toBeGreaterThanOrEqual(1);
  });
});
