// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for M7: a stale run that lost ownership must never overwrite the newer run's outcome.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { enqueueJob, retryJob, runDueJobs, runJobMessages, type JobHandler, type JobOutcome } from "../src/control/jobs";

type Step = () => JobOutcome | Error;
interface Script {
  calls: number;
  handlers: Record<string, JobHandler<typeof env>>;
  /** Release call n (1-based) with the given outcome. */
  release(n: number, step: Step): void;
  /** Wait until the handler has been entered n times. */
  entered(n: number): Promise<void>;
}

let seq = 0;
const freshType = () => `t.adv${++seq}.${Math.random().toString(36).slice(2, 8)}`;

/** A handler where every call blocks until the test releases it with an outcome. */
function script(type: string, immediate: Record<number, Step> = {}): Script {
  const gates = new Map<number, { p: Promise<Step>; r: (s: Step) => void }>();
  const gate = (n: number) => {
    if (!gates.has(n)) {
      let r!: (s: Step) => void;
      const p = new Promise<Step>((res) => (r = res));
      gates.set(n, { p, r });
    }
    return gates.get(n)!;
  };
  const s: Script = {
    calls: 0,
    handlers: {
      [type]: async () => {
        const n = ++s.calls;
        const step = immediate[n] ?? (await gate(n).p);
        const out = step();
        if (out instanceof Error) throw out;
        return out;
      },
    },
    release: (n, step) => gate(n).r(step),
    entered: async (n) => {
      for (let i = 0; i < 500 && s.calls < n; i++) await new Promise((r) => setTimeout(r, 5));
      expect(s.calls).toBeGreaterThanOrEqual(n);
    },
  };
  return s;
}

const row = (id: string) =>
  env.DB.prepare("SELECT status, payload, result, attempts FROM jobs WHERE id = ?").bind(id).first<{ status: string; payload: string; result: string | null; attempts: number }>();
const makeStale = (id: string) => env.DB.prepare("UPDATE jobs SET updated_at = updated_at - 600000, run_after = 0 WHERE id = ?").bind(id).run();
const makeDue = (id: string) => env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").bind(id).run();
const msg = (id: string) => ({ messages: [{ body: { jobId: id }, ack() {} }] });

