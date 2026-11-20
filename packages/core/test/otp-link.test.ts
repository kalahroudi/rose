// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestTenant } from "../src/testing";
import { formatKey, issueLoginCode, normalizeKey, SEND_GAP_MS, verifyLoginCode, verifyLoginKey } from "../src/control/otp";
import { ageOut } from "./otp-helpers";

const KEY = env.ROSE_MASTER_KEY;
const DB = env.DB;
const uniq = () => crypto.randomUUID().slice(0, 8);
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
const total = async (scope: string, email: string) =>
  (await DB.prepare("SELECT COALESCE(SUM(attempts + foreign_attempts), 0) AS n FROM login_codes WHERE scope = ? AND email = ?").bind(scope, email).first<{ n: number }>())!.n;

const post = (origin: string, path: string, body: unknown, ip?: string) =>
  SELF.fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(ip === undefined ? {} : { "CF-Connecting-IP": ip }) },
    body: JSON.stringify(body),
    redirect: "manual",
  });

const strip = (j: unknown): unknown => JSON.parse(JSON.stringify(j).replace(/"requestId":"[^"]*"/, '"requestId":"-"'));
const codeFor = async (origin: string, email: string, ip: string) => {
  const res = await post(origin, "/api/auth/code/request", { email }, ip);
  return { status: res.status, body: await res.json<{ devCode?: string; devKey?: string }>() };
};
const link = (origin: string, email: string, key: string, ip: string) => post(origin, "/api/auth/code/link", { email, key }, ip);

describe("sign-in key", () => {
  it("a key from any mail signs in after 10 rotating typed guesses exhaust the cap", async () => {
    const scope = `lk-${uniq()}`;
    const email = "k@example.com";
    const { code: c0, key: k0 } = (await issueLoginCode(DB, KEY, scope, email, "r0"))!;
    for (let g = 0; g < 5; g++) await verifyLoginCode(DB, KEY, scope, email, wrongOf(c0), "r0");
    await ageOut(scope);
    const { code: c1 } = (await issueLoginCode(DB, KEY, scope, email, "r1"))!;
    for (let g = 0; g < 5; g++) await verifyLoginCode(DB, KEY, scope, email, wrongOf(c1), "r1");
    expect(await total(scope, email)).toBe(10);
    expect(await verifyLoginCode(DB, KEY, scope, email, c0, "r0")).toBe(false);
    expect(await verifyLoginCode(DB, KEY, scope, email, c1, "r1")).toBe(false);
    expect(await verifyLoginKey(DB, KEY, scope, email, k0)).toBe(true);
    expect(await verifyLoginKey(DB, KEY, scope, email, k0)).toBe(false);
  });

  it("20 parallel guesses never exceed 10", async () => {
    const scope = `lk-${uniq()}`;
    const email = "c@example.com";
    const { code: c0 } = (await issueLoginCode(DB, KEY, scope, email, "r0"))!;
    await ageOut(scope);
    const { code: c1 } = (await issueLoginCode(DB, KEY, scope, email, "r1"))!;
    await Promise.all(Array.from({ length: 20 }, (_, i) => verifyLoginCode(DB, KEY, scope, email, wrongOf(i % 2 ? c1 : c0), `p${i}`)));
    expect(await total(scope, email)).toBeLessThanOrEqual(10);
  });

  it("two simultaneous issueLoginCode calls issue exactly one code", async () => {
    const scope = `lk-${uniq()}`;
    const email = "x@example.com";
    const [a, b] = await Promise.all([
      issueLoginCode(DB, KEY, scope, email, "r0"),
      issueLoginCode(DB, KEY, scope, email, "r1"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  it("using the key kills the code and vice versa", async () => {
    const scope = `lk-${uniq()}`;
    const email = "s@example.com";
    const { code, key } = (await issueLoginCode(DB, KEY, scope, email, "r0"))!;
    expect(await verifyLoginKey(DB, KEY, scope, email, key)).toBe(true);
    expect(await verifyLoginCode(DB, KEY, scope, email, code, "r0")).toBe(false);

    const scope2 = `lk-${uniq()}`;
    const { code: code2, key: key2 } = (await issueLoginCode(DB, KEY, scope2, email, "r0"))!;
    expect(await verifyLoginCode(DB, KEY, scope2, email, code2, "r0")).toBe(true);
    expect(await verifyLoginKey(DB, KEY, scope2, email, key2)).toBe(false);
  });

  it("the key is bound to email and scope", async () => {
    const s1 = `lk-${uniq()}`;
    const s2 = `lk-${uniq()}`;
    const { key } = (await issueLoginCode(DB, KEY, s1, "a@example.com", "r0"))!;
    expect(await verifyLoginKey(DB, KEY, s1, "b@example.com", key)).toBe(false);
    expect(await verifyLoginKey(DB, KEY, s2, "a@example.com", key)).toBe(false);
    expect(await verifyLoginKey(DB, KEY, s1, "a@example.com", key)).toBe(true);
  });

  it("wrong keys spend no typed guess", async () => {
    const scope = `lk-${uniq()}`;
    const email = "w@example.com";
    const { code } = (await issueLoginCode(DB, KEY, scope, email, "r0"))!;
    for (let i = 0; i < 20; i++) expect(await verifyLoginKey(DB, KEY, scope, email, "WRONGKEY")).toBe(false);
    expect(await total(scope, email)).toBe(0);
    expect(await verifyLoginCode(DB, KEY, scope, email, code, "r0")).toBe(true);
  });

  it("a second request within 120 s inserts nothing; at 121 s it does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = 1_900_000_000_000;
    vi.setSystemTime(base);
    const scope = `lk-${uniq()}`;
    const email = "g@example.com";
    expect(await issueLoginCode(DB, KEY, scope, email, "r0")).toBeDefined();
    vi.setSystemTime(base + SEND_GAP_MS - 1);
    expect(await issueLoginCode(DB, KEY, scope, email, "r0")).toBeUndefined();
    vi.setSystemTime(base + SEND_GAP_MS + 1);
    expect(await issueLoginCode(DB, KEY, scope, email, "r0")).toBeDefined();
  });

  it("normalises and formats a typed key", () => {
    expect(normalizeKey("aB cD-eF gH jK mN pQ rS tV wX yZ")).toBe("ABCDEFGHJKMNPQRSTVWXYZ");
    expect(normalizeKey("il1o0")).toBe("11100");
    expect(formatKey("ABCDEFGHJKMNPQRSTVWXY")).toBe("ABCDE-FGHJK-MNPQR-STVWX-Y");
  });

  afterEach(() => vi.useRealTimers());
});

describe("sign-in key over HTTP", () => {
  it("parallel /code/link gives exactly one session", async () => {
    const a = await createTestTenant(env, SELF);
    const r = await codeFor(a.origin, a.email, "203.0.113.1");
    expect(r.body.devCode).toMatch(/^\d{6}$/);
    expect(r.body.devKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    const statuses = await Promise.all(["203.0.113.1", "198.51.100.1", "203.0.113.2", "198.51.100.2"].map((ip) => link(a.origin, a.email, r.body.devKey!, ip)));
    expect(statuses.filter((s) => s.status === 200).length).toBe(1);
  });

  it("after the typed cap is exhausted the key still signs in over HTTP", async () => {
    const a = await createTestTenant(env, SELF);
    for (let i = 0; i < 2; i++) {
      const { code } = (await issueLoginCode(DB, KEY, a.id, a.email, `evil${i}`))!;
      for (let g = 0; g < 5; g++) await verifyLoginCode(DB, KEY, a.id, a.email, wrongOf(code), `evil${i}`);
      await ageOut(a.id);
    }
    expect(await total(a.id, a.email)).toBe(10);
    const r = await codeFor(a.origin, a.email, "203.0.113.40");
    expect(r.body.devKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    const res = await link(a.origin, a.email, r.body.devKey!, "203.0.113.41");
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-rose_session=/);
  });

  it("/code/verify racing /code/link on the same code gives exactly one session", async () => {
    const a = await createTestTenant(env, SELF);
    const r = await codeFor(a.origin, a.email, "203.0.113.10");
    const results = await Promise.all([
      post(a.origin, "/api/auth/code/verify", { email: a.email, code: r.body.devCode! }, "203.0.113.10"),
      link(a.origin, a.email, r.body.devKey!, "203.0.113.11"),
    ]);
    expect(results.filter((res) => res.status === 200).length).toBe(1);
  });

  it("the key is refused on another tenant's host", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(b.id, a.userId).run();
    const r = await codeFor(a.origin, a.email, "203.0.113.3");
    expect((await link(b.origin, a.email, r.body.devKey!, "203.0.113.3")).status).toBe(401);
    expect((await link(a.origin, a.email, r.body.devKey!, "203.0.113.3")).status).toBe(200);
  });

  it("unknown, expired, consumed and ineligible keys answer identically and die", async () => {
    const a = await createTestTenant(env, SELF);
    const mine = await codeFor(a.origin, a.email, "203.0.113.4");
    const key = mine.body.devKey!;
    const unknownRes = await link(a.origin, a.email, "00000000000000000000", "203.0.113.5");
    const unknownBody = strip(await unknownRes.json());

    await ageOut(a.id);
    const expired = await codeFor(a.origin, a.email, "203.0.113.6");
    const expiredId = (await DB.prepare("SELECT id FROM login_codes WHERE scope = ? AND email = ? AND consumed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(a.id, a.email).first<{ id: string }>())!.id;
    await DB.prepare("UPDATE login_codes SET expires_at = 1 WHERE id = ?").bind(expiredId).run();
    const expiredRes = await link(a.origin, a.email, expired.body.devKey!, "203.0.113.6");

    await ageOut(a.id);
    const consumed = await codeFor(a.origin, a.email, "203.0.113.7");
    const consumedId = (await DB.prepare("SELECT id FROM login_codes WHERE scope = ? AND email = ? AND consumed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(a.id, a.email).first<{ id: string }>())!.id;
    await DB.prepare("UPDATE login_codes SET consumed_at = 1 WHERE id = ?").bind(consumedId).run();
    const consumedRes = await link(a.origin, a.email, consumed.body.devKey!, "203.0.113.7");

    const { key: ineligibleKey } = (await issueLoginCode(DB, KEY, a.id, "nobody@example.com", "r0"))!;
    const ineligible = await link(a.origin, "nobody@example.com", ineligibleKey, "203.0.113.8");

    const before = await total(a.id, a.email);
    expect(unknownRes.status).toBe(401);
    expect(unknownRes.headers.get("Set-Cookie")).toBeNull();
    for (const res of [expiredRes, consumedRes, ineligible]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(strip(await res.json())).toEqual(unknownBody);
    }
    expect(await total(a.id, a.email)).toBe(before);
    expect((await link(a.origin, a.email, key, "203.0.113.9")).status).toBe(200);
  });
});
