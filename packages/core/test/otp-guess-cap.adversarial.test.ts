// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the per-address sign-in code guess cap (spec L4: 100 guesses per (scope, email) per 25 min).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";

const KEY = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const DB = (env as unknown as { DB: D1Database }).DB;
const uniq = () => crypto.randomUUID().slice(0, 8);
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
const MIN = 60_000;
const BASE = 1_900_000_000_000;

let clock = BASE;
const at = (t: number) => {
  clock = t;
  vi.setSystemTime(t);
};
const step = () => at(clock + 1);

const total = async (scope: string, email: string) =>
  (await DB.prepare("SELECT COALESCE(SUM(attempts + foreign_attempts), 0) AS n FROM login_codes WHERE scope = ? AND email = ?")
    .bind(scope, email)
    .first<{ n: number }>())!.n;
const rows = async (scope: string, email: string) =>
  (await DB.prepare("SELECT id, attempts, foreign_attempts FROM login_codes WHERE scope = ? AND email = ? ORDER BY rowid")
    .bind(scope, email)
    .all<{ id: string; attempts: number; foreign_attempts: number }>()).results;

/** n requesters each issue one code and spend all 5 owner guesses on it (5n guesses). Returns the codes. */
async function burn(scope: string, email: string, n: number, prefix = "r") {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    step();
    const c = await issueLoginCode(DB, KEY, scope, email, `${prefix}${i}`);
    codes.push(c);
    for (let g = 0; g < 5; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), `${prefix}${i}`);
    }
  }
  return codes;
}

