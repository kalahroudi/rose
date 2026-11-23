// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { likePattern, offsetOf, orderBy, type ListQuery, type Page } from "../http/pagination";
import { newId, now } from "../ids";

export type Role = "owner" | "admin" | "member";
export const ROLES: readonly Role[] = ["owner", "admin", "member"];
export const PLATFORM_SCOPE = "platform";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  last_login_at: number | null;
}

const emailSchema = z.string().trim().toLowerCase().max(254).email();

export function normalizeEmail(email: string): string {
  const r = emailSchema.safeParse(email);
  if (!r.success) throw invalid("Enter a valid email address.", { email: "Enter a valid email address." });
  return r.data;
}

export const getUserByEmail = (db: D1Database, email: string) =>
  db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();

export async function ensureUser(db: D1Database, email: string): Promise<UserRow> {
  const t = now();
  await db
    .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(newId("us"), email, t)
    .run();
  return (await getUserByEmail(db, email))!;
}

export const touchLogin = (db: D1Database, userId: string) =>
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), userId).run();

export const setUserName = (db: D1Database, userId: string, name: string) =>
  db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name.trim().slice(0, 80), userId).run();

export const getMembership = (db: D1Database, tenantId: string, userId: string) =>
  db.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?").bind(tenantId, userId).first<{ role: Role }>();

export const addMembership = (db: D1Database, tenantId: string, userId: string, role: Role) =>
  db
    .prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(tenantId, userId, role, now())
    .run();

export interface MemberItem {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  created_at: number;
  last_login_at: number | null;
}

