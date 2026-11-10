// SPDX-License-Identifier: Apache-2.0
import { conflict, invalid, notFound } from "../errors";
import { likePattern, offsetOf, type ListQuery, type Page } from "../http/pagination";
import { now } from "../ids";

export type DomainStatus = "pending" | "active" | "failed";
export interface DomainRow {
  hostname: string;
  tenant_id: string;
  status: DomainStatus;
  provider_id: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateHostname(hostname: string, baseDomain: string): string {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(h)) throw invalid("Check the domain.", { hostname: "Enter a full domain such as app.customer.com." });
  // A custom domain may never shadow the platform's own namespace.
  if (h === baseDomain || h.endsWith(`.${baseDomain}`)) {
    throw invalid("Check the domain.", { hostname: `Domains under ${baseDomain} are assigned automatically.` });
  }
  return h;
}

export async function addDomain(db: D1Database, tenantId: string, hostname: string): Promise<DomainRow> {
  const t = now();
  try {
    await db.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").bind(hostname, tenantId, t, t).run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw conflict("That domain is already connected.", { hostname: "Already connected to a workspace." });
    throw err;
  }
  return (await getDomain(db, hostname))!;
}

export const getDomain = (db: D1Database, hostname: string) => db.prepare("SELECT * FROM tenant_domains WHERE hostname = ?").bind(hostname).first<DomainRow>();

export async function setDomainState(db: D1Database, hostname: string, patch: { status: DomainStatus; providerId?: string | null; detail?: string | null }): Promise<void> {
  await db
    .prepare("UPDATE tenant_domains SET status = ?, provider_id = COALESCE(?, provider_id), detail = ?, updated_at = ? WHERE hostname = ?")
    .bind(patch.status, patch.providerId ?? null, patch.detail ?? null, now(), hostname)
    .run();
}

export async function removeDomain(db: D1Database, hostname: string): Promise<DomainRow> {
  const row = await getDomain(db, hostname);
  if (!row) throw notFound();
  await db.prepare("DELETE FROM tenant_domains WHERE hostname = ?").bind(hostname).run();
  return row;
}

export type DomainItem = DomainRow & { tenant_slug: string; tenant_name: string };

export async function listDomains(db: D1Database, f: ListQuery & { status?: string; tenantId?: string }): Promise<Page<DomainItem>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q) {
    where.push("(d.hostname LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')");
    args.push(likePattern(f.q), likePattern(f.q));
  }
  if (f.status && ["pending", "active", "failed"].includes(f.status)) {
    where.push("d.status = ?");
    args.push(f.status);
  }
  if (f.tenantId) {
    where.push("d.tenant_id = ?");
    args.push(f.tenantId);
  }
  const from = `FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const [rows, count] = await db.batch([
    db.prepare(`SELECT d.*, t.slug AS tenant_slug, t.name AS tenant_name ${from} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args),
  ]);
  return { items: rows!.results as DomainItem[], total: (count!.results[0] as { n: number }).n, page: f.page, pageSize: f.pageSize };
}

export async function domainCounts(db: D1Database): Promise<Record<DomainStatus, number>> {
  const rows = await db.prepare("SELECT status, COUNT(*) AS n FROM tenant_domains GROUP BY status").all<{ status: DomainStatus; n: number }>();
  const out = { pending: 0, active: 0, failed: 0 };
  for (const r of rows.results) out[r.status] = r.n;
  return out;
}