describe("adversarial guess cap", () => {
  afterEach(() => vi.useRealTimers());
  const setup = (start = BASE) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(start);
  };

  it("parallel verifies from many requesters across 20 live codes never count more than 100 guesses", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "p@example.com";
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      step();
      codes.push(await issueLoginCode(DB, KEY, scope, email, `q${i}`));
    }
    step();
    // Each owner fires its 5 guesses in parallel, plus 60 strangers on the newest code, all at once.
    await Promise.all([
      ...codes.flatMap((c, i) => Array.from({ length: 5 }, () => verifyLoginCode(DB, KEY, scope, email, wrongOf(c), `q${i}`))),
      ...Array.from({ length: 60 }, (_, i) => verifyLoginCode(DB, KEY, scope, email, wrongOf(codes[19]!), `s${i}`)),
    ]);
    expect(await total(scope, email)).toBeLessThanOrEqual(100);
  });

  it("parallel correct-code attempts at 99 spend at most one guess and the cap holds", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "p@example.com";
    await burn(scope, email, 19); // 95
    step();
    const last = await issueLoginCode(DB, KEY, scope, email, "last");
    for (let g = 0; g < 4; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    }
    expect(await total(scope, email)).toBe(99);
    step();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => verifyLoginCode(DB, KEY, scope, email, i === 0 ? last : wrongOf(last), i % 2 ? "last" : `z${i}`)));
    expect(await total(scope, email)).toBe(100);
    expect(res.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it("one verify at total 99 with two candidates (own + foreign) spends exactly one guess", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "d@example.com";
    // 12 spent rows from other requesters: 12 * (5 + 3) = 96 counted guesses.
    for (let i = 0; i < 12; i++) {
      await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester, attempts, foreign_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 5, 3)")
        .bind(`raw-${uniq()}-${i}`, email, scope, "x", clock + 10 * MIN, clock, `raw${i}`).run();
      step();
    }
    const mine = await issueLoginCode(DB, KEY, scope, email, "x");
    step();
    const newest = await issueLoginCode(DB, KEY, scope, email, "n");
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(newest), "n"); // 97
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(mine), "x"); // own + foreign: 99
    expect(await total(scope, email)).toBe(99);
    step();
    expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(mine), "x")).toBe(false);
    expect(await total(scope, email)).toBe(100);
  });

  it("at the cap nothing is incremented on any row, for owners or strangers, right or wrong code", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "c@example.com";
    await burn(scope, email, 19); // 95
    step();
    const last = await issueLoginCode(DB, KEY, scope, email, "last");
    for (let g = 0; g < 4; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    }
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "s0"); // 100
    const before = await rows(scope, email);
    for (let i = 0; i < 30; i++) {
      step();
      expect(await verifyLoginCode(DB, KEY, scope, email, i % 2 ? last : wrongOf(last), i % 3 ? "last" : `s${i}`)).toBe(false);
    }
    expect(await rows(scope, email)).toEqual(before);
  });

  it("the cap applies with the right code from the owner (no bypass via the match path)", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "m@example.com";
    await burn(scope, email, 19); // 95
    step();
    const last = await issueLoginCode(DB, KEY, scope, email, "last");
    for (let i = 0; i < 5; i++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), `s${i}`); // 3 foreign then refused
    }
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last"); // 100
    expect(await total(scope, email)).toBe(100);
    step();
    expect(await verifyLoginCode(DB, KEY, scope, email, last, "last")).toBe(false);
  });

  it("cap is per (scope, email): another scope or another address is unaffected", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const other = `gc-${uniq()}`;
    const email = "i@example.com";
    await burn(scope, email, 20); // 100
    expect(await total(scope, email)).toBe(100);
    step();
    const c1 = await issueLoginCode(DB, KEY, other, email, "r0");
    step();
    expect(await verifyLoginCode(DB, KEY, other, email, c1, "r0")).toBe(true);
    step();
    const c2 = await issueLoginCode(DB, KEY, scope, "j@example.com", "r0");
    step();
    expect(await verifyLoginCode(DB, KEY, scope, "j@example.com", c2, "r0")).toBe(true);
  });

  it("guesses on a code created exactly 25 minutes ago do not count; 1 ms younger still counts", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "w@example.com";
    await burn(scope, email, 20); // 100, codes created at BASE+1.. ; last code created at c20
    const newestCreated = (await DB.prepare("SELECT MAX(created_at) AS t FROM login_codes WHERE scope = ?").bind(scope).first<{ t: number }>())!.t;
    const oldestCreated = (await DB.prepare("SELECT MIN(created_at) AS t FROM login_codes WHERE scope = ?").bind(scope).first<{ t: number }>())!.t;
    // Just before the newest burned code leaves the window, a fresh code is still blocked (all 100 count until the oldest leaves; once it does, 5 free).
    at(oldestCreated + 25 * MIN - 1);
    const fresh = await issueLoginCode(DB, KEY, scope, email, "late");
    expect(await verifyLoginCode(DB, KEY, scope, email, fresh, "late")).toBe(false);
    // Exactly at created_at + 25 min the oldest code (5 guesses) drops out.
    at(oldestCreated + 25 * MIN);
    const fresh2 = await issueLoginCode(DB, KEY, scope, email, "late2");
    expect(await verifyLoginCode(DB, KEY, scope, email, fresh2, "late2")).toBe(true);
    expect(newestCreated).toBeGreaterThan(oldestCreated);
  });

  it("sliding span: 100 guesses late in one code's life block new codes 15 min later, and free up after 25 min", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "s@example.com";
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) codes.push(await issueLoginCode(DB, KEY, scope, email, `r${i}`));
    const created = clock;
    // All guesses at the end of the codes' lifetime.
    at(created + 10 * MIN - 5);
    for (let i = 0; i < 20; i++) for (let g = 0; g < 5; g++) await verifyLoginCode(DB, KEY, scope, email, wrongOf(codes[i]!), `r${i}`);
    expect(await total(scope, email)).toBe(100);
    // 15 min after the guess burst, new codes can be issued (issuance window passed) but guesses must still be capped:
    // otherwise >100 guesses would land in [created+10, created+25).
    at(created + 24 * MIN);
    const n = await issueLoginCode(DB, KEY, scope, email, "new");
    expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(n), "new")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, scope, email, n, "new")).toBe(false);
    expect(await total(scope, email)).toBe(100);
    at(created + 25 * MIN + 1);
    const n2 = await issueLoginCode(DB, KEY, scope, email, "new2");
    expect(await verifyLoginCode(DB, KEY, scope, email, n2, "new2")).toBe(true);
  });

  it("in any 15-minute span no more than 100 guesses are counted, even when rotating windows", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "t@example.com";
    const log: number[] = []; // times of spent guesses
    let req = 0;
    // Every 5 minutes for an hour, 20 fresh requesters try to issue and spend 5 guesses each.
    for (let tick = 0; tick < 12; tick++) {
      at(BASE + tick * 5 * MIN);
      for (let i = 0; i < 20; i++) {
        const who = `w${req++}`;
        let c: string;
        try {
          c = await issueLoginCode(DB, KEY, scope, email, who);
        } catch {
          continue;
        }
        for (let g = 0; g < 5; g++) {
          step();
          const before = await total(scope, email);
          await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), who);
          if ((await total(scope, email)) > before) log.push(clock);
        }
      }
    }
    for (const s of log) expect(log.filter((t) => t >= s && t < s + 15 * MIN).length).toBeLessThanOrEqual(100);
  });

  it("one requester alone can not reach the cap within 25 minutes and the real owner still signs in", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "l@example.com";
    step();
    const real = await issueLoginCode(DB, KEY, scope, email, "owner");
    // Attacker uses one requester: max 5 codes per 15 min, 5 guesses each, plus foreign guesses.
    for (let round = 0; round < 2; round++) {
      if (round) at(clock + 15 * MIN + 1);
      for (let i = 0; i < 10; i++) {
        step();
        let c: string;
        try {
          c = await issueLoginCode(DB, KEY, scope, email, "evil");
        } catch {
          c = "123456";
        }
        for (let g = 0; g < 6; g++) {
          step();
          await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), "evil");
        }
      }
    }
    expect(await total(scope, email)).toBeLessThan(100);
    step();
    const again = await issueLoginCode(DB, KEY, scope, email, "owner");
    step();
    expect(await verifyLoginCode(DB, KEY, scope, email, again, "owner")).toBe(true);
    expect(real).toMatch(/^\d{6}$/);
  });

  it("legitimate owner: request, a few typos, sign in; then repeat a few times in the window", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "o@example.com";
    for (let r = 0; r < 5; r++) {
      step();
      const c = await issueLoginCode(DB, KEY, scope, email, "owner");
      for (let g = 0; g < 3; g++) {
        step();
        expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), "owner")).toBe(false);
      }
      step();
      expect(await verifyLoginCode(DB, KEY, scope, email, c, "owner")).toBe(true);
    }
  });
});
