// SPDX-License-Identifier: Apache-2.0
// Built-in per-tenant records: audit log and API keys. They live inside the tenant's
// own database, so they share its isolation and are destroyed with it.
import { sha256Hex, timingSafeEqual } from "../crypto";
import type { Role } from "../control/users";
import { notFound } from "../errors";
import { likePattern, likePrefix, offsetOf, type ListQuery, type Page } from "../http/pagination";
import { newId, now, randomToken } from "../ids";
import type { TenantDb } from "./context";

export interface TenantAuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
}

export async function writeTenantAudit(db: TenantDb, e: { actor: string; action: string; target?: string | null; meta?: unknown; ip?: string | null }): Promise<void> {
  await db.run("INSERT INTO audit_log (id, at, actor, action, target, meta, ip) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    newId("au"), now(), e.actor, e.action, e.target ?? null, e.meta === undefined ? null : JSON.stringify(e.meta), e.ip ?? null,
  ]);
}

export async function listTenantAudit(db: TenantDb, f: ListQuery & { action?: string }): Promise<Page<TenantAuditEntry>> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.q) {
    where.push("(actor LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')");
    args.push(likePattern(f.q), likePattern(f.q), likePattern(f.q));
  }
  if (f.action) {
    where.push("action LIKE ? ESCAPE '\\'");
    args.push(likePrefix(f.action));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await db.batch([
    { sql: `SELECT * FROM audit_log ${w} ORDER BY at DESC LIMIT ? OFFSET ?`, params: [...args, f.pageSize, offsetOf(f)] },
    { sql: `SELECT COUNT(*) AS n FROM audit_log ${w}`, params: args },
  ]);
  return { items: rows!.rows as unknown as TenantAuditEntry[], total: count!.rows[0]!.n as number, page: f.page, pageSize: f.pageSize };
}

// ── API keys ───────────────────────────────────────────────────────────────────
// Format: rose_<keyId>_<secret>. Only SHA-256(secret) is stored; the secret has 256 bits
// of entropy so a fast hash is appropriate. Keys act with a fixed role, never "owner".

export interface ApiKeyItem {
  id: string;
  name: string;
  role: Role;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export async function createApiKey(db: TenantDb, input: { name: string; role: "admin" | "member"; createdBy: string; expiresInDays?: number | null }): Promise<{ key: string; item: ApiKeyItem }> {
  const id = newId("key");
  const secret = randomToken();
  const t = now();
  const item: ApiKeyItem = {
    id, name: input.name.trim().slice(0, 80), role: input.role, created_by: input.createdBy, created_at: t, last_used_at: null,
    expires_at: input.expiresInDays ? t + input.expiresInDays * 86_400_000 : null,
  };
  await db.run("INSERT INTO api_keys (id, name, secret_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id, item.name, await sha256Hex(secret), item.role, item.created_by, t, item.expires_at,
  ]);
  return { key: `rose_${id}_${secret}`, item };
}

export async function verifyApiKey(db: TenantDb, presented: string): Promise<{ id: string; name: string; role: Role } | null> {
  const m = /^rose_(key_[0-9a-f]{24})_([A-Za-z0-9_-]{20,64})$/.exec(presented);
  if (!m) return null;
  const row = await db.first<{ id: string; name: string; secret_hash: string; role: Role; expires_at: number | null; last_used_at: number | null }>(
    "SELECT id, name, secret_hash, role, expires_at, last_used_at FROM api_keys WHERE id = ?", [m[1]!],
  );
  if (!row) return null;
  if (!(await timingSafeEqual(row.secret_hash, await sha256Hex(m[2]!)))) return null;
  if (row.expires_at !== null && row.expires_at < now()) return null;
  if (!row.last_used_at || now() - row.last_used_at > 60_000) await db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  return { id: row.id, name: row.name, role: row.role };
}

export async function listApiKeys(db: TenantDb, f: ListQuery): Promise<Page<ApiKeyItem>> {
  const w = f.q ? "WHERE name LIKE ? ESCAPE '\\'" : "";
  const args = f.q ? [likePattern(f.q)] : [];
  const [rows, count] = await db.batch([
    { sql: `SELECT id, name, role, created_by, created_at, last_used_at, expires_at FROM api_keys ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params: [...args, f.pageSize, offsetOf(f)] },
    { sql: `SELECT COUNT(*) AS n FROM api_keys ${w}`, params: args },
  ]);
  return { items: rows!.rows as unknown as ApiKeyItem[], total: count!.rows[0]!.n as number, page: f.page, pageSize: f.pageSize };
}

export async function revokeApiKey(db: TenantDb, id: string): Promise<void> {
  if ((await db.run("DELETE FROM api_keys WHERE id = ?", [id])) === 0) throw notFound();
}
