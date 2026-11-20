// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for per-requester sign-in code limits (spec L2).
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker } from "../src";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { ageOut } from "./otp-helpers";
import { createTestTenant } from "../src/testing";
import { notes } from "./worker";

const KEY = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const DB = (env as unknown as { DB: D1Database }).DB;
const uniq = () => crypto.randomUUID().slice(0, 8);

const post = (origin: string, path: string, body: unknown, ip?: string) =>
  SELF.fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(ip === undefined ? {} : { "CF-Connecting-IP": ip }) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
const request = async (origin: string, email: string, ip?: string) => {
  const res = await post(origin, "/api/auth/code/request", { email }, ip);
  return { status: res.status, body: await res.json<{ ok?: boolean; devCode?: string }>() };
};
const verify = async (origin: string, email: string, code: string, ip?: string) => (await post(origin, "/api/auth/code/verify", { email, code }, ip)).status;
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");

/** In-memory RL_AUTH stand-in: `limit` calls per key, records every key it sees. */
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
async function viaWorker(e: unknown, origin: string, path: string, body: unknown, ip?: string) {
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

describe("adversarial: lockout via one requester (HTTP)", () => {
  it("requester X exhausting its limit does not stop requester Y getting and using a code", async () => {
    const a = await createTestTenant(env, SELF);
    for (let i = 0; i < 5; i++) {
      expect((await request(a.origin, a.email, "198.51.100.1")).status).toBe(200);
      await ageOut(a.id);
    }
    expect((await request(a.origin, a.email, "198.51.100.1")).status).toBe(429);
    const y = await request(a.origin, a.email, "198.51.100.2");
    expect(y.status).toBe(200);
    expect(y.body.devCode).toMatch(/^\d{6}$/);
    expect(await verify(a.origin, a.email, y.body.devCode!, "198.51.100.2")).toBe(200);
  });

  it("X is limited at exactly 5 codes per 15 min", async () => {
    const a = await createTestTenant(env, SELF);
    for (let i = 0; i < 5; i++) {
      expect((await request(a.origin, a.email, "198.51.100.9")).status).toBe(200);
      await ageOut(a.id);
    }
    expect((await request(a.origin, a.email, "198.51.100.9")).status).toBe(429);
  });

  it("email case / whitespace variations do not give X a fresh per-requester budget", async () => {
    const a = await createTestTenant(env, SELF);
    const ip = "198.51.100.10";
    const variants = [a.email, a.email.toUpperCase(), ` ${a.email} `, a.email.replace(/^./, (c) => c.toUpperCase()), `${a.email}`, a.email.toUpperCase()];
    const statuses: number[] = [];
    for (const v of variants) {
      statuses.push((await request(a.origin, v, ip)).status);
      await ageOut(a.id);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("adversarial: supersede across requesters", () => {
  it("X's later code does not invalidate Y's code (HTTP)", async () => {
    const a = await createTestTenant(env, SELF);
    const y = await request(a.origin, a.email, "203.0.113.20");
    await ageOut(a.id);
    const x = await request(a.origin, a.email, "203.0.113.21");
    expect(x.body.devCode).toBeDefined();
    expect(await verify(a.origin, a.email, y.body.devCode!, "203.0.113.20")).toBe(200);
  });

  it("Y's own newer code still supersedes Y's older code", async () => {
    const s = `adv-sup-${uniq()}`;
    const { code: old } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    await ageOut(s);
    const { code: fresh } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    if (old !== fresh) expect(await verifyLoginCode(DB, KEY, s, "e@example.com", old, "Y")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", fresh, "Y")).toBe(true);
  });

  it("X's wrong guesses (with its own code) never spend Y's code attempts", async () => {
    const s = `adv-burn-${uniq()}`;
    const { code: y } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    await ageOut(s);
    const { code: x } = (await issueLoginCode(DB, KEY, s, "e@example.com", "X"))!;
    for (let i = 0; i < 10; i++) await verifyLoginCode(DB, KEY, s, "e@example.com", wrongOf(x === y ? wrongOf(x) : y), "X");
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", y, "Y")).toBe(true);
  });
});

describe("adversarial: fallback from a new address", () => {
  it("code requested from Y verifies from Z which never requested (HTTP)", async () => {
    const a = await createTestTenant(env, SELF);
    const y = await request(a.origin, a.email, "192.0.2.30");
    expect(await verify(a.origin, a.email, y.body.devCode!, "192.0.2.31")).toBe(200);
  });

  it("fallback never crosses scope", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(b.id, a.userId).run();
    const y = await request(a.origin, a.email, "192.0.2.40");
    expect(await verify(b.origin, a.email, y.body.devCode!, "192.0.2.41")).toBe(401);
    expect(await verify(b.origin, a.email, y.body.devCode!, "192.0.2.40")).toBe(401);
    expect(await verify(a.origin, a.email, y.body.devCode!, "192.0.2.41")).toBe(200);
  });

  it("guesses from requesters with no code hit the fallback code at most 3 times and never spend the owner's 5", async () => {
    const s = `adv-fb-${uniq()}`;
    const { code: y } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    for (let i = 0; i < 6; i++) await verifyLoginCode(DB, KEY, s, "e@example.com", wrongOf(y), `X${i}`);
    // Strangers' budget is spent: even the right code no longer works from a stranger.
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", y, "Z")).toBe(false);
    for (let i = 0; i < 4; i++) await verifyLoginCode(DB, KEY, s, "e@example.com", wrongOf(y), "Y");
    const row = await DB.prepare("SELECT attempts, foreign_attempts FROM login_codes WHERE scope = ?").bind(s).first<{ attempts: number; foreign_attempts: number }>();
    expect(row!.foreign_attempts).toBe(3);
    expect(row!.attempts).toBe(4);
    // The owner still has its fifth guess.
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", y, "Y")).toBe(true);
  });

  it("parallel guesses from rotating requesters never exceed 3 attempts on one code and leave the owner able to sign in", async () => {
    const s = `adv-par-${uniq()}`;
    const { code: y } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    await Promise.all(Array.from({ length: 30 }, (_, i) => verifyLoginCode(DB, KEY, s, "e@example.com", wrongOf(y), `rot${i}`)));
    const row = await DB.prepare("SELECT attempts, foreign_attempts FROM login_codes WHERE scope = ?").bind(s).first<{ attempts: number; foreign_attempts: number }>();
    expect(row!.foreign_attempts).toBe(3);
    expect(row!.attempts).toBe(0);
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", y, "Y")).toBe(true);
  });

  it("a correct code is consumed once even when verified in parallel from several requesters", async () => {
    const s = `adv-once-${uniq()}`;
    const { code: y } = (await issueLoginCode(DB, KEY, s, "e@example.com", "Y"))!;
    const results = await Promise.all(["Y", "Z", "W", "Y"].map((r) => verifyLoginCode(DB, KEY, s, "e@example.com", y, r)));
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("adversarial: overall per-email cap", () => {
  it("the per-address issuance cap is exactly 20: a 20th code is issued, then refused", async () => {
    const a = await createTestTenant(env, SELF);
    const t = Date.now();
    for (let i = 0; i < 19; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, ?)")
        .bind(`cap-${uniq()}-${i}`, a.email, a.id, t + 600_000, t - 120_000 - i * 30_000, `r${i}`).run();
    }
    const twentieth = await request(a.origin, a.email, "10.0.1.1");
    expect(twentieth.status).toBe(200);
    expect(twentieth.body.devCode).toMatch(/^\d{6}$/);
    const count = async () => (await DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE scope = ? AND email = ?").bind(a.id, a.email).first<{ n: number }>())!.n;
    expect(await count()).toBe(20);
    await ageOut(a.id);
    expect((await request(a.origin, a.email, "10.0.1.2")).status).toBe(429);
    expect(await count()).toBe(20);
  });

  it("parallel requests from many requesters do not overshoot the per-email cap", async () => {
    const s = `adv-cap-${uniq()}`;
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, ?)")
        .bind(`cap-${uniq()}-${i}`, "e@example.com", s, t + 600_000, t - 120_000 - i * 30_000, `r${i}`).run();
    }
    await Promise.allSettled(Array.from({ length: 40 }, (_, i) => issueLoginCode(DB, KEY, s, "e@example.com", `p${i}`)));
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE scope = ?").bind(s).first<{ n: number }>();
    expect(n!.n).toBe(20);
  });

  it("parallel requests from one requester do not overshoot the per-requester limit", async () => {
    const s = `adv-capr-${uniq()}`;
    for (let i = 0; i < 5; i++) {
      await issueLoginCode(DB, KEY, s, "e@example.com", "one");
      await ageOut(s);
    }
    await Promise.allSettled(Array.from({ length: 15 }, () => issueLoginCode(DB, KEY, s, "e@example.com", "one")));
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE scope = ?").bind(s).first<{ n: number }>();
    expect(n!.n).toBe(5);
  });

  it("codes older than the 15-minute window no longer count", async () => {
    const s = `adv-win-${uniq()}`;
    for (let i = 0; i < 5; i++) {
      await issueLoginCode(DB, KEY, s, "e@example.com", "X");
      await ageOut(s);
    }
    await DB.prepare("UPDATE login_codes SET created_at = created_at - 16 * 60000 WHERE scope = ?").bind(s).run();
    await expect(issueLoginCode(DB, KEY, s, "e@example.com", "X").then((r) => r?.code)).resolves.toMatch(/^\d{6}$/);
  });
});

describe("adversarial: scope isolation", () => {
  it("exhausting limits on tenant A leaves the same email on tenant B unaffected (HTTP)", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(b.id, a.userId).run();
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, ?)")
        .bind(`iso-${uniq()}-${i}`, a.email, a.id, t + 600_000, t - 120_000 - i * 30_000, `r${i}`).run();
    }
    expect((await request(a.origin, a.email, "172.16.1.1")).status).toBe(429);
    const r = await request(b.origin, a.email, "172.16.0.1");
    expect(r.status).toBe(200);
    expect(await verify(b.origin, a.email, r.body.devCode!, "172.16.0.1")).toBe(200);
  });

  it("requester's own code in scope B is not used for verification in scope A", async () => {
    const sa = `adv-sa-${uniq()}`;
    const sb = `adv-sb-${uniq()}`;
    const { code: ca } = (await issueLoginCode(DB, KEY, sa, "e@example.com", "Y"))!;
    const { code: cb } = (await issueLoginCode(DB, KEY, sb, "e@example.com", "Y"))!;
    if (ca !== cb) expect(await verifyLoginCode(DB, KEY, sa, "e@example.com", cb, "Y")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, sa, "e@example.com", ca, "Y")).toBe(true);
  });
});

describe("adversarial: missing client address", () => {
  it("no CF-Connecting-IP is treated as requester 'unknown': limited, no crash, codes still verify", async () => {
    const a = await createTestTenant(env, SELF);
    const first = await request(a.origin, a.email);
    expect(first.status).toBe(200);
    expect(await verify(a.origin, a.email, first.body.devCode!)).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await request(a.origin, a.email)).status).toBe(200);
      await ageOut(a.id);
    }
    expect((await request(a.origin, a.email)).status).toBe(429);
    // A real address is a different requester.
    expect((await request(a.origin, a.email, "198.51.100.77")).status).toBe(200);
  });

  it("production still fails closed without RL_AUTH", async () => {
    const a = await createTestTenant(env, SELF);
    const res = await viaWorker({ ...env, ENVIRONMENT: "production" }, a.origin, "/api/auth/code/request", { email: a.email });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await DB.prepare("SELECT 1 FROM login_codes WHERE scope = ?").bind(a.id).first()).toBeNull();
  });
});

