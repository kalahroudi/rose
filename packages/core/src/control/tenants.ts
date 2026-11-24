// SPDX-License-Identifier: Apache-2.0
import { conflict, invalid, notFound } from "../errors";
import { likePattern, offsetOf, orderBy, type ListQuery, type Page } from "../http/pagination";
import { newId, now } from "../ids";

export type TenantStatus = "active" | "suspended" | "pending_deletion" | "deleting";
export const DELETE_GRACE_MS = 48 * 3_600_000;
export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  created_at: number;
  updated_at: number;
  delete_after: number | null;
  prior_status: "active" | "suspended" | null;
}

export const RESERVED_SLUGS = new Set([
  "www", "app", "admin", "api", "auth", "login", "signup", "mail", "email", "static", "assets", "cdn",
  "status", "support", "help", "docs", "blog", "billing", "dashboard", "console", "root", "system",
  "internal", "platform", "security", "abuse", "postmaster", "localhost", "test", "staging", "dev",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function validateSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!SLUG_RE.test(s) || s.includes("--")) {
    throw invalid("Check the workspace address.", {
      slug: "Use 3–40 lowercase letters, numbers or single hyphens; start and end with a letter or number.",
    });
  }
  if (RESERVED_SLUGS.has(s)) throw invalid("Check the workspace address.", { slug: "That address is reserved." });
  return s;
}

export async function createTenant(db: D1Database, input: { name: string; slug: string; plan?: string }): Promise<TenantRow> {
  const slug = validateSlug(input.slug);
  const name = input.name.trim();
  if (!name || name.length > 80) throw invalid("Check the workspace name.", { name: "Use 1–80 characters." });
  const t = now();
  const row: TenantRow = { id: newId("tn"), slug, name, status: "active", plan: input.plan ?? "free", created_at: t, updated_at: t, delete_after: null, prior_status: null };
  try {
    await db
      .prepare("INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .bind(row.id, row.slug, row.name, row.plan, t, t)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw conflict("That workspace address is taken.", { slug: "Already in use." });
    throw err;
  }
  return row;
}

export async function createTenantForOwner(db: D1Database, userId: string, input: { name: string; slug: string }, cap: number): Promise<TenantRow | null> {
  const slug = validateSlug(input.slug);
  const name = input.name.trim();
  if (!name || name.length > 80) throw invalid("Check the workspace name.", { name: "Use 1–80 characters." });
  const t = now();
  const row: TenantRow = { id: newId("tn"), slug, name, status: "active", plan: "free", created_at: t, updated_at: t, delete_after: null, prior_status: null };
  try {
    const [ins] = await db.batch([
      db
        .prepare(
          "INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at) SELECT ?, ?, ?, 'active', ?, ?, ? WHERE (SELECT COUNT(*) FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.role = 'owner' AND t.status != 'deleting') < ?",
        )
        .bind(row.id, row.slug, row.name, row.plan, t, t, userId, cap),
      db.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) SELECT ?, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?)").bind(row.id, userId, t, row.id),
    ]);
    if (!ins || ins.meta.changes === 0) return null;
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw conflict("That workspace address is taken.", { slug: "Already in use." });
    throw err;
  }
  return row;
}

export const getTenant = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<TenantRow>();

export const getTenantBySlug = (db: D1Database, slug: string) =>
  db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();

export async function countOwnedWorkspaces(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.role = 'owner' AND t.status != 'deleting'")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function slugAvailable(db: D1Database, slug: string): Promise<boolean> {
  try {
    return !(await getTenantBySlug(db, validateSlug(slug)));
  } catch {
    return false;
  }
}

export interface TenantListFilter extends ListQuery {
  status?: TenantStatus | "" | undefined;
}

