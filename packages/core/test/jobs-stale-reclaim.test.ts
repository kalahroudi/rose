// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantJobHandlers } from "../src";
import { enqueueJob, idempotent, runDueJobs, runJobMessages, type JobOutcome } from "../src/control/jobs";

const row = (id: string) => env.DB.prepare("SELECT status, payload, attempts FROM jobs WHERE id = ?").bind(id).first();

async function race(release: () => JobOutcome | Error) {
  const job = await enqueueJob(env, { type: "t.slow", scope: "platform", title: "slow", payload: { x: 1 } });
  let calls = 0;
  let gate!: () => void;
  const held = new Promise<void>((r) => (gate = r));
  const handlers = {
    "t.slow": async (): Promise<JobOutcome> => {
      if (++calls > 1) return { done: true };
      await held;
      const r = release();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const a = runJobMessages(env, handlers, { messages: [{ body: { jobId: job.id }, ack() {} }] });
  await new Promise((r) => setTimeout(r, 20));
  await env.DB.prepare("UPDATE jobs SET updated_at = updated_at - 600000 WHERE id = ?").bind(job.id).run();
  expect(await runDueJobs(env, handlers)).toBe(1);
  gate();
  await a;
  return { job, calls };
}

describe("stale-run reclaim", () => {
  it("a slow run that throws after being reclaimed does not revive the job", async () => {
    const { job, calls } = await race(() => new Error("late"));
    expect(await row(job.id)).toEqual({ status: "succeeded", payload: "{}", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("a slow run that asks to retry after being reclaimed does not revive the job", async () => {
    const { job, calls } = await race(() => ({ done: false, retryInMs: 1000 }));
    expect(await row(job.id)).toEqual({ status: "succeeded", payload: "{}", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("every registered tenant handler declares itself idempotent", () => {
    const mod = { id: "x", migrations: [], jobs: { go: () => Promise.resolve(null) } } as never;
    for (const [name, h] of Object.entries(tenantJobHandlers([mod]))) expect(h.idempotent, name).toBe(true);
    expect(idempotent(() => Promise.resolve({ done: true } as JobOutcome)).idempotent).toBe(true);
  });
});
