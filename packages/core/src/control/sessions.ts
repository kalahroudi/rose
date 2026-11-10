// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from "../crypto";
import { notFound } from "../errors";
import { newId, now, randomToken } from "../ids";
import type { OperatorRole, Role } from "./users";

export const SESSION_TTL = 7 * 86_400_000; // absolute lifetime
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
}

/**
 * Create a session for exactly one scope (a tenant id, or "platform").
 * Only the SHA-256 of the token is stored: a database leak does not yield usable sessions.
 */
export async function createSession(
  db: D1Database,
  input: { userId: string; scope: string; method: string; ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const t = now();
  const expiresAt = t + SESSION_TTL;
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, public_id, user_id, scope, method, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(token), newId("ses"), input.userId, input.scope, input.method, input.ip ?? null, (input.userAgent ?? "").slice(0, 200), t, t, expiresAt)
    .run();
  return { token, expiresAt };
}

/**
 * Resolve a session token **for a given scope**. The scope comes from the request host,
 * never from the client, so a token issued for tenant A is simply not found on tenant B.
 * Access also requires a live membership (or operator row) and an active tenant, so
 * removing a member or suspending a tenant takes effect on the very next request.
 */
export async function readSession(db: D1Database, token: string, scope: string): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const t = now();
  type Row = { public_id: string; user_id: string; email: string; name: string; scope: string; role: Role | OperatorRole | null; method: string; expires_at: number; last_seen_at: number };
  const row =
    scope === "platform"
      ? await db
          .prepare(
            `SELECT s.public_id, s.user_id, u.email, u.name, s.scope, o.role, s.method, s.expires_at, s.last_seen_at
             FROM sessions s JOIN users u ON u.id = s.user_id JOIN operators o ON o.user_id = s.user_id
             WHERE s.id_hash = ? AND s.scope = 'platform' AND s.expires_at > ?`,
          )
          .bind(hash, t)
          .first<Row>()
      : await db
          .prepare(
            `SELECT s.public_id, s.user_id, u.email, u.name, s.scope, m.role, s.method, s.expires_at, s.last_seen_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.scope
             JOIN tenants t ON t.id = s.scope AND t.status = 'active'
             WHERE s.id_hash = ? AND s.scope = ? AND s.expires_at > ?`,
          )
          .bind(hash, scope, t)
          .first<Row>();
  if (!row || !row.role) return null;
  if (t - row.last_seen_at > TOUCH_INTERVAL) {
    await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(t, hash).run();
  }
  return { publicId: row.public_id, userId: row.user_id, email: row.email, name: row.name, scope: row.scope, role: row.role, method: row.method, expiresAt: row.expires_at };
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
       WHERE user_id = ? AND scope = ? AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50`,
    )
    .bind(userId, scope, now())
    .all<SessionListItem>();
  return r.results;
}

export async function revokeSessionById(db: D1Database, userId: string, scope: string, publicId: string): Promise<void> {
  const r = await db.prepare("DELETE FROM sessions WHERE public_id = ? AND user_id = ? AND scope = ?").bind(publicId, userId, scope).run();
  if (r.meta.changes === 0) throw notFound();
}

// ── Handoffs: single-use, 60-second tokens that carry a verified identity across hosts ──

export async function createHandoff(db: D1Database, input: { purpose: "session" | "signup"; userId: string; scope: string; ttlMs?: number }): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO handoffs (token_hash, purpose, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), input.purpose, input.userId, input.scope, now() + (input.ttlMs ?? 60_000))
    .run();
  return token;
}

/** Atomically consume a handoff. Returns the user id only if purpose and scope match. */
export async function consumeHandoff(db: D1Database, token: string, purpose: "session" | "signup", scope: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db
    .prepare("DELETE FROM handoffs WHERE token_hash = ? AND purpose = ? AND scope = ? AND expires_at > ? RETURNING user_id")
    .bind(await sha256Hex(token), purpose, scope, now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Housekeeping for expired auth artefacts. Safe to run at any time. */
export async function sweepExpired(db: D1Database): Promise<void> {
  const t = now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(t - 3_600_000),
    db.prepare("DELETE FROM handoffs WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM invitations WHERE expires_at < ?").bind(t),
  ]);
}
