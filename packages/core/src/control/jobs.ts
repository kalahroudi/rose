// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors";
import { offsetOf, type ListQuery, type Page } from "../http/pagination";
import { newId, now } from "../ids";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export interface JobRow {
  id: string;
  type: string;
  scope: string;
  title: string;
  status: JobStatus;
  payload: string;
  result: string | null;
  error: string | null;
  attempts: number;
  run_after: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const MAX_ATTEMPTS = 5;
const STALE_RUNNING = 5 * 60_000;

export async function enqueueJob(
  db: D1Database,
  input: { type: string; scope: string; title: string; payload?: unknown; createdBy?: string | null; delayMs?: number },
): Promise<JobRow> {
  const t = now();
  const id = newId("job");
  await db
    .prepare("INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.type, input.scope, input.title, JSON.stringify(input.payload ?? {}), t + (input.delayMs ?? 0), input.createdBy ?? null, t, t)
    .run();
  return (await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>())!;
}

export type JobOutcome = { done: true; result?: unknown } | { done: false; retryInMs: number; note?: string };
export type JobHandler<E> = (env: E, job: JobRow, payload: Record<string, unknown>) => Promise<JobOutcome>;

/**
 * Run due jobs whose type this worker handles. Claiming is an atomic compare-and-set,
 * so two workers (or two cron ticks) never run the same job concurrently.
 */
export async function runDueJobs<E extends { DB: D1Database }>(env: E, handlers: Record<string, JobHandler<E>>, limit = 10): Promise<number> {
  const types = Object.keys(handlers);
  if (types.length === 0) return 0;
  const t = now();
  const marks = types.map(() => "?").join(",");
  const due = await env.DB
    .prepare(
      `SELECT * FROM jobs WHERE type IN (${marks}) AND run_after <= ?
       AND (status = 'queued' OR (status = 'running' AND updated_at < ?)) ORDER BY run_after LIMIT ?`,
    )
    .bind(...types, t, t - STALE_RUNNING, limit)
    .all<JobRow>();
  let ran = 0;
  for (const job of due.results) {
    const claim = await env.DB
      .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?")
      .bind(now(), job.id, job.status, job.updated_at)
      .run();
    if (claim.meta.changes === 0) continue;
    ran++;
    try {
      const outcome = await handlers[job.type]!(env, job, JSON.parse(job.payload) as Record<string, unknown>);
      if (outcome.done) {
        await env.DB.prepare("UPDATE jobs SET status = 'succeeded', result = ?, error = NULL, updated_at = ? WHERE id = ?").bind(JSON.stringify(outcome.result ?? null), now(), job.id).run();
      } else {
        await env.DB.prepare("UPDATE jobs SET status = 'queued', run_after = ?, error = ?, updated_at = ? WHERE id = ?").bind(now() + outcome.retryInMs, outcome.note ?? null, now(), job.id).run();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = job.attempts + 1 >= MAX_ATTEMPTS;
      await env.DB
        .prepare("UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?")
        .bind(final ? "failed" : "queued", message.slice(0, 500), now() + 2 ** job.attempts * 15_000, now(), job.id)
        .run();
    }
  }
  return ran;
}

export interface JobView {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

const view = (j: JobRow): JobView => ({ id: j.id, type: j.type, title: j.title, status: j.status, error: j.error, attempts: j.attempts, createdAt: j.created_at, updatedAt: j.updated_at });

/** List jobs for a scope. Pass `null` to list every scope (operators only). */
export async function listJobs(db: D1Database, scope: string | null, f: ListQuery & { status?: string }): Promise<Page<JobView> & { active: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (scope !== null) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (f.status && ["queued", "running", "succeeded", "failed"].includes(f.status)) {
    where.push("status = ?");
    args.push(f.status);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const scopeW = scope !== null ? "AND scope = ?" : "";
  const [rows, count, active] = await db.batch([
    db.prepare(`SELECT * FROM jobs ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...args, f.pageSize, offsetOf(f)),
    db.prepare(`SELECT COUNT(*) AS n FROM jobs ${w}`).bind(...args),
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') ${scopeW}`).bind(...(scope !== null ? [scope] : [])),
  ]);
  return {
    items: (rows!.results as JobRow[]).map(view),
    total: (count!.results[0] as { n: number }).n,
    active: (active!.results[0] as { n: number }).n,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function retryJob(db: D1Database, id: string): Promise<void> {
  const r = await db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, run_after = ?, updated_at = ? WHERE id = ? AND status = 'failed'").bind(now(), now(), id).run();
  if (r.meta.changes === 0) throw notFound();
}
