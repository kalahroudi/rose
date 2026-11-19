// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for per-requester sign-in code verification limits and split guess budgets (spec L3).
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker } from "../src";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { createTestTenant } from "../src/testing";
import { notes } from "./worker";

const KEY = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const DB = (env as unknown as { DB: D1Database }).DB;
const tick = () => new Promise((r) => setTimeout(r, 3));
const uniq = () => crypto.randomUUID().slice(0, 8);
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
const E = "e@example.com";

/** In-memory RL_AUTH stand-in with the production shape (limit per key), recording every key. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    counts,
    binding: {
      limit({ key }: { key: string }) {
        seen.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return Promise.resolve({ success: n <= limit });
      },
    },
  };
}

const worker = createTenantWorker({ modules: [notes] });
async function call(e: unknown, origin: string, path: string, body: unknown, ip?: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(origin + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(ip === undefined ? {} : { "CF-Connecting-IP": ip }) },
      body: JSON.stringify(body),
    }),
    e as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const requestCode = async (e: unknown, origin: string, email: string, ip?: string) => {
  const res = await call(e, origin, "/api/auth/code/request", { email }, ip);
  return { status: res.status, devCode: (await res.json<{ devCode?: string }>()).devCode };
};
const verify = async (e: unknown, origin: string, email: string, code: string, ip?: string) =>
  (await call(e, origin, "/api/auth/code/verify", { email, code }, ip)).status;
const row = async (scope: string) =>
  (await DB.prepare("SELECT attempts, foreign_attempts, consumed_at FROM login_codes WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(scope)
    .first<{ attempts: number; foreign_attempts: number; consumed_at: number | null }>())!;

describe("adversarial verify: HTTP lockout by another IP", () => {
  it("an abuser flooding wrong codes to 429 does not stop the real user requesting and verifying", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(20);
    const e = { ...env, RL_AUTH: rl.binding };
    const legit = "203.0.113.5";
    const mine = await requestCode(e, a.origin, a.email, legit);
    expect(mine.status).toBe(200);
    const before = rl.seen.length;
    let limited = 0;
    for (let i = 0; i < 60 && !limited; i++) if ((await verify(e, a.origin, a.email, wrongOf(mine.devCode!), "198.51.100.5")) === 429) limited = i + 1;
    expect(limited).toBeGreaterThan(0);
    // Nothing the abuser touched names the legit requester.
    for (const k of rl.seen.slice(before)) expect(k).not.toContain(legit);
    expect(await verify(e, a.origin, a.email, mine.devCode!, legit)).toBe(200);
  });

  it("the abuser's flood (no own code) spends at most 3 guesses on the real user's code and none of the owner's 5", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "203.0.113.6");
    for (let i = 0; i < 30; i++) await verify(e, a.origin, a.email, wrongOf(mine.devCode!), "198.51.100.6");
    const r = await row(a.id);
    expect(r.foreign_attempts).toBeLessThanOrEqual(3);
    expect(r.attempts).toBe(0);
    for (let i = 0; i < 4; i++) expect(await verify(e, a.origin, a.email, wrongOf(mine.devCode!), "203.0.113.6")).toBe(401);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "203.0.113.6")).toBe(200);
  });

  it("the verify limiter keys are checked before any guess is spent (429 spends no attempt)", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(0).binding };
    const s = await requestCode({ ...env, RL_AUTH: fakeLimiter(100).binding }, a.origin, a.email, "203.0.113.7");
    expect(await verify(e, a.origin, a.email, wrongOf(s.devCode!), "198.51.100.7")).toBe(429);
    expect(await verify(e, a.origin, a.email, wrongOf(s.devCode!), "203.0.113.7")).toBe(429);
    const r = await row(a.id);
    expect(r.attempts).toBe(0);
    expect(r.foreign_attempts).toBe(0);
  });
});

describe("adversarial verify: rotating emails from one IP", () => {
  it("one IP guessing across many addresses is still bounded by the per-IP verify key", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(20);
    const e = { ...env, RL_AUTH: rl.binding };
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push(await verify(e, a.origin, `victim${i}@example.com`, "000000", "198.51.100.20"));
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(rl.seen.some((k) => k.startsWith("verify-ip:") && k.includes("198.51.100.20"))).toBe(true);
  });

  it("email case/whitespace variations map to the same per-email verify key", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(1000);
    const e = { ...env, RL_AUTH: rl.binding };
    for (const v of [a.email, a.email.toUpperCase(), ` ${a.email} `]) await verify(e, a.origin, v, "000000", "198.51.100.21");
    const emailKeys = new Set(rl.seen.filter((k) => k.startsWith("verify:")));
    expect(emailKeys.size).toBe(1);
  });
});

describe("adversarial verify: rotating requesters vs the foreign cap", () => {
  it("20 rotating IPs x 3 wrong guesses never exceed 3 foreign guesses; the owner still signs in (HTTP)", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "203.0.113.30");
    for (let i = 0; i < 20; i++) for (let j = 0; j < 3; j++) await verify(e, a.origin, a.email, wrongOf(mine.devCode!), `10.9.0.${i + 1}`);
    expect((await row(a.id)).foreign_attempts).toBe(3);
    // The right code from yet another stranger is now refused.
    expect(await verify(e, a.origin, a.email, mine.devCode!, "10.9.1.1")).toBe(401);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "203.0.113.30")).toBe(200);
  });

  it("total guesses on one code stay bounded at 8 however requesters rotate", async () => {
    const s = `adv-v-tot-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    for (let i = 0; i < 20; i++) await verifyLoginCode(DB, KEY, s, E, wrongOf(y), `r${i}`);
    for (let i = 0; i < 20; i++) await verifyLoginCode(DB, KEY, s, E, wrongOf(y), "Y");
    const r = await row(s);
    expect(r.attempts + r.foreign_attempts).toBeLessThanOrEqual(8);
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Y")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Z")).toBe(false);
  });

  it("owner exhausting its own 5 also closes the code to strangers", async () => {
    const s = `adv-v-own5-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    for (let i = 0; i < 5; i++) await verifyLoginCode(DB, KEY, s, E, wrongOf(y), "Y");
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Z")).toBe(false);
    expect((await row(s)).foreign_attempts).toBe(0);
  });

  it("a stranger that requests its own code does not gain extra guesses on the owner's code", async () => {
    const s = `adv-v-own-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    await tick();
    await issueLoginCode(DB, KEY, s, E, "X");
    // X's code is newest; X's guesses go to its own code only. Y's code is untouched.
    for (let i = 0; i < 10; i++) await verifyLoginCode(DB, KEY, s, E, wrongOf(y), "X");
    const yr = await DB.prepare("SELECT attempts, foreign_attempts FROM login_codes WHERE scope = ? ORDER BY created_at ASC, rowid ASC LIMIT 1").bind(s).first<{ attempts: number; foreign_attempts: number }>();
    expect(yr!.attempts).toBe(0);
    expect(yr!.foreign_attempts).toBe(0);
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Y")).toBe(true);
  });

  it("legacy code with NULL requester is foreign to everyone: at most 3 guesses", async () => {
    const s = `adv-v-null-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "tmp");
    await DB.prepare("UPDATE login_codes SET requester = NULL WHERE scope = ?").bind(s).run();
    for (let i = 0; i < 6; i++) await verifyLoginCode(DB, KEY, s, E, wrongOf(y), "tmp");
    const r = await row(s);
    expect(r.attempts + r.foreign_attempts).toBeLessThanOrEqual(5);
    expect(r.foreign_attempts).toBeLessThanOrEqual(3);
  });
});

describe("adversarial verify: parallel owner + foreign races", () => {
  it("parallel wrong guesses from owner and strangers never exceed 5 owner + 3 foreign", async () => {
    const s = `adv-v-race-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    await Promise.all([
      ...Array.from({ length: 15 }, () => verifyLoginCode(DB, KEY, s, E, wrongOf(y), "Y")),
      ...Array.from({ length: 15 }, (_, i) => verifyLoginCode(DB, KEY, s, E, wrongOf(y), `f${i}`)),
    ]);
    const r = await row(s);
    expect(r.attempts).toBe(5);
    expect(r.foreign_attempts).toBeLessThanOrEqual(3);
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Y")).toBe(false);
  });

  it("parallel foreign flood leaves the owner's correct code (sent in the same burst) working", async () => {
    const s = `adv-v-race2-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => verifyLoginCode(DB, KEY, s, E, wrongOf(y), `g${i}`)),
      verifyLoginCode(DB, KEY, s, E, y, "Y"),
    ]);
    expect(results[20]).toBe(true);
    expect(results.slice(0, 20).every((x) => x === false)).toBe(true);
  });

  it("owner and stranger both sending the right code in parallel: exactly one succeeds", async () => {
    const s = `adv-v-race3-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    const results = await Promise.all([
      verifyLoginCode(DB, KEY, s, E, y, "Y"),
      verifyLoginCode(DB, KEY, s, E, y, "Z1"),
      verifyLoginCode(DB, KEY, s, E, y, "Y"),
      verifyLoginCode(DB, KEY, s, E, y, "Z2"),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it("parallel HTTP verifies of the right code yield exactly one session", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "203.0.113.40");
    const statuses = await Promise.all(["203.0.113.40", "198.51.100.40", "203.0.113.40", "198.51.100.41"].map((ip) => verify(e, a.origin, a.email, mine.devCode!, ip)));
    expect(statuses.filter((x) => x === 200).length).toBe(1);
  });
});

describe("adversarial verify: IPv6 /64 bucketing", () => {
  it("two addresses in one /64 share the verify rate-limit keys", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(3);
    const e = { ...env, RL_AUTH: rl.binding };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push(await verify(e, a.origin, a.email, "000000", `2001:db8:1:2::${i + 1}`));
    statuses.push(await verify(e, a.origin, a.email, "000000", "2001:db8:1:2:ffff:ffff:ffff:ffff"));
    statuses.push(await verify(e, a.origin, a.email, "000000", "2001:DB8:1:2:0:0:0:abcd"));
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    for (const k of rl.seen) expect(k).not.toMatch(/2001:db8:1:2::\d|ffff:ffff|abcd/i);
    // A different /64 is a different requester.
    expect(await verify(e, a.origin, a.email, "000000", "2001:db8:1:3::1")).toBe(401);
  });

  it("an owner hopping addresses inside its /64 keeps its own 5-guess budget (not the foreign 3)", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "2001:db8:aa:bb::1");
    for (let i = 0; i < 4; i++) expect(await verify(e, a.origin, a.email, wrongOf(mine.devCode!), `2001:db8:aa:bb::${i + 10}`)).toBe(401);
    const r = await row(a.id);
    expect(r.attempts).toBe(4);
    expect(r.foreign_attempts).toBe(0);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "2001:db8:aa:bb:1:2:3:4")).toBe(200);
  });

  it("an address in another /64 is foreign to the code", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "2001:db8:aa:cc::1");
    for (let i = 0; i < 3; i++) await verify(e, a.origin, a.email, wrongOf(mine.devCode!), "2001:db8:aa:cd::1");
    expect(await verify(e, a.origin, a.email, mine.devCode!, "2001:db8:aa:cd::1")).toBe(401);
    expect((await row(a.id)).foreign_attempts).toBe(3);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "2001:db8:aa:cc::9")).toBe(200);
  });

  it("IPv4-mapped IPv6 is the same requester as the plain IPv4 address", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(1000);
    const e = { ...env, RL_AUTH: rl.binding };
    const mine = await requestCode(e, a.origin, a.email, "198.51.100.90");
    for (let i = 0; i < 4; i++) await verify(e, a.origin, a.email, wrongOf(mine.devCode!), "::ffff:198.51.100.90");
    expect((await row(a.id)).foreign_attempts).toBe(0);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "::ffff:c633:645a")).toBe(200);
  });
});

describe("adversarial verify: no resurrection of older codes", () => {
  it("after the owner's newest code is consumed, its older code is dead", async () => {
    const s = `adv-v-res1-${uniq()}`;
    const old = await issueLoginCode(DB, KEY, s, E, "Y");
    await tick();
    const fresh = await issueLoginCode(DB, KEY, s, E, "Y");
    expect(await verifyLoginCode(DB, KEY, s, E, fresh, "Y")).toBe(true);
    if (old !== fresh) {
      expect(await verifyLoginCode(DB, KEY, s, E, old, "Y")).toBe(false);
      expect(await verifyLoginCode(DB, KEY, s, E, old, "Z")).toBe(false);
    }
  });

  it("after the owner's newest code is exhausted, its older code is dead", async () => {
    const s = `adv-v-res2-${uniq()}`;
    const old = await issueLoginCode(DB, KEY, s, E, "Y");
    await tick();
    const fresh = await issueLoginCode(DB, KEY, s, E, "Y");
    for (let i = 0; i < 5; i++) await verifyLoginCode(DB, KEY, s, E, old === wrongOf(fresh) ? wrongOf(old) : wrongOf(fresh), "Y");
    if (old !== fresh) expect(await verifyLoginCode(DB, KEY, s, E, old, "Y")).toBe(false);
  });

  it("strangers exhausting the newest code's foreign budget do not fall back to an older code", async () => {
    const s = `adv-v-res3-${uniq()}`;
    const old = await issueLoginCode(DB, KEY, s, E, "Y");
    await tick();
    const fresh = await issueLoginCode(DB, KEY, s, E, "Y");
    for (let i = 0; i < 3; i++) await verifyLoginCode(DB, KEY, s, E, old === wrongOf(fresh) ? wrongOf(old) : wrongOf(fresh), `z${i}`);
    if (old !== fresh) expect(await verifyLoginCode(DB, KEY, s, E, old, "z9")).toBe(false);
    // Older code was never touched.
    const o = await DB.prepare("SELECT attempts, foreign_attempts FROM login_codes WHERE scope = ? ORDER BY created_at ASC, rowid ASC LIMIT 1").bind(s).first<{ attempts: number; foreign_attempts: number }>();
    expect(o!.attempts + o!.foreign_attempts).toBe(0);
  });

  it("expired newest code does not revive an older live code", async () => {
    const s = `adv-v-res4-${uniq()}`;
    const old = await issueLoginCode(DB, KEY, s, E, "Y");
    await tick();
    const fresh = await issueLoginCode(DB, KEY, s, E, "Y");
    await DB.prepare("UPDATE login_codes SET expires_at = 1 WHERE scope = ? AND created_at = (SELECT MAX(created_at) FROM login_codes WHERE scope = ?)").bind(s, s).run();
    if (old !== fresh) expect(await verifyLoginCode(DB, KEY, s, E, old, "Y")).toBe(false);
  });
});

describe("adversarial verify: scope isolation", () => {
  it("foreign guesses in scope A do not spend the budget of the same address's code in scope B", async () => {
    const sa = `adv-v-sa-${uniq()}`;
    const sb = `adv-v-sb-${uniq()}`;
    const ca = await issueLoginCode(DB, KEY, sa, E, "Y");
    const cb = await issueLoginCode(DB, KEY, sb, E, "Y");
    for (let i = 0; i < 10; i++) await verifyLoginCode(DB, KEY, sa, E, wrongOf(cb === ca ? wrongOf(ca) : cb), `x${i}`);
    const rb = await row(sb);
    expect(rb.attempts + rb.foreign_attempts).toBe(0);
    expect(await verifyLoginCode(DB, KEY, sb, E, cb, "stranger")).toBe(true);
  });

  it("a code from scope A is refused in scope B over HTTP, and spends nothing there", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(b.id, a.userId).run();
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const ca = await requestCode(e, a.origin, a.email, "203.0.113.70");
    expect(await verify(e, b.origin, a.email, ca.devCode!, "203.0.113.70")).toBe(401);
    expect(await verify(e, a.origin, a.email, ca.devCode!, "203.0.113.70")).toBe(200);
  });

  it("per-email verify keys are scoped by tenant", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const rl = fakeLimiter(1000);
    const e = { ...env, RL_AUTH: rl.binding };
    await verify(e, a.origin, a.email, "000000", "203.0.113.71");
    await verify(e, b.origin, a.email, "000000", "203.0.113.71");
    const keys = new Set(rl.seen.filter((k) => k.startsWith("verify:")));
    expect(keys.size).toBe(2);
  });
});

describe("adversarial verify: consume once", () => {
  it("a correct code works once over HTTP; replay from the same or another IP is refused", async () => {
    const a = await createTestTenant(env, SELF);
    const e = { ...env, RL_AUTH: fakeLimiter(1000).binding };
    const mine = await requestCode(e, a.origin, a.email, "203.0.113.80");
    expect(await verify(e, a.origin, a.email, mine.devCode!, "203.0.113.80")).toBe(200);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "203.0.113.80")).toBe(401);
    expect(await verify(e, a.origin, a.email, mine.devCode!, "198.51.100.80")).toBe(401);
  });

  it("a code consumed via the foreign path can not be replayed by its owner", async () => {
    const s = `adv-v-once-${uniq()}`;
    const y = await issueLoginCode(DB, KEY, s, E, "Y");
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Z")).toBe(true);
    expect(await verifyLoginCode(DB, KEY, s, E, y, "Y")).toBe(false);
    expect((await row(s)).consumed_at).not.toBeNull();
  });
});