describe("adversarial: RL_AUTH key order and scoping", () => {
  it("X flooding to RL 429 never spends a key Y needs; Y still gets a code", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(3);
    const e = { ...env, RL_AUTH: rl.binding };
    let status = 0;
    for (let i = 0; i < 10 && status !== 429; i++) status = (await viaWorker(e, a.origin, "/api/auth/code/request", { email: a.email }, "198.51.100.50")).status;
    expect(status).toBe(429);
    // Every key X touched names X's address.
    for (const k of rl.seen) expect(k).toContain("198.51.100.50");
    const before = rl.seen.length;
    await ageOut(a.id);
    const res = await viaWorker(e, a.origin, "/api/auth/code/request", { email: a.email }, "198.51.100.51");
    expect(res.status).toBe(200);
    expect((await res.json<{ devCode?: string }>()).devCode).toMatch(/^\d{6}$/);
    expect(rl.seen.slice(before).every((k) => k.includes("198.51.100.51"))).toBe(true);
  });

  it("per-IP key is checked before the per-email key", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(100);
    await viaWorker({ ...env, RL_AUTH: rl.binding }, a.origin, "/api/auth/code/request", { email: a.email }, "198.51.100.60");
    const ipIdx = rl.seen.findIndex((k) => k.startsWith("code-ip:"));
    const emailIdx = rl.seen.findIndex((k) => k.startsWith("code:") && k.includes(a.email));
    expect(ipIdx).toBeGreaterThanOrEqual(0);
    expect(emailIdx).toBeGreaterThan(ipIdx);
  });

  it("an RL 429 for X issues no code (refusal happens before work)", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(0);
    const res = await viaWorker({ ...env, RL_AUTH: rl.binding }, a.origin, "/api/auth/code/request", { email: a.email }, "198.51.100.70");
    expect(res.status).toBe(429);
    expect(await DB.prepare("SELECT 1 FROM login_codes WHERE scope = ?").bind(a.id).first()).toBeNull();
  });
});

