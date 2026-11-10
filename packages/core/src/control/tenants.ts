// SPDX-License-Identifier: Apache-2.0
import { conflict, invalid, notFound } from "../errors";
import { likePattern, offsetOf, orderBy, type ListQuery, type Page } from "../http/pagination";
import { newId, now } from "../ids";

export type TenantStatus = "active" | "suspended" | "deleting";
export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  created_at: number;
  updated_at: number;
}

/** Slugs that would collide with platform hosts or look official. */
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
  const row: TenantRow = { id: newId("tn"), slug, name, status: "active", plan: input.plan ?? "free", created_at: t, updated_at: t };
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

export const getTenant = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<TenantRow>();

export const getTenantBySlug = (db: D1Database, slug: string) =>
  db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();

export async function slugAvailable(db: D1Database, slug: string): Promise<boolean> {
  try {
    return !(await getTenantBySlug(db, validateSlug(slug)));
  } catch {
    return false;
  }
}

export interface TenantListFilter extends ListQuery {
  status?: TenantStatus | "";
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

export async function updateTenant(db: D1Database, id: string, patch: { name?: string; plan?: string }): Promise<TenantRow> {
  const cur = await getTenant(db, id);
  if (!cur) throw notFound();
  const name = patch.name?.trim() ?? cur.name;
  if (!name || name.length > 80) throw invalid("Check the workspace name.", { name: "Use 1–80 characters." });
  const plan = patch.plan ?? cur.plan;
  await db.prepare("UPDATE tenants SET name = ?, plan = ?, updated_at = ? WHERE id = ?").bind(name, plan, now(), id).run();
  return { ...cur, name, plan };
}

/** Set status for explicit ids, or for everything matching a filter (server-side select-all). */
export async function setTenantStatus(
  db: D1Database,
  target: { ids: string[] } | { filter: Pick<TenantListFilter, "q" | "status"> },
  status: "active" | "suspended",
): Promise<number> {
  // A tenant being deleted can never be revived by a bulk action.
  if ("ids" in target) {
    if (target.ids.length === 0) return 0;
    const marks = target.ids.map(() => "?").join(",");
    const r = await db
      .prepare(`UPDATE tenants SET status = ?, updated_at = ? WHERE status != 'deleting' AND id IN (${marks})`)
      .bind(status, now(), ...target.ids)
      .run();
    return r.meta.changes;
  }
  const w = tenantWhere(target.filter);
  const r = await db
    .prepare(
      `UPDATE tenants SET status = ?, updated_at = ? WHERE status != 'deleting' AND id IN (SELECT t.id FROM tenants t ${w.sql})`,
    )
    .bind(status, now(), ...w.args)
    .run();
  return r.meta.changes;
}

export async function markTenantDeleting(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE tenants SET status = 'deleting', updated_at = ? WHERE id = ?").bind(now(), id),
    // Cut every live session immediately; the data purge follows as a background job.
    db.prepare("DELETE FROM sessions WHERE scope = ?").bind(id),
  ]);
}

/** Remove every control-plane row of a tenant. Called by the purge job after tenant storage is destroyed. */
export async function deleteTenantRecords(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE scope = ?").bind(id),
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

export async function tenantCounts(db: D1Database): Promise<Record<TenantStatus | "total", number>> {
  const rows = await db.prepare("SELECT status, COUNT(*) AS n FROM tenants GROUP BY status").all<{ status: TenantStatus; n: number }>();
  const out = { active: 0, suspended: 0, deleting: 0, total: 0 };
  for (const r of rows.results) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/** New tenants per day for the last `days` days (UTC), oldest first, zero-filled. */
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
