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

/** Queue message: only the job id. The job row in the database is the source of truth. */
export interface JobMessage {
  jobId: string;
}
export interface JobQueue {
  send(body: JobMessage, options?: { delaySeconds?: number }): Promise<unknown>;
}
/** What job functions need: the control-plane database and, when deployed, the queues that wake the workers. */
export interface JobEnv {
  DB: D1Database;
  APP_JOBS?: JobQueue;
  ADMIN_JOBS?: JobQueue;
}

/** Job types the operator worker runs. Everything else runs in the tenant worker. */
export const ADMIN_JOB_TYPES: ReadonlySet<string> = new Set(["domain.verify"]);
const MAX_QUEUE_DELAY_S = 12 * 3600;

/**
 * Wake the worker that owns this job. A lost or missing message is not fatal: the job row
 * stays queued and the hourly sweep (`runDueJobs`) picks it up.
 */
async function notify(env: JobEnv, job: { id: string; type: string }, delayMs = 0): Promise<void> {
  const queue = ADMIN_JOB_TYPES.has(job.type) ? env.ADMIN_JOBS : env.APP_JOBS;
  if (!queue) return;
  try {
    await queue.send({ jobId: job.id }, delayMs > 0 ? { delaySeconds: Math.min(MAX_QUEUE_DELAY_S, Math.ceil(delayMs / 1000)) } : undefined);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: "jobs.notify", job: job.id, error: String(err) }));
  }
}

export async function enqueueJob(
  env: JobEnv,
  input: { type: string; scope: string; title: string; payload?: unknown; createdBy?: string | null; delayMs?: number },
): Promise<JobRow> {
  const t = now();
  const id = newId("job");
  await env.DB
    .prepare("INSERT INTO jobs (id, type, scope, title, payload, run_after, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.type, input.scope, input.title, JSON.stringify(input.payload ?? {}), t + (input.delayMs ?? 0), input.createdBy ?? null, t, t)
    .run();
  const row = (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>())!;
  await notify(env, row, input.delayMs);
  return row;
}

export type JobOutcome = { done: true; result?: unknown } | { done: false; retryInMs: number; note?: string };
export type JobHandler<E> = (env: E, job: JobRow, payload: Record<string, unknown>) => Promise<JobOutcome>;

/**
 * Claim and run one job. Claiming is an atomic compare-and-set, so a queue message, a
 * redelivery and the sweep can all race for the same job and exactly one of them runs it.
 */
async function runOne<E extends JobEnv>(env: E, handlers: Record<string, JobHandler<E>>, job: JobRow): Promise<boolean> {
  const handler = handlers[job.type];
  if (!handler) return false;
  const claim = await env.DB
    .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?")
    .bind(now(), job.id, job.status, job.updated_at)
    .run();
  if (claim.meta.changes === 0) return false;
  try {
    const outcome = await handler(env, job, JSON.parse(job.payload) as Record<string, unknown>);
    if (outcome.done) {
      await env.DB.prepare("UPDATE jobs SET status = 'succeeded', result = ?, error = NULL, updated_at = ? WHERE id = ?").bind(JSON.stringify(outcome.result ?? null), now(), job.id).run();
    } else {
      await env.DB.prepare("UPDATE jobs SET status = 'queued', run_after = ?, error = ?, updated_at = ? WHERE id = ?").bind(now() + outcome.retryInMs, outcome.note ?? null, now(), job.id).run();
      await notify(env, job, outcome.retryInMs);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = job.attempts + 1 >= MAX_ATTEMPTS;
    const backoff = 2 ** job.attempts * 15_000;
    await env.DB
      .prepare("UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?")
      .bind(final ? "failed" : "queued", message.slice(0, 500), now() + backoff, now(), job.id)
      .run();
    if (!final) await notify(env, job, backoff);
  }
  return true;
}

/**
 * Queue consumer: each message names a job to run now. Messages are always acknowledged;
 * retries are scheduled by this code (with backoff, recorded on the job row), not by
 * queue redelivery.
 */
export async function runJobMessages<E extends JobEnv>(
  env: E,
  handlers: Record<string, JobHandler<E>>,
  batch: { messages: readonly { body: unknown; ack(): void }[] },
): Promise<void> {
  for (const message of batch.messages) {
    const jobId = (message.body as Partial<JobMessage> | null)?.jobId;
    try {
      const job = typeof jobId === "string" ? await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>() : null;
      // A message may arrive a moment early, or for a job that is gone or already done.
      if (job && job.status === "queued" && job.run_after <= now() + 1000) await runOne(env, handlers, job);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", at: "jobs.consume", job: jobId, error: String(err) }));
    }
    message.ack();
  }
}

/**
 * Safety-net sweep, run from an hourly cron: picks up due jobs whose queue message was
 * lost, and jobs left "running" by a worker that died.
 */
export async function runDueJobs<E extends JobEnv>(env: E, handlers: Record<string, JobHandler<E>>, limit = 10): Promise<number> {
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
  for (const job of due.results) if (await runOne(env, handlers, job)) ran++;
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

export async function retryJob(env: JobEnv, id: string): Promise<void> {
  const r = await env.DB.prepare("UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, run_after = ?, updated_at = ? WHERE id = ? AND status = 'failed' RETURNING type").bind(now(), now(), id).first<{ type: string }>();
  if (!r) throw notFound();
  await notify(env, { id, type: r.type });
}
