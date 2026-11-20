// SPDX-License-Identifier: Apache-2.0
// Sign-in code verification: per-requester rate limits and split guess budgets.
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker } from "../src";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { ageOut } from "./otp-helpers";
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
    const { code: own } = (await issueLoginCode(env.DB, KEY, scope, email, "owner"))!;
    for (let i = 0; i < 50; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(own), "abuser");
    expect(await verifyLoginCode(env.DB, KEY, scope, email, own, "owner")).toBe(true);
  });

  it("a requester without a code gets 3 guesses on the newest code, then the owner still verifies", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const { code } = (await issueLoginCode(env.DB, KEY, scope, email, "owner"))!;
    for (let i = 0; i < 3; i++) expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "stranger")).toBe(false);
    // Fourth guess: even the right code is refused for the stranger.
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "stranger")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
  });

  it("the foreign budget is shared across strangers", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const { code } = (await issueLoginCode(env.DB, KEY, scope, email, "owner"))!;
    for (const who of ["s1", "s2", "s3"]) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), who);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "s4")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
  });

  it("the owner still has the full 5 guesses", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const { code } = (await issueLoginCode(env.DB, KEY, scope, email, "owner"))!;
    for (let i = 0; i < 3; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "stranger");
    for (let i = 0; i < 4; i++) expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "owner")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
    await ageOut(scope);
    const { code: code2 } = (await issueLoginCode(env.DB, KEY, scope, email, "owner2"))!;
    await tick();
    for (let i = 0; i < 5; i++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code2), "owner2");
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code2, "owner2")).toBe(false);
  });
});

describe("sign-in code per-address guess cap", () => {
  const total = async (scope: string, email: string) =>
    (await env.DB.prepare("SELECT COALESCE(SUM(attempts + foreign_attempts), 0) AS n FROM login_codes WHERE scope = ? AND email = ?").bind(scope, email).first<{ n: number }>())!.n;
  // 2 requesters, one code each; the first spends all 5 owner guesses, the second 4 (9).
  const fill = async (scope: string, email: string) => {
    let last = "";
    for (let i = 0; i < 2; i++) {
      const { code } = (await issueLoginCode(env.DB, KEY, scope, email, `r${i}`))!;
      last = code;
      await ageOut(scope);
      for (let g = 0; g < (i < 1 ? 5 : 4); g++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(last), `r${i}`);
    }
    return last;
  };

  it("rotating requesters hit the cap at exactly 10 and the 11th guess fails even with the right code", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const last = await fill(scope, email);
    expect(await total(scope, email)).toBe(9);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(last), "stranger")).toBe(false);
    expect(await total(scope, email)).toBe(10);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, last, "r1")).toBe(false);
    expect(await total(scope, email)).toBe(10);
  });

  // r0 keeps 1 own guess (4 spent), r1 (newest) spends 4, plus 1 foreign: 9 counted.
  const fillEdge = async (scope: string, email: string) => {
    let last = "";
    for (let i = 0; i < 2; i++) {
      const { code } = (await issueLoginCode(env.DB, KEY, scope, email, `r${i}`))!;
      last = code;
      await ageOut(scope);
      for (let g = 0; g < 4; g++) await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(last), `r${i}`);
    }
    await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(last), "stranger");
    return last;
  };

  it("at 9 guesses the correct newest code of another requester still verifies", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const newest = await fillEdge(scope, email);
    expect(await total(scope, email)).toBe(9);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, newest, "r0")).toBe(true);
    expect(await total(scope, email)).toBe(10);
  });

  it("at 9 guesses a wrong guess still spends the last one and the next verify is refused", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const newest = await fillEdge(scope, email);
    expect(await total(scope, email)).toBe(9);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(newest), "r0")).toBe(false);
    expect(await total(scope, email)).toBe(10);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, newest, "r0")).toBe(false);
    expect(await total(scope, email)).toBe(10);
  });

  it("parallel guesses near the cap do not exceed it", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const last = await fill(scope, email);
    await Promise.all(Array.from({ length: 6 }, (_, i) => verifyLoginCode(env.DB, KEY, scope, email, wrongOf(last), `p${i}`)));
    expect(await total(scope, email)).toBeLessThanOrEqual(10);
  });

  it("guesses on codes older than the window do not count", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const old = Date.now() - 71 * 60_000;
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester, attempts, foreign_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 5, 3)")
        .bind(`old-${uniq()}-${i}`, email, scope, "x", old + 600_000, old, `old${i}`).run();
    }
    const { code } = (await issueLoginCode(env.DB, KEY, scope, email, "fresh"))!;
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "fresh")).toBe(true);
  });

  it("a legitimate owner with a couple of typos still signs in", async () => {
    const scope = `v-${uniq()}`;
    const email = "o@example.com";
    const { code } = (await issueLoginCode(env.DB, KEY, scope, email, "owner"))!;
    for (let i = 0; i < 2; i++) expect(await verifyLoginCode(env.DB, KEY, scope, email, wrongOf(code), "owner")).toBe(false);
    expect(await verifyLoginCode(env.DB, KEY, scope, email, code, "owner")).toBe(true);
  });
});

describe("sign-in code verify rate limits", () => {
  const worker = createTenantWorker({ modules: [notes] });
  const limiter = (limit: number) => {
    const counts = new Map<string, number>();
    return {
      limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return Promise.resolve({ success: n <= limit });
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