export async function listMembers(db: D1Database, tenantId: string, f: ListQuery & { role?: string | undefined }): Promise<Page<MemberItem>> {
  const where = ["m.tenant_id = ?"];
  const args: unknown[] = [tenantId];
  if (f.q) {
    where.push("(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')");
    args.push(likePattern(f.q), likePattern(f.q));
  }
  if (f.role && (ROLES as readonly string[]).includes(f.role)) {
    where.push("m.role = ?");
    args.push(f.role);
  }
  const order = orderBy(f.sort, { email: "u.email", role: "m.role", joined: "m.created_at", seen: "u.last_login_at" }, "m.created_at ASC");
  const from = `FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${where.join(" AND ")}`;
  const [rows, count] = await db.batch([
    db
      .prepare(`SELECT m.user_id, u.email, u.name, m.role, m.created_at, u.last_login_at ${from} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args),
  ]);
  return { items: rows!.results as MemberItem[], total: (count!.results[0] as { n: number }).n, page: f.page, pageSize: f.pageSize };
}

export async function changeMemberRole(
  db: D1Database,
  tenantId: string,
  actorRole: Role,
  userId: string,
  role: Role,
  expectedRole?: Role,
): Promise<void> {
  const observedRole = expectedRole ?? (await getMembership(db, tenantId, userId))?.role;
  if (!observedRole) throw notFound();
  if ((observedRole === "owner" || role === "owner") && actorRole !== "owner") {
    throw forbidden("Only an owner can change owner access.");
  }
  const r =
    role !== "owner"
      ? await db
          .prepare(
            "UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ? AND role = ? AND (role != 'owner' OR (SELECT COUNT(*) FROM memberships WHERE tenant_id = ? AND role = 'owner') > 1)",
          )
          .bind(role, tenantId, userId, observedRole, tenantId)
          .run()
      : await db
          .prepare("UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ? AND role = ?")
          .bind(role, tenantId, userId, observedRole)
          .run();
  if (r.meta.changes === 0) {
    const after = await getMembership(db, tenantId, userId);
    if (!after) throw notFound();
    if (observedRole === "owner" && role !== "owner" && after.role === observedRole) {
      throw conflict("A workspace needs at least one owner. Make someone else an owner first.");
    }
    throw conflict("This member's role changed. Reload and try again.");
  }
}

export async function removeMember(
  db: D1Database,
  tenantId: string,
  actorRole: Role,
  userId: string,
  expectedRole?: Role,
): Promise<void> {
  const observedRole = expectedRole ?? (await getMembership(db, tenantId, userId))?.role;
  if (!observedRole) throw notFound();
  if (observedRole === "owner" && actorRole !== "owner") throw forbidden("Only an owner can remove an owner.");
  const [deleted] = await db.batch([
    db
      .prepare(
        "DELETE FROM memberships WHERE tenant_id = ? AND user_id = ? AND role = ? AND (role != 'owner' OR (SELECT COUNT(*) FROM memberships WHERE tenant_id = ? AND role = 'owner') > 1)",
      )
      .bind(tenantId, userId, observedRole, tenantId),
    db
      .prepare(
        "DELETE FROM sessions WHERE scope = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?)",
      )
      .bind(tenantId, userId, tenantId, userId),
    db
      .prepare(
        "DELETE FROM passkeys WHERE scope = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?)",
      )
      .bind(tenantId, userId, tenantId, userId),
  ]);
  if (!deleted || deleted.meta.changes === 0) {
    const after = await getMembership(db, tenantId, userId);
    if (!after) throw notFound();
    if (observedRole === "owner" && after.role === observedRole) {
      throw conflict("A workspace needs at least one owner. Make someone else an owner first.");
    }
    throw conflict("This member's role changed. Reload and try again.");
  }
}

export async function listWorkspacesForUser(db: D1Database, userId: string): Promise<{ id: string; slug: string; name: string; role: Role }[]> {
  const r = await db
    .prepare(
      `SELECT t.id, t.slug, t.name, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = ? AND t.status = 'active' ORDER BY t.name LIMIT 50`,
    )
    .bind(userId)
    .all<{ id: string; slug: string; name: string; role: Role }>();
  return r.results;
}

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  expires_at: number;
  created_at: number;
}

const INVITE_TTL = 7 * 86_400_000;

export async function createInvitation(
  db: D1Database,
  tenantId: string,
  input: { email: string; role: Role; invitedBy: string | null; actorRole: Role },
): Promise<InvitationRow> {
  const email = normalizeEmail(input.email);
  if (input.role === "owner" && input.actorRole !== "owner") throw forbidden("Only an owner can invite another owner.");
  const existing = await db
    .prepare("SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND u.email = ?")
    .bind(tenantId, email)
    .first();
  if (existing) throw conflict("That person is already a member.", { email: "Already a member." });
  const t = now();
  const row: InvitationRow = { id: newId("inv"), tenant_id: tenantId, email, role: input.role, invited_by: input.invitedBy, expires_at: t + INVITE_TTL, created_at: t };
  await db
    .prepare(
      `INSERT INTO invitations (id, tenant_id, email, role, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = excluded.role, expires_at = excluded.expires_at, invited_by = excluded.invited_by`,
    )
    .bind(row.id, tenantId, email, row.role, row.invited_by, row.expires_at, t)
    .run();
  return (await db.prepare("SELECT * FROM invitations WHERE tenant_id = ? AND email = ?").bind(tenantId, email).first<InvitationRow>())!;
}

export async function listInvitations(db: D1Database, tenantId: string, f: ListQuery): Promise<Page<InvitationRow>> {
  const where = ["tenant_id = ?"];
  const args: unknown[] = [tenantId];
  if (f.q) {
    where.push("email LIKE ? ESCAPE '\\'");
    args.push(likePattern(f.q));
  }
  const [rows, count] = await db.batch([
    db.prepare(`SELECT * FROM invitations WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n FROM invitations WHERE ${where.join(" AND ")}`).bind(...args),
  ]);
  return { items: rows!.results as InvitationRow[], total: (count!.results[0] as { n: number }).n, page: f.page, pageSize: f.pageSize };
}

export async function revokeInvitation(db: D1Database, tenantId: string, id: string): Promise<void> {
  const r = await db.prepare("DELETE FROM invitations WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
  if (r.meta.changes === 0) throw notFound();
}

export const getPendingInvitation = (db: D1Database, tenantId: string, email: string) =>
  db.prepare("SELECT * FROM invitations WHERE tenant_id = ? AND email = ? AND expires_at > ?").bind(tenantId, email, now()).first<InvitationRow>();

export async function redeemInvitation(db: D1Database, tenantId: string, user: UserRow): Promise<Role | null> {
  const inv = await getPendingInvitation(db, tenantId, user.email);
  if (!inv) return null;
  await db.batch([
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(tenantId, user.id, inv.role, now()),
    db.prepare("DELETE FROM invitations WHERE id = ?").bind(inv.id),
  ]);
  return inv.role;
}

export type OperatorRole = "owner" | "operator";
export interface OperatorItem {
  user_id: string;
  email: string;
  name: string;
  role: OperatorRole;
  created_at: number;
  last_login_at: number | null;
}

export const getOperator = (db: D1Database, userId: string) =>
  db.prepare("SELECT role FROM operators WHERE user_id = ?").bind(userId).first<{ role: OperatorRole }>();

export async function operatorCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM operators").first<{ n: number }>())?.n ?? 0;
}

export async function isOperatorEmail(db: D1Database, email: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM operators o JOIN users u ON u.id = o.user_id WHERE u.email = ?").bind(email).first());
}

export async function addOperator(db: D1Database, email: string, role: OperatorRole): Promise<void> {
  const user = await ensureUser(db, normalizeEmail(email));
  const r = await db.prepare("INSERT INTO operators (user_id, role, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(user.id, role, now()).run();
  if (r.meta.changes === 0) throw conflict("That person is already an operator.", { email: "Already an operator." });
}

export async function removeOperator(db: D1Database, userId: string): Promise<void> {
  const cur = await getOperator(db, userId);
  if (!cur) throw notFound();
  const [deleted] = await db.batch([
    db
      .prepare(
        "DELETE FROM operators WHERE user_id = ? AND role = ? AND (role != 'owner' OR (SELECT COUNT(*) FROM operators WHERE role = 'owner') > 1)",
      )
      .bind(userId, cur.role),
    db
      .prepare(
        "DELETE FROM sessions WHERE scope = 'platform' AND user_id = ? AND NOT EXISTS (SELECT 1 FROM operators WHERE user_id = ?)",
      )
      .bind(userId, userId),
    db
      .prepare(
        "DELETE FROM passkeys WHERE scope = 'platform' AND user_id = ? AND NOT EXISTS (SELECT 1 FROM operators WHERE user_id = ?)",
      )
      .bind(userId, userId),
  ]);
  if (!deleted || deleted.meta.changes === 0) {
    const after = await getOperator(db, userId);
    if (!after) throw notFound();
    if (cur.role === "owner" && after.role === cur.role) {
      throw conflict("The platform needs at least one owner.");
    }
    throw conflict("This operator's role changed. Reload and try again.");
  }
}

export async function ownerOperatorEmails(db: D1Database, exceptUserId: string): Promise<string[]> {
  const r = await db.prepare("SELECT u.email AS email FROM operators o JOIN users u ON u.id = o.user_id WHERE o.role = 'owner' AND o.user_id != ? LIMIT 100").bind(exceptUserId).all<{ email: string }>();
  return r.results.map((o) => o.email);
}

export async function listOperators(db: D1Database, f: ListQuery): Promise<Page<OperatorItem>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q) {
    where.push("u.email LIKE ? ESCAPE '\\'");
    args.push(likePattern(f.q));
  }
  const from = `FROM operators o JOIN users u ON u.id = o.user_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const [rows, count] = await db.batch([
    db.prepare(`SELECT o.user_id, u.email, u.name, o.role, o.created_at, u.last_login_at ${from} ORDER BY o.created_at LIMIT ? OFFSET ?`).bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args),
  ]);
  return { items: rows!.results as OperatorItem[], total: (count!.results[0] as { n: number }).n, page: f.page, pageSize: f.pageSize };
}

export async function userCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;
}
