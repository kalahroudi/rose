// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from "../crypto";
import { conflict, notFound, reauthRequired } from "../errors";
import { newId, now, randomToken } from "../ids";
import { RATE_LIMIT_WINDOW_MS } from "./rate-limit";
import { ACTIVE_TENANT_GUARD, refuseInactiveTenant, tenantStatus } from "./tenant-guard";
import type { OperatorRole, Role } from "./users";

export const SESSION_TTL = 7 * 86_400_000;
export const SESSION_IDLE_TIMEOUT = 12 * 3_600_000;
const TOUCH_INTERVAL = 5 * 60_000;

export interface SessionInfo {
  publicId: string;
  userId: string;
  email: string;
  name: string;
  scope: string;
  role: Role | OperatorRole;
  method: string;
  expiresAt: number;
  createdAt: number;
}

export async function createSession(
  db: D1Database,
  input: { userId: string; scope: string; method: string; ip?: string | null; userAgent?: string | null | undefined },
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const t = now();
  const expiresAt = t + SESSION_TTL;
  const res = await db
    .prepare(
      `INSERT INTO sessions (id_hash, public_id, user_id, scope, method, ip, user_agent, created_at, last_seen_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${ACTIVE_TENANT_GUARD}`,
    )
    .bind(await sha256Hex(token), newId("ses"), input.userId, input.scope, input.method, input.ip ?? null, (input.userAgent ?? "").slice(0, 200), t, t, expiresAt, input.scope, input.scope)
    .run();
  if (res.meta.changes === 0) {
    const status = await tenantStatus(db, input.scope);
    if (status === "active") throw conflict("Workspace status changed. Try again.");
    throw refuseInactiveTenant(status);
  }
  return { token, expiresAt };
}

export async function readSession(db: D1Database, token: string, scope: string): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const t = now();
  type Row = { public_id: string; user_id: string; email: string; name: string; scope: string; role: Role | OperatorRole | null; method: string; expires_at: number; last_seen_at: number; created_at: number };
  const row =
    scope === "platform"
      ? await db
          .prepare(
            `SELECT s.public_id, s.user_id, u.email, u.name, s.scope, o.role, s.method, s.expires_at, s.last_seen_at, s.created_at
             FROM sessions s JOIN users u ON u.id = s.user_id JOIN operators o ON o.user_id = s.user_id
             WHERE s.id_hash = ? AND s.scope = 'platform' AND s.expires_at > ? AND s.last_seen_at > ?`,
          )
          .bind(hash, t, t - SESSION_IDLE_TIMEOUT)
          .first<Row>()
      : await db
          .prepare(
            `SELECT s.public_id, s.user_id, u.email, u.name, s.scope, m.role, s.method, s.expires_at, s.last_seen_at, s.created_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.scope
             JOIN tenants t ON t.id = s.scope AND t.status = 'active'
             WHERE s.id_hash = ? AND s.scope = ? AND s.expires_at > ? AND s.last_seen_at > ?`,
          )
          .bind(hash, scope, t, t - SESSION_IDLE_TIMEOUT)
          .first<Row>();
  if (!row || !row.role) return null;
  if (t - row.last_seen_at > TOUCH_INTERVAL) {
    await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(t, hash).run();
  }
  return { publicId: row.public_id, userId: row.user_id, email: row.email, name: row.name, scope: row.scope, role: row.role, method: row.method, expiresAt: row.expires_at, createdAt: row.created_at };
}

export async function revokeSessionToken(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
}

export interface SessionListItem {
  id: string;
  method: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
}

export async function listSessions(db: D1Database, userId: string, scope: string): Promise<SessionListItem[]> {
  const r = await db
    .prepare(
      `SELECT public_id AS id, method, ip, user_agent, created_at, last_seen_at FROM sessions
       WHERE user_id = ? AND scope = ? AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 50`,
    )
    .bind(userId, scope, now(), now() - SESSION_IDLE_TIMEOUT)
    .all<SessionListItem>();
  return r.results;
}

export async function revokeSessionById(db: D1Database, userId: string, scope: string, publicId: string): Promise<void> {
  const r = await db.prepare("DELETE FROM sessions WHERE public_id = ? AND user_id = ? AND scope = ?").bind(publicId, userId, scope).run();
  if (r.meta.changes === 0) throw notFound();
}

export async function createHandoff(db: D1Database, input: { purpose: "session" | "signup"; userId: string; scope: string; ttlMs?: number }): Promise<string> {
  const token = randomToken();
  const res = await db
    .prepare(
      `INSERT INTO handoffs (token_hash, purpose, user_id, scope, expires_at)
       SELECT ?, ?, ?, ?, ?
       WHERE ${ACTIVE_TENANT_GUARD}`,
    )
    .bind(await sha256Hex(token), input.purpose, input.userId, input.scope, now() + (input.ttlMs ?? 60_000), input.scope, input.scope)
    .run();
  if (res.meta.changes === 0) {
    const status = await tenantStatus(db, input.scope);
    if (status === "active") throw conflict("Workspace status changed. Try again.");
    throw refuseInactiveTenant(status);
  }
  return token;
}

export async function consumeHandoff(db: D1Database, token: string, purpose: "session" | "signup", scope: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db
    .prepare("DELETE FROM handoffs WHERE token_hash = ? AND purpose = ? AND scope = ? AND expires_at > ? RETURNING user_id")
    .bind(await sha256Hex(token), purpose, scope, now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function peekHandoff(db: D1Database, token: string, purpose: "session" | "signup", scope: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db
    .prepare("SELECT user_id FROM handoffs WHERE token_hash = ? AND purpose = ? AND scope = ? AND expires_at > ?")
    .bind(await sha256Hex(token), purpose, scope, now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function sweepExpired(db: D1Database): Promise<void> {
  const t = now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at <= ?").bind(t, t - SESSION_IDLE_TIMEOUT),
    db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(t - 3_600_000),
    db.prepare("DELETE FROM handoffs WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM invitations WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM rate_limits WHERE window_start <= ?").bind(t - RATE_LIMIT_WINDOW_MS),
  ]);
}

export const FRESH_SIGN_IN_MS = 10 * 60_000;

export function assertFreshSession(s: Pick<SessionInfo, "method" | "createdAt">, opts: { passkey: boolean }): void {
  const age = now() - s.createdAt;
  if (age < 0 || age >= FRESH_SIGN_IN_MS || (opts.passkey && s.method !== "passkey")) {
    throw reauthRequired(opts.passkey ? "Sign in again with your passkey to confirm this action." : "Sign in again to confirm this action.");
  }
}
