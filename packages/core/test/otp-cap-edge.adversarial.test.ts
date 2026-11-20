// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for spec L7: at the per-address guess cap edge, the last guess goes to the matching
// candidate, a wrong guess is never free, and parallel verifies never exceed the address/per-code budgets.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { ageOut } from "./otp-helpers";

const KEY = (env as unknown as { ROSE_MASTER_KEY: string }).ROSE_MASTER_KEY;
const DB = (env as unknown as { DB: D1Database }).DB;
const uniq = () => crypto.randomUUID().slice(0, 8);

type R = { id: string; attempts: number; foreign_attempts: number; consumed_at: number | null };
const total = async (scope: string, email: string) =>
  (await DB.prepare("SELECT COALESCE(SUM(attempts + foreign_attempts), 0) AS n FROM login_codes WHERE scope = ? AND email = ?")
    .bind(scope, email)
    .first<{ n: number }>())!.n;
const rows = async (scope: string, email: string) =>
  (await DB.prepare("SELECT id, attempts, foreign_attempts, consumed_at FROM login_codes WHERE scope = ? AND email = ? AND id NOT LIKE 'fill-%' ORDER BY rowid")
    .bind(scope, email)
    .all<R>()).results;

/**
 * r0 has an open own code; "other" has the newer (newest) code for the address. A filler row (older,
 * consumed, inside the guess window) brings the counted total to `target`.
 */
async function edge(target: number, ownAttempts = 0, foreignOnNewest = 0) {
  const scope = `ce-${uniq()}`;
  const email = "edge@example.com";
  const { code: own } = (await issueLoginCode(DB, KEY, scope, email, "r0"))!;
  await ageOut(scope);
  const { code: newest } = (await issueLoginCode(DB, KEY, scope, email, "other"))!;
  const [ownRow, newRow] = await rows(scope, email);
  await DB.prepare("UPDATE login_codes SET attempts = ? WHERE id = ?").bind(ownAttempts, ownRow!.id).run();
  await DB.prepare("UPDATE login_codes SET foreign_attempts = ? WHERE id = ?").bind(foreignOnNewest, newRow!.id).run();
  const t = Date.now() - 60_000;
  const fill = target - ownAttempts - foreignOnNewest;
  if (fill > 0) {
    await DB.prepare(
      "INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester, attempts, foreign_attempts, consumed_at) VALUES (?, ?, ?, 'x', ?, ?, 'filler', ?, 0, ?)",
    ).bind(`fill-${uniq()}`, email, scope, t + 600_000, t, fill, t).run();
  }
  expect(await total(scope, email)).toBe(target);
  return { scope, email, own, newest, ownId: ownRow!.id, newId: newRow!.id };
}

describe("L7 cap edge: the last guess goes to the matching candidate", () => {
  it("at 9, the correct newest (foreign) code verifies and the own code's budget is untouched", async () => {
    const e = await edge(9, 2);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "r0")).toBe(true);
    expect(await total(e.scope, e.email)).toBe(10);
    const [o, n] = await rows(e.scope, e.email);
    expect(o!.attempts).toBe(2);
    expect(n!.foreign_attempts).toBe(1);
    expect(n!.consumed_at).not.toBeNull();
    expect(o!.consumed_at).toBeNull();
  });

  it("at 9, the requester's own correct code also verifies when a newer foreign code exists", async () => {
    const e = await edge(9, 1);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.own, "r0")).toBe(true);
    expect(await total(e.scope, e.email)).toBe(10);
    const [o, n] = await rows(e.scope, e.email);
    expect(o!.consumed_at).not.toBeNull();
    expect(n!.foreign_attempts).toBe(0);
  });

  it("at 9, a wrong guess spends exactly the last guess (not free) and then even the correct code is refused", async () => {
    const e = await edge(9, 0);
    const bad = ["000000", "111111", "222222"].find((c) => c !== e.own && c !== e.newest)!;
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, bad, "r0")).toBe(false);
    expect(await total(e.scope, e.email)).toBe(10);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "r0")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.own, "r0")).toBe(false);
    expect(await total(e.scope, e.email)).toBe(10);
  });

  it("at 8 with two candidates a wrong guess spends on both (no free comparisons) and reaches the cap", async () => {
    const e = await edge(8, 0);
    const bad = ["000000", "111111", "222222"].find((c) => c !== e.own && c !== e.newest)!;
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, bad, "r0")).toBe(false);
    expect(await total(e.scope, e.email)).toBe(10);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "r0")).toBe(false);
  });

  it("at 10 the correct code is refused and nothing is spent or consumed", async () => {
    const e = await edge(10, 1);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "r0")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.own, "r0")).toBe(false);
    expect(await total(e.scope, e.email)).toBe(10);
    for (const r of await rows(e.scope, e.email)) expect(r.consumed_at).toBeNull();
  });

  it("a code accepted at the edge is single-use", async () => {
    const e = await edge(8, 0);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "other")).toBe(true);
    expect(await total(e.scope, e.email)).toBe(9);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "s0")).toBe(false);
    expect(await total(e.scope, e.email)).toBe(9);
  });

  it("an exhausted foreign budget on the newest code is not bypassed by the match-first ordering", async () => {
    const e = await edge(8, 0, 3);
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "r0")).toBe(false);
    const [, n] = await rows(e.scope, e.email);
    expect(n!.foreign_attempts).toBe(3);
    expect(n!.consumed_at).toBeNull();
    expect(await verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, "other")).toBe(true);
  });
});

describe("L7 cap edge: parallel verifies", () => {
  it("parallel correct and wrong guesses at 9 never exceed 10 and accept at most once", async () => {
    const e = await edge(9, 0);
    const bad = ["000000", "111111", "222222"].find((c) => c !== e.own && c !== e.newest)!;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => verifyLoginCode(DB, KEY, e.scope, e.email, i % 2 ? e.newest : bad, i % 3 ? "r0" : `p${i}`)),
    );
    expect(await total(e.scope, e.email)).toBeLessThanOrEqual(10);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it("parallel correct guesses from many strangers at 5 stay within the address and foreign budgets", async () => {
    const e = await edge(5, 0);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => verifyLoginCode(DB, KEY, e.scope, e.email, e.newest, `s${i}`)));
    expect(await total(e.scope, e.email)).toBeLessThanOrEqual(10);
    const [, n] = await rows(e.scope, e.email);
    expect(n!.foreign_attempts).toBeLessThanOrEqual(3);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it("parallel wrong guesses by the owner never exceed the 5-attempt per-code budget", async () => {
    const e = await edge(0, 0);
    const bad = ["000000", "111111", "222222"].find((c) => c !== e.own && c !== e.newest)!;
    await Promise.all(Array.from({ length: 12 }, () => verifyLoginCode(DB, KEY, e.scope, e.email, bad, "r0")));
    const [o, n] = await rows(e.scope, e.email);
    expect(o!.attempts).toBeLessThanOrEqual(5);
    expect(n!.foreign_attempts).toBeLessThanOrEqual(3);
    expect(n!.attempts).toBe(0);
  });
});