describe("adversarial: enumeration safety", () => {
  it("eligible and ineligible addresses answer identically in production, including past the code limit", async () => {
    const a = await createTestTenant(env, SELF);
    const rl = fakeLimiter(1000);
    const e = { ...env, ENVIRONMENT: "production", RL_AUTH: rl.binding };
    for (let i = 0; i < 7; i++) {
      const r1 = await viaWorker(e, a.origin, "/api/auth/code/request", { email: a.email }, "198.51.100.80");
      const r2 = await viaWorker(e, a.origin, "/api/auth/code/request", { email: "nobody@example.com" }, "198.51.100.80");
      expect([r1.status, await r1.text()]).toEqual([r2.status, await r2.text()]);
      expect(r1.status).toBe(200);
    }
  });
});

describe("adversarial: legacy rows and storage", () => {
  it("a pre-migration row with NULL requester still verifies (from any address)", async () => {
    const s = `adv-legacy-${uniq()}`;
    const { code } = (await issueLoginCode(DB, KEY, s, "e@example.com", "tmp"))!;
    await DB.prepare("UPDATE login_codes SET requester = NULL WHERE scope = ?").bind(s).run();
    expect(await verifyLoginCode(DB, KEY, s, "e@example.com", code, "anyone")).toBe(true);
  });

  it("NULL-requester rows count toward the per-email cap but not toward any requester's limit", async () => {
    const s = `adv-legacy2-${uniq()}`;
    const t = Date.now();
    for (let i = 0; i < 5; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, NULL)")
        .bind(`nul-${uniq()}-${i}`, "e@example.com", s, t + 600_000, t - 120_000 - i * 30_000).run();
    }
    const sixth = await issueLoginCode(DB, KEY, s, "e@example.com", "X");
    expect(sixth?.code).toMatch(/^\d{6}$/);
    await ageOut(s);
    for (let i = 0; i < 14; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, ?)")
        .bind(`nul2-${uniq()}-${i}`, "e@example.com", s, t + 600_000, t - 120_000 - i * 30_000, `q${i}`).run();
    }
    await expect(issueLoginCode(DB, KEY, s, "e@example.com", "new")).rejects.toThrow(/Too many/);
  });

  it("the requester column never stores the raw client address", async () => {
    const a = await createTestTenant(env, SELF);
    await request(a.origin, a.email, "198.51.100.99");
    const row = await DB.prepare("SELECT requester FROM login_codes WHERE scope = ?").bind(a.id).first<{ requester: string }>();
    expect(row!.requester).toBeTruthy();
    expect(row!.requester).not.toContain("198.51.100.99");
  });
});
