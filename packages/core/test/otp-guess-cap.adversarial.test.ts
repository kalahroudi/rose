// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the per-address sign-in code guess cap (spec L4: 10 guesses per (scope, email) per 70 min).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueLoginCode, SEND_GAP_MS, verifyLoginCode, verifyLoginKey } from "../src/control/otp";

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
const gap = () => at(clock + SEND_GAP_MS + 1);

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
    const { code } = (await issueLoginCode(DB, KEY, scope, email, `${prefix}${i}`))!;
    codes.push(code);
    for (let g = 0; g < 5; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(code), `${prefix}${i}`);
    }
    gap();
  }
  return codes;
}

describe("adversarial guess cap", () => {
  afterEach(() => vi.useRealTimers());
  const setup = (start = BASE) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(start);
  };

  it("parallel verifies from many requesters across several live codes never count more than 10 guesses", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "p@example.com";
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await issueLoginCode(DB, KEY, scope, email, `q${i}`))!.code);
      gap();
    }
    step();
    await Promise.all([
      ...codes.flatMap((c, i) => Array.from({ length: 5 }, () => verifyLoginCode(DB, KEY, scope, email, wrongOf(c), `q${i}`))),
      ...Array.from({ length: 20 }, (_, i) => verifyLoginCode(DB, KEY, scope, email, wrongOf(codes[2]!), `s${i}`)),
    ]);
    expect(await total(scope, email)).toBeLessThanOrEqual(10);
  });

  it("parallel correct-code attempts at 9 spend at most one guess and the cap holds", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "p@example.com";
    await burn(scope, email, 1); // 5
    const { code: last } = (await issueLoginCode(DB, KEY, scope, email, "last"))!;
    for (let g = 0; g < 4; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    }
    expect(await total(scope, email)).toBe(9);
    step();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => verifyLoginCode(DB, KEY, scope, email, i === 0 ? last : wrongOf(last), i % 2 ? "last" : `z${i}`)));
    expect(await total(scope, email)).toBe(10);
    expect(res.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it("one verify at total 9 with two candidates (own + foreign) spends exactly one guess", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "d@example.com";
    // 1 spent row from another requester: 5 + 3 = 8 counted guesses.
    await DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester, attempts, foreign_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 5, 3)")
      .bind(`raw-${uniq()}`, email, scope, "x", clock - 5 * MIN + 10 * MIN, clock - 5 * MIN, "raw0").run();
    const { code: mine } = (await issueLoginCode(DB, KEY, scope, email, "x"))!;
    gap();
    const { code: newest } = (await issueLoginCode(DB, KEY, scope, email, "n"))!;
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(newest), "n"); // 9
    expect(await total(scope, email)).toBe(9);
    step();
    expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(mine), "x")).toBe(false);
    expect(await total(scope, email)).toBe(10);
  });

  it("at the cap nothing is incremented on any row, for owners or strangers, right or wrong code", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "c@example.com";
    await burn(scope, email, 1); // 5
    const { code: last } = (await issueLoginCode(DB, KEY, scope, email, "last"))!;
    for (let g = 0; g < 4; g++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    }
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "s0"); // 10
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
    await burn(scope, email, 1); // 5
    const { code: last } = (await issueLoginCode(DB, KEY, scope, email, "last"))!;
    for (let i = 0; i < 3; i++) {
      step();
      await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), `s${i}`); // 3 foreign
    }
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last");
    step();
    await verifyLoginCode(DB, KEY, scope, email, wrongOf(last), "last"); // 10
    expect(await total(scope, email)).toBe(10);
    step();
    expect(await verifyLoginCode(DB, KEY, scope, email, last, "last")).toBe(false);
  });

  it("cap is per (scope, email): another scope or another address is unaffected", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const other = `gc-${uniq()}`;
    const email = "i@example.com";
    await burn(scope, email, 2); // 10
    expect(await total(scope, email)).toBe(10);
    const { code: c1 } = (await issueLoginCode(DB, KEY, other, email, "r0"))!;
    step();
    expect(await verifyLoginCode(DB, KEY, other, email, c1, "r0")).toBe(true);
    const { code: c2 } = (await issueLoginCode(DB, KEY, scope, "j@example.com", "r0"))!;
    step();
    expect(await verifyLoginCode(DB, KEY, scope, "j@example.com", c2, "r0")).toBe(true);
  });

  it("guesses on a code created exactly 70 minutes ago do not count; 1 ms younger still counts", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "w@example.com";
    await burn(scope, email, 2); // 10, codes created a gap apart
    const newestCreated = (await DB.prepare("SELECT MAX(created_at) AS t FROM login_codes WHERE scope = ?").bind(scope).first<{ t: number }>())!.t;
    const oldestCreated = (await DB.prepare("SELECT MIN(created_at) AS t FROM login_codes WHERE scope = ?").bind(scope).first<{ t: number }>())!.t;
    at(oldestCreated + 70 * MIN - 1);
    const { code: fresh } = (await issueLoginCode(DB, KEY, scope, email, "late"))!;
    expect(await verifyLoginCode(DB, KEY, scope, email, fresh, "late")).toBe(false);
    at(oldestCreated + 70 * MIN);
    expect(await verifyLoginCode(DB, KEY, scope, email, fresh, "late")).toBe(true);
    at(oldestCreated + 70 * MIN + SEND_GAP_MS + 1);
    const { code: fresh2 } = (await issueLoginCode(DB, KEY, scope, email, "late2"))!;
    expect(await verifyLoginCode(DB, KEY, scope, email, fresh2, "late2")).toBe(true);
    expect(newestCreated).toBeGreaterThan(oldestCreated);
  });

  it("sliding span: 10 guesses late in one code's life block new codes 60 min later, and free up after 70 min", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "s@example.com";
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) {
      codes.push((await issueLoginCode(DB, KEY, scope, email, `r${i}`))!.code);
      gap();
    }
    const created = clock;
    await DB.prepare("UPDATE login_codes SET created_at = ?, expires_at = ? WHERE scope = ?").bind(created, created + 10 * MIN, scope).run();
    at(created + 10 * MIN - 5);
    for (let i = 0; i < 2; i++) for (let g = 0; g < 5; g++) await verifyLoginCode(DB, KEY, scope, email, wrongOf(codes[i]!), `r${i}`);
    expect(await total(scope, email)).toBe(10);
    at(created + 60 * MIN);
    const { code: n } = (await issueLoginCode(DB, KEY, scope, email, "new"))!;
    expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(n), "new")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, scope, email, n, "new")).toBe(false);
    expect(await total(scope, email)).toBe(10);
    at(created + 70 * MIN + 1);
    const { code: n2 } = (await issueLoginCode(DB, KEY, scope, email, "new2"))!;
    expect(await verifyLoginCode(DB, KEY, scope, email, n2, "new2")).toBe(true);
  });

  it("in any 60-minute span no more than 10 guesses are counted, even when rotating windows", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "t@example.com";
    const log: number[] = [];
    let req = 0;
    for (let tick = 0; tick < 8; tick++) {
      at(BASE + tick * 10 * MIN);
      for (let i = 0; i < 2; i++) {
        const who = `w${req++}`;
        let c: string;
        try {
          c = (await issueLoginCode(DB, KEY, scope, email, who))!.code;
        } catch {
          continue;
        }
        for (let g = 0; g < 5; g++) {
          const before = await total(scope, email);
          await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), who);
          if ((await total(scope, email)) > before) log.push(clock);
          step();
        }
        gap();
      }
    }
    for (const s of log) expect(log.filter((x) => x >= s && x < s + 60 * MIN).length).toBeLessThanOrEqual(10);
  });

  it("owner recovery: a new code issued after the typed cap is exhausted signs in via its key", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "l@example.com";
    const { code: initial } = (await issueLoginCode(DB, KEY, scope, email, "owner"))!;
    expect(initial).toMatch(/^\d{6}$/);
    gap();
    for (let i = 0; i < 2; i++) {
      const { code: c } = (await issueLoginCode(DB, KEY, scope, email, "evil"))!;
      for (let g = 0; g < 5; g++) {
        step();
        await verifyLoginCode(DB, KEY, scope, email, wrongOf(c), "evil");
      }
      gap();
    }
    expect(await total(scope, email)).toBe(10);
    const { code: real, key } = (await issueLoginCode(DB, KEY, scope, email, "owner"))!;
    expect(real).toMatch(/^\d{6}$/);
    expect(await verifyLoginCode(DB, KEY, scope, email, real, "owner")).toBe(false);
    expect(await verifyLoginKey(DB, KEY, scope, email, key)).toBe(true);
  });

  it("legitimate owner: request, a few typos, sign in; then repeat once in the window", async () => {
    setup();
    const scope = `gc-${uniq()}`;
    const email = "o@example.com";
    for (let r = 0; r < 2; r++) {
      step();
      const { code } = (await issueLoginCode(DB, KEY, scope, email, "owner"))!;
      for (let g = 0; g < 3; g++) {
        step();
        expect(await verifyLoginCode(DB, KEY, scope, email, wrongOf(code), "owner")).toBe(false);
      }
      step();
      expect(await verifyLoginCode(DB, KEY, scope, email, code, "owner")).toBe(true);
    }
  });
});
