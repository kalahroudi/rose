// SPDX-License-Identifier: Apache-2.0
// Sign-in code verification: per-requester rate limits and split guess budgets.
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker } from "../src";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { createTestTenant } from "../src/testing";
import { notes } from "./worker";

const KEY = env.ROSE_MASTER_KEY;
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
const uniq = () => crypto.randomUUID().slice(0, 8);
const tick = () => new Promise((r) => setTimeout(r, 3));

describe("sign-in code guess budgets", () => {
  it("a flood of wrong guesses from another requester does not invalidate the owner's code", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const own = await issueLoginCode(env.DB, KEY, scope, email, "owner");
    for (let i = 0; i < 50; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(own), "abuser");
    expect(await verifyLoginCode(env.DB, KEY, scope, email, own, "owner")).toBe(true);
  });

  it("a requester without a code gets 3 guesses on the newest code, then the owner still verifies", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const code = await issueLoginCode(env.DB, KEY, scope, email, "owner");
    for (let i = 0; i < 3; i++) expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "stranger")).toBe(false);
    // Fourth guess: even the right code is refused for the stranger.
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "stranger")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
  });

  it("the foreign budget is shared across strangers", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const code = await issueLoginCode(env.DB, KEY, scope, email, "owner");
    for (const who of ["s1", "s2", "s3"]) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), who);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "s4")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
  });

  it("the owner still has the full 5 guesses", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const code = await issueLoginCode(env.DB, KEY, scope, email, "owner");
    for (let i = 0; i < 3; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "stranger");
    for (let i = 0; i < 4; i++) expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "owner")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
    const code2 = await issueLoginCode(env.DB, KEY, scope, email, "owner2");
    await tick();
    for (let i = 0; i < 5; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code2), "owner2");
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code2, "owner2")).toBe(false);
  });
});

describe("sign-in code verify rate limits", () => {
  const worker = createTenantWorker({ modules: [notes] });
  const limiter = (limit: number) => {
    const counts = new Map<string, number>();
    return {
      async limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= limit };
      },
    };
  };
  const verify = async (e: unknown, origin: string, email: string, code: string, ip: string) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(origin + "/api/auth/code/verify", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ email, code }),
      }),
      e as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res.status;
  };

  it("one requester is limited, another requester for the same address is not", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: limiter(3) };
    const wrong = "000000";
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) seen.push(await verify(e, a.origin, a.email, wrong, "198.51.100.1"));
    expect(seen.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(seen[3]).toBe(429);
    expect(seen[4]).toBe(429);
    expect(await verify(e, a.origin, a.email, wrong, "198.51.100.2")).toBe(401);
  });
});
