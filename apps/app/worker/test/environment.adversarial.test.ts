// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../index";

const odd: unknown[] = [undefined, "", "test", "staging", "Production", " development", "DEVELOPMENT"];
const withEnv = (v: unknown) => ({ ...env, ENVIRONMENT: v }) as never;

describe("adversarial: the shipped tenant app worker fails closed on ENVIRONMENT", () => {
  it("fetch, queue and scheduled all refuse; fetch body is generic", async () => {
    for (const v of odd) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://acme.rose.test/api/auth/code/request", { method: "POST", headers: { Origin: "https://acme.rose.test", "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) }), withEnv(v), ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status, String(v)).toBe(500);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      const text = await res.text();
      expect(text).not.toMatch(/devCode|staging|Production|DEVELOPMENT/);
      await expect(worker.queue({ messages: [{ body: { jobId: "x" }, ack() {} }] }, withEnv(v))).rejects.toThrow();
      await expect(worker.scheduled({}, withEnv(v), {})).rejects.toThrow();
    }
  });

  it("development still serves", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://rose.test/api/bootstrap"), withEnv("development"), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await res.json<{ dev: boolean }>()).dev).toBe(true);
  });
});