describe("stale-run reclaim (adversarial)", () => {
  it("a stale run that also succeeds does not overwrite the reclaimer's result", async () => {
    const type = freshType();
    const s = script(type, { 2: () => ({ done: true, result: "from-B" }) });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    const a = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(1);
    await makeStale(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    s.release(1, () => ({ done: true, result: "from-A" }));
    await a;
    const r = await row(job.id);
    expect(r?.status).toBe("succeeded");
    expect(r?.payload).toBe("{}");
    expect(JSON.parse(r!.result!)).toBe("from-B");
    expect(s.calls).toBe(2);
  });

  it("a stale run that finishes first while the reclaimer is still running does not write; the reclaimer's outcome stands", async () => {
    const type = freshType();
    const s = script(type);
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    const a = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(1);
    await makeStale(job.id);
    const b = runDueJobs(env, s.handlers);
    await s.entered(2);
    // A (lost ownership) succeeds first: the row is owned by B and must stay running.
    s.release(1, () => ({ done: true, result: "from-A" }));
    await a;
    expect((await row(job.id))?.status).toBe("running");
    // B then fails transiently: job goes back to the queue with its payload intact.
    s.release(2, () => new Error("B transient"));
    expect(await b).toBe(1);
    const r = await row(job.id);
    expect(r?.status).toBe("queued");
    expect(JSON.parse(r!.payload)).toEqual({ x: 1 });
    expect(r?.attempts).toBe(2);
  });

  it("a stale run cannot revive a job the reclaimer marked failed on its final attempt", async () => {
    const type = freshType();
    const s = script(type, { 2: () => new Error("B final") });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    await env.DB.prepare("UPDATE jobs SET attempts = 3 WHERE id = ?").bind(job.id).run();
    const a = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(1);
    await makeStale(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    expect((await row(job.id))?.status).toBe("failed");
    s.release(1, () => ({ done: true, result: "from-A" }));
    await a;
    const r = await row(job.id);
    expect(r?.status).toBe("failed");
    expect(r?.payload).toBe("{}");
    expect(r?.attempts).toBe(5);
  });

  it("two stale runs (A, then reclaimer B, then reclaimer C) cannot override C's success", async () => {
    const type = freshType();
    const s = script(type, { 3: () => ({ done: true, result: "from-C" }) });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    const a = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(1);
    await makeStale(job.id);
    const b = runDueJobs(env, s.handlers);
    await s.entered(2);
    await makeStale(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    s.release(2, () => ({ done: false, retryInMs: 1000 }));
    s.release(1, () => new Error("A late"));
    await Promise.all([a, b]);
    const r = await row(job.id);
    expect(r?.status).toBe("succeeded");
    expect(r?.payload).toBe("{}");
    expect(JSON.parse(r!.result!)).toBe("from-C");
    expect(s.calls).toBe(3);
  });

  it("a stale run cannot overwrite a newer run after an operator retry reset the attempt counter", async () => {
    const type = freshType();
    const fail = () => new Error("boom");
    const s = script(type, { 2: fail, 3: fail, 4: fail, 5: fail });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    // A claims attempt 1 and hangs.
    const a = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(1);
    // The sweep reclaims it and it fails through attempts 2..5 to 'failed'.
    await makeStale(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    for (let i = 0; i < 3; i++) {
      await makeDue(job.id);
      expect(await runDueJobs(env, s.handlers)).toBe(1);
    }
    expect((await row(job.id))?.status).toBe("failed");
    // Operator retries; a new run F claims it and is still working.
    await retryJob(env, job.id);
    const f = runJobMessages(env, s.handlers, msg(job.id));
    await s.entered(6);
    expect((await row(job.id))?.status).toBe("running");
    // The long-lost run A now throws. It does not own the row any more and must not write.
    s.release(1, () => new Error("A very late"));
    await a;
    const mid = await row(job.id);
    expect(mid?.status).toBe("running");
    s.release(6, () => ({ done: true, result: "from-F" }));
    await f;
    const r = await row(job.id);
    expect(r?.status).toBe("succeeded");
    expect(JSON.parse(r!.result!)).toBe("from-F");
  });

  it("the final-attempt decision uses the claimed attempt number", async () => {
    const type = freshType();
    const s = script(type, { 1: () => new Error("x"), 2: () => new Error("y") });
    const j4 = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    await env.DB.prepare("UPDATE jobs SET attempts = 4 WHERE id = ?").bind(j4.id).run();
    await runJobMessages(env, s.handlers, msg(j4.id));
    expect(await row(j4.id)).toMatchObject({ status: "failed", payload: "{}", attempts: 5 });

    const j3 = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    await env.DB.prepare("UPDATE jobs SET attempts = 3 WHERE id = ?").bind(j3.id).run();
    await runJobMessages(env, s.handlers, msg(j3.id));
    const r = await row(j3.id);
    expect(r).toMatchObject({ status: "queued", attempts: 4 });
    expect(JSON.parse(r!.payload)).toEqual({ x: 1 });
  });

  it("an uncontended run still records every outcome (the guard is not over-strict)", async () => {
    const type = freshType();
    const s = script(type, {
      1: () => ({ done: false, retryInMs: 1000, note: "wait" }),
      2: () => new Error("transient"),
      3: () => ({ done: true, result: { ok: 1 } }),
    });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    await runJobMessages(env, s.handlers, msg(job.id));
    expect(await row(job.id)).toMatchObject({ status: "queued", attempts: 1 });
    await makeDue(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    expect(await row(job.id)).toMatchObject({ status: "queued", attempts: 2 });
    await makeDue(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    const r = await row(job.id);
    expect(r).toMatchObject({ status: "succeeded", payload: "{}", attempts: 3 });
    expect(JSON.parse(r!.result!)).toEqual({ ok: 1 });
  });

  it("a worker that died mid-run is reclaimed by the sweep and completes", async () => {
    const type = freshType();
    const s = script(type, { 1: () => ({ done: true, result: "B" }) });
    const job = await enqueueJob(env, { type, scope: "platform", title: "t", payload: { x: 1 } });
    // Simulate a claim by a worker that then vanished.
    await env.DB.prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?").bind(job.id).run();
    await makeStale(job.id);
    expect(await runDueJobs(env, s.handlers)).toBe(1);
    expect(await row(job.id)).toMatchObject({ status: "succeeded", payload: "{}", attempts: 2 });
  });
});
