// SPDX-License-Identifier: Apache-2.0
import { likePattern, offsetOf, type ListQuery, type Page } from "../http/pagination";
import { newId, now } from "../ids";

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
}

/** Operator-plane audit trail. Tenant activity is recorded inside each tenant's own storage instead. */
export async function writePlatformAudit(
  db: D1Database,
  e: { actor: string; action: string; target?: string | null; meta?: unknown; ip?: string | null },
): Promise<void> {
  await db
    .prepare("INSERT INTO platform_audit (id, at, actor, action, target, meta, ip) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("au"), now(), e.actor, e.action, e.target ?? null, e.meta === undefined ? null : JSON.stringify(e.meta), e.ip ?? null)
    .run();
}

export async function listPlatformAudit(db: D1Database, f: ListQuery & { action?: string }): Promise<Page<AuditEntry>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q) {
    where.push("(actor LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')");
    args.push(likePattern(f.q), likePattern(f.q), likePattern(f.q));
  }
  if (f.action) {
    where.push("action LIKE ? ESCAPE '\\'");
    args.push(`${f.action.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await db.batch([
    db.prepare(`SELECT * FROM platform_audit ${w} ORDER BY at DESC LIMIT ? OFFSET ?`).bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n FROM platform_audit ${w}`).bind(...args),
  ]);
  return { items: rows!.results as AuditEntry[], total: (count!.results[0] as { n: number }).n, page: f.page, pageSize: f.pageSize };
}