function tenantWhere(f: Pick<TenantListFilter, "q" | "status">): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q) {
    where.push("(t.name LIKE ? ESCAPE '\\' OR t.slug LIKE ? ESCAPE '\\')");
    args.push(likePattern(f.q), likePattern(f.q));
  }
  if (f.status) {
    where.push("t.status = ?");
    args.push(f.status);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export type TenantListItem = TenantRow & { members: number; domains: number };

export async function listTenants(db: D1Database, f: TenantListFilter): Promise<Page<TenantListItem>> {
  const w = tenantWhere(f);
  const order = orderBy(f.sort, { name: "t.name", slug: "t.slug", created: "t.created_at", status: "t.status" }, "t.created_at DESC");
  const [rows, count] = await db.batch([
    db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id) AS members,
           (SELECT COUNT(*) FROM tenant_domains d WHERE d.tenant_id = t.id) AS domains
         FROM tenants t ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...w.args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n FROM tenants t ${w.sql}`).bind(...w.args),
  ]);
  return {
    items: rows!.results as TenantListItem[],
    total: (count!.results[0] as { n: number }).n,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function updateTenant(db: D1Database, id: string, patch: { name?: string | undefined; plan?: string | undefined }): Promise<TenantRow> {
  const cur = await getTenant(db, id);
  if (!cur) throw notFound();
  const name = patch.name?.trim() ?? cur.name;
  if (!name || name.length > 80) throw invalid("Check the workspace name.", { name: "Use 1–80 characters." });
  const plan = patch.plan ?? cur.plan;
  await db.prepare("UPDATE tenants SET name = ?, plan = ?, updated_at = ? WHERE id = ?").bind(name, plan, now(), id).run();
  return { ...cur, name, plan };
}

export async function setTenantStatus(
  db: D1Database,
  target: { ids: string[] } | { filter: Pick<TenantListFilter, "q" | "status"> },
  status: "active" | "suspended",
): Promise<number> {
  if ("ids" in target) {
    if (target.ids.length === 0) return 0;
    const r = await db
      .prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE status NOT IN ('pending_deletion', 'deleting') AND id IN (SELECT value FROM json_each(?))")
      .bind(status, now(), JSON.stringify(target.ids))
      .run();
    return r.meta.changes;
  }
  const w = tenantWhere(target.filter);
  const r = await db
    .prepare(
      `UPDATE tenants SET status = ?, updated_at = ? WHERE status NOT IN ('pending_deletion', 'deleting') AND id IN (SELECT t.id FROM tenants t ${w.sql})`,
    )
    .bind(status, now(), ...w.args)
    .run();
  return r.meta.changes;
}

export type TenantDeletionRequest =
  | { created: true; deleteAfter: number; jobId: string }
  | { created: false; deleteAfter: number; jobId?: undefined };

export interface TenantDeletionJobOptions {
  title?: string;
  createdBy?: string | null;
}

export async function requestTenantDeletion(
  db: D1Database,
  id: string,
  job?: TenantDeletionJobOptions,
): Promise<TenantDeletionRequest> {
  const t = now();
  const deleteAfter = t + DELETE_GRACE_MS;
  const jobId = newId("job");
  const title = job?.title ?? `Delete tenant ${id}`;
  const createdBy = job?.createdBy ?? null;
  const payload = JSON.stringify({ tenantId: id });
  const [upd, , , , , , , read] = await db.batch([
    db
      .prepare(
        "UPDATE tenants SET status = 'pending_deletion', prior_status = status, delete_after = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'suspended')",
      )
      .bind(deleteAfter, t, id),
    db
      .prepare(
        "INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at) SELECT ?, 'tenant.purge', 'platform', ?, ?, ?, ?, ?, ? WHERE changes() = 1",
      )
      .bind(jobId, title, payload, deleteAfter, createdBy, t, t),
    db
      .prepare("DELETE FROM sessions WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion' AND delete_after = ?)")
      .bind(id, id, deleteAfter),
    db
      .prepare("DELETE FROM login_codes WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion' AND delete_after = ?)")
      .bind(id, id, deleteAfter),
    db
      .prepare("DELETE FROM handoffs WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion' AND delete_after = ?)")
      .bind(id, id, deleteAfter),
    db
      .prepare("DELETE FROM webauthn_challenges WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion' AND delete_after = ?)")
      .bind(id, id, deleteAfter),
    db
      .prepare("DELETE FROM jobs WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion' AND delete_after = ?)")
      .bind(id, id, deleteAfter),
    db.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id),
  ]);
  if ((upd?.meta.changes ?? 0) > 0) {
    return { deleteAfter, created: true, jobId };
  }
  const row = (read?.results[0] as { status: TenantStatus; delete_after: number | null } | undefined) ?? null;
  if (!row || row.status === "deleting") throw notFound();
  if (row.delete_after === null) throw conflict("This tenant is already scheduled for deletion.");
  return { deleteAfter: row.delete_after, created: false };
}

export interface TenantDeletionCancellation {
  status: "active" | "suspended";
  deleteAfter: number | null;
}

export async function cancelTenantDeletion(db: D1Database, id: string): Promise<TenantDeletionCancellation | null> {
  const [, , , , , before, upd] = await db.batch([
    db.prepare("DELETE FROM sessions WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion')").bind(id, id),
    db.prepare("DELETE FROM login_codes WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion')").bind(id, id),
    db.prepare("DELETE FROM handoffs WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion')").bind(id, id),
    db.prepare("DELETE FROM webauthn_challenges WHERE scope = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion')").bind(id, id),
    db
      .prepare(
        "DELETE FROM jobs WHERE type = 'tenant.purge' AND status = 'queued' AND json_extract(payload, '$.tenantId') = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'pending_deletion')",
      )
      .bind(id, id),
    db.prepare("SELECT delete_after FROM tenants WHERE id = ? AND status = 'pending_deletion'").bind(id),
    db
      .prepare(
        "UPDATE tenants SET status = CASE WHEN prior_status = 'suspended' THEN 'suspended' ELSE 'active' END, delete_after = NULL, prior_status = NULL, updated_at = ? WHERE id = ? AND status = 'pending_deletion' RETURNING status",
      )
      .bind(now(), id),
  ]);
  const updated = upd?.results[0] as { status: "active" | "suspended" } | undefined;
  if (!updated) return null;
  const prev = before?.results[0] as { delete_after: number | null } | undefined;
  return { status: updated.status, deleteAfter: prev?.delete_after ?? null };
}

export async function beginTenantPurge(db: D1Database, id: string): Promise<boolean> {
  const t = now();
  const r = await db
    .prepare("UPDATE tenants SET status = 'deleting', updated_at = ? WHERE id = ? AND status = 'pending_deletion' AND delete_after IS NOT NULL AND delete_after <= ?")
    .bind(t, id, t)
    .run();
  return r.meta.changes > 0;
}

export async function deleteTenantRecords(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM jobs WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM passkeys WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM login_codes WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM handoffs WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM webauthn_challenges WHERE scope = ?").bind(id),
    db.prepare("DELETE FROM invitations WHERE tenant_id = ?").bind(id),
    db.prepare("DELETE FROM memberships WHERE tenant_id = ?").bind(id),
    db.prepare("DELETE FROM tenant_domains WHERE tenant_id = ?").bind(id),
    db.prepare("DELETE FROM tenants WHERE id = ? AND status = 'deleting'").bind(id),
  ]);
}

export interface RecoveredPurgeJob {
  id: string;
  tenantId: string;
}

export async function recoverStuckPurges(db: D1Database): Promise<RecoveredPurgeJob[]> {
  const t = now();
  const stuck = `(t.status = 'deleting' OR (t.status = 'pending_deletion' AND t.delete_after IS NOT NULL AND t.delete_after <= ?))
     AND NOT EXISTS (
       SELECT 1 FROM jobs j
       WHERE j.type = 'tenant.purge' AND j.status IN ('queued', 'running') AND json_extract(j.payload, '$.tenantId') = t.id
     )`;
  const [, inserted] = await db.batch<{ id: string; tenant_id: string }>([
    db
      .prepare(
        `INSERT INTO platform_audit (id, at, actor, action, target, meta, ip)
         SELECT 'au_' || lower(hex(randomblob(12))), ?, 'system', 'tenant.purge_recovered', t.id, NULL, NULL
         FROM tenants t
         WHERE ${stuck}
         ORDER BY t.updated_at ASC, t.id ASC
         LIMIT 100`,
      )
      .bind(t, t),
    db
      .prepare(
        `INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at)
         SELECT 'job_' || lower(hex(randomblob(12))), 'tenant.purge', 'platform', 'Delete tenant ' || t.id,
                json_object('tenantId', t.id), ?, 'system', ?, ?
         FROM tenants t
         WHERE ${stuck}
         ORDER BY t.updated_at ASC, t.id ASC
         LIMIT 100
         RETURNING id, json_extract(payload, '$.tenantId') AS tenant_id`,
      )
      .bind(t, t, t, t),
  ]);
  const rows = inserted!.results;
  return rows.map((row) => ({ id: row.id, tenantId: row.tenant_id }));
}

export async function tenantCounts(db: D1Database): Promise<Record<TenantStatus | "total", number>> {
  const rows = await db.prepare("SELECT status, COUNT(*) AS n FROM tenants GROUP BY status").all<{ status: TenantStatus; n: number }>();
  const out = { active: 0, suspended: 0, pending_deletion: 0, deleting: 0, total: 0 };
  for (const r of rows.results) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

export async function tenantSignupSeries(db: D1Database, days = 14): Promise<{ day: string; count: number }[]> {
  const dayMs = 86_400_000;
  const start = Math.floor(now() / dayMs) * dayMs - (days - 1) * dayMs;
  const rows = await db
    .prepare("SELECT CAST(created_at / 86400000 AS INTEGER) AS d, COUNT(*) AS n FROM tenants WHERE created_at >= ? GROUP BY d")
    .bind(start)
    .all<{ d: number; n: number }>();
  const byDay = new Map(rows.results.map((r) => [r.d, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const d = start / dayMs + i;
    return { day: new Date(d * dayMs).toISOString().slice(0, 10), count: byDay.get(d) ?? 0 };
  });
}
