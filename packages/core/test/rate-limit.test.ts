// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTenantWorker } from "../src";
import { consumeRateLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../src/control/rate-limit";
import { sweepExpired } from "../src/control/sessions";
import { deriveHmacKey, hmacHex } from "../src/crypto";
import { toB64Url } from "../src/encoding";
import { AppError } from "../src/errors";
import { createTestTenant } from "../src/testing";
import { notes } from "./worker";

const KEY = env.ROSE_MASTER_KEY;
const OTHER_KEY = toB64Url(new Uint8Array(32).fill(7));
const worker = createTenantWorker({ modules: [notes] });
const rootOrigin = `https://${env.APP_BASE_DOMAIN}`;
const passThroughRl = { limit: () => Promise.resolve({ success: true }) };
const rejectRl = { limit: () => Promise.resolve({ success: false }) };

const uniq = () => crypto.randomUUID().slice(0, 8);

const keyHashOf = async (masterKey: string, key: string) =>
  hmacHex(await deriveHmacKey(masterKey, "rate-limit/v1"), key);

const readRow = async (keyHash: string) =>
  env.DB.prepare("SELECT key_hash, window_start, count FROM rate_limits WHERE key_hash = ?")
    .bind(keyHash)
    .first<{ key_hash: string; window_start: number; count: number }>();

const prodEnv = (rl: { limit: (input: { key: string }) => Promise<{ success: boolean }> } = passThroughRl) =>
  ({ ...env, ENVIRONMENT: "production", RL_AUTH: rl }) as never;

async function fetchWorker(req: Request, e: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("consumeRateLimit", () => {
  afterEach(() => vi.useRealTimers());

  it("allows exactly RATE_LIMIT_MAX calls in a window and refuses further calls without mutating window_start or count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const key = `exact-${uniq()}`;
    const hash = await keyHashOf(KEY, key);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await consumeRateLimit(env.DB, KEY, key)).toBe(true);
    }
    const atLimit = await readRow(hash);
    expect(atLimit).toEqual({ key_hash: hash, window_start: t0, count: RATE_LIMIT_MAX });

    vi.setSystemTime(t0 + 5_000);
    for (let i = 0; i < 5; i++) {
      expect(await consumeRateLimit(env.DB, KEY, key)).toBe(false);
    }
    expect(await readRow(hash)).toEqual({ key_hash: hash, window_start: t0, count: RATE_LIMIT_MAX });
  });

  it("enforces exact limit under 60 concurrent calls with zero burst leak", async () => {
    const key = `burst-${uniq()}`;
    const hash = await keyHashOf(KEY, key);

    const results = await Promise.all(Array.from({ length: 60 }, () => consumeRateLimit(env.DB, KEY, key)));
    expect(results.filter(Boolean).length).toBe(RATE_LIMIT_MAX);
    expect(results.filter((ok) => !ok).length).toBe(40);
    expect((await readRow(hash))?.count).toBe(RATE_LIMIT_MAX);
  });

  it("refuses at window_start + 59_999 and resets to count = 1 at window_start + 60_000", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_100_000;
    vi.setSystemTime(t0);
    const key = `window-${uniq()}`;
    const hash = await keyHashOf(KEY, key);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await consumeRateLimit(env.DB, KEY, key)).toBe(true);
    }

    vi.setSystemTime(t0 + RATE_LIMIT_WINDOW_MS - 1);
    expect(await consumeRateLimit(env.DB, KEY, key)).toBe(false);
    expect(await readRow(hash)).toEqual({ key_hash: hash, window_start: t0, count: RATE_LIMIT_MAX });

    vi.setSystemTime(t0 + RATE_LIMIT_WINDOW_MS);
    expect(await consumeRateLimit(env.DB, KEY, key)).toBe(true);
    expect(await readRow(hash)).toEqual({ key_hash: hash, window_start: t0 + RATE_LIMIT_WINDOW_MS, count: 1 });
  });

  it("does not reset the counter when clock skews backwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_200_000;
    vi.setSystemTime(t0);
    const exhaustedKey = `skew-full-${uniq()}`;
    const exhaustedHash = await keyHashOf(KEY, exhaustedKey);
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await consumeRateLimit(env.DB, KEY, exhaustedKey)).toBe(true);
    }

    vi.setSystemTime(t0 - 120_000);
    expect(await consumeRateLimit(env.DB, KEY, exhaustedKey)).toBe(false);
    expect(await readRow(exhaustedHash)).toEqual({ key_hash: exhaustedHash, window_start: t0, count: RATE_LIMIT_MAX });

    vi.setSystemTime(t0);
    const partialKey = `skew-partial-${uniq()}`;
    const partialHash = await keyHashOf(KEY, partialKey);
    for (let i = 0; i < 5; i++) {
      expect(await consumeRateLimit(env.DB, KEY, partialKey)).toBe(true);
    }

    vi.setSystemTime(t0 - 120_000);
    expect(await consumeRateLimit(env.DB, KEY, partialKey)).toBe(true);
    expect(await readRow(partialHash)).toEqual({ key_hash: partialHash, window_start: t0, count: 6 });
  });

  it("isolates distinct keys and distinct master keys sharing D1", async () => {
    const keyA = `iso-a-${uniq()}`;
    const keyB = `iso-b-${uniq()}`;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await consumeRateLimit(env.DB, KEY, keyA)).toBe(true);
    }
    expect(await consumeRateLimit(env.DB, KEY, keyA)).toBe(false);
    expect(await consumeRateLimit(env.DB, KEY, keyB)).toBe(true);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await consumeRateLimit(env.DB, OTHER_KEY, keyA)).toBe(true);
    }
    expect(await consumeRateLimit(env.DB, OTHER_KEY, keyA)).toBe(false);
    expect(await keyHashOf(KEY, keyA)).not.toBe(await keyHashOf(OTHER_KEY, keyA));
  });

  it("never stores raw IP addresses or email addresses in rate_limits.key_hash", async () => {
    const ip = "203.0.113.199";
    const email = `privacy-${uniq()}@example.com`;
    const key = `code:scope:${email}:${ip}`;
    const expectedHash = await keyHashOf(KEY, key);

    expect(await consumeRateLimit(env.DB, KEY, key)).toBe(true);
    const row = await readRow(expectedHash);
    expect(row).not.toBeNull();
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.key_hash).not.toContain(ip);
    expect(row!.key_hash).not.toContain(email);

    const leaked = await env.DB.prepare("SELECT key_hash FROM rate_limits WHERE key_hash LIKE ? OR key_hash LIKE ?")
      .bind(`%${ip}%`, `%${email}%`)
      .all();
    expect(leaked.results).toEqual([]);
  });

  it("refuses immediately and writes no row when limit <= 0", async () => {
    const zeroKey = `zero-${uniq()}`;
    const negKey = `neg-${uniq()}`;

    expect(await consumeRateLimit(env.DB, KEY, zeroKey, { limit: 0 })).toBe(false);
    expect(await consumeRateLimit(env.DB, KEY, negKey, { limit: -5 })).toBe(false);
    expect(await readRow(await keyHashOf(KEY, zeroKey))).toBeNull();
    expect(await readRow(await keyHashOf(KEY, negKey))).toBeNull();
  });

  it("fails closed with misconfigured error when ROSE_MASTER_KEY is missing or invalid", async () => {
    for (const bad of ["", "not-valid-base64!!!", "AAAA"]) {
      const err = await consumeRateLimit(env.DB, bad, `bad-key-${uniq()}`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(503);
      expect((err as AppError).code).toBe("misconfigured");
    }
  });
});

describe("sweepExpired for rate_limits", () => {
  afterEach(() => vi.useRealTimers());

  it("deletes rows at or before t - RATE_LIMIT_WINDOW_MS and keeps newer rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_300_000;
    vi.setSystemTime(t0);

    const expiredHash = `sweep-exp-${uniq()}`;
    const boundaryHash = `sweep-bnd-${uniq()}`;
    const freshHash = `sweep-ok-${uniq()}`;

    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_limits (key_hash, window_start, count) VALUES (?, ?, 20)")
        .bind(expiredHash, t0 - RATE_LIMIT_WINDOW_MS - 1),
      env.DB.prepare("INSERT INTO rate_limits (key_hash, window_start, count) VALUES (?, ?, 20)")
        .bind(boundaryHash, t0 - RATE_LIMIT_WINDOW_MS),
      env.DB.prepare("INSERT INTO rate_limits (key_hash, window_start, count) VALUES (?, ?, 5)")
        .bind(freshHash, t0 - RATE_LIMIT_WINDOW_MS + 1),
    ]);

    await sweepExpired(env.DB);

    expect(await readRow(expiredHash)).toBeNull();
    expect(await readRow(boundaryHash)).toBeNull();
    expect(await readRow(freshHash)).toEqual({
      key_hash: freshHash,
      window_start: t0 - RATE_LIMIT_WINDOW_MS + 1,
      count: 5,
    });
  });
});

describe("HTTP end-to-end durable rate limit with pass-through RL_AUTH", () => {
  it("limits 40 sequential POST /api/auth/code/verify requests to 20x 401 and 20x 429", async () => {
    const a = await createTestTenant(env, SELF);
    const ip = "198.51.100.201";
    const statuses: number[] = [];

    for (let i = 0; i < 40; i++) {
      const res = await fetchWorker(
        new Request(`${a.origin}/api/auth/code/verify`, {
          method: "POST",
          headers: { Origin: a.origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ email: a.email, code: "000000" }),
        }),
        prodEnv(),
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
  });

  it("limits 60 parallel POST /api/root/code/verify requests to exactly 20x 401 and 40x 429", async () => {
    const ip = "198.51.100.202";
    const email = `root-burst-${uniq()}@example.com`;

    const statuses = await Promise.all(
      Array.from({ length: 60 }, async () => {
        const res = await fetchWorker(
          new Request(`${rootOrigin}/api/root/code/verify`, {
            method: "POST",
            headers: { Origin: rootOrigin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
            body: JSON.stringify({ email, code: "000000" }),
          }),
          prodEnv(),
        );
        return res.status;
      }),
    );

    expect(statuses.filter((s) => s === 401).length).toBe(20);
    expect(statuses.filter((s) => s === 429).length).toBe(40);
  });

  it("enforces code-ip limit across 25 distinct emails on POST /api/auth/code/request", async () => {
    const a = await createTestTenant(env, SELF);
    const ip = "198.51.100.203";
    const statuses: number[] = [];

    for (let i = 0; i < 25; i++) {
      const res = await fetchWorker(
        new Request(`${a.origin}/api/auth/code/request`, {
          method: "POST",
          headers: { Origin: a.origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ email: `distinct-${i}-${uniq()}@example.com` }),
        }),
        prodEnv(),
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
  });

  it("enforces durable limit on passkey login options, root slug lookup, and failed API key auth", async () => {
    const a = await createTestTenant(env, SELF);

    const pkIp = "198.51.100.204";
    const pkStatuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await fetchWorker(
        new Request(`${a.origin}/api/auth/passkey/login/options`, {
          method: "POST",
          headers: { Origin: a.origin, "CF-Connecting-IP": pkIp },
        }),
        prodEnv(),
      );
      pkStatuses.push(res.status);
    }
    expect(pkStatuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(pkStatuses.slice(20).every((s) => s === 429)).toBe(true);

    const slugIp = "198.51.100.205";
    const slugStatuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await fetchWorker(
        new Request(`${rootOrigin}/api/root/slug?slug=check-${i}`, {
          headers: { "CF-Connecting-IP": slugIp },
        }),
        prodEnv(),
      );
      slugStatuses.push(res.status);
    }
    expect(slugStatuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(slugStatuses.slice(20).every((s) => s === 429)).toBe(true);

    const keyIp = "198.51.100.206";
    const keyStatuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await fetchWorker(
        new Request(`${a.origin}/api/m/notes`, {
          headers: { Authorization: "Bearer bad", "CF-Connecting-IP": keyIp },
        }),
        prodEnv(),
      );
      keyStatuses.push(res.status);
    }
    expect(keyStatuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(keyStatuses.slice(20).every((s) => s === 429)).toBe(true);
  });

  it("returns 429 without inserting or incrementing a D1 row when RL_AUTH rejects first", async () => {
    const freshIp = "198.51.100.207";
    const freshHash = await keyHashOf(KEY, `slug-ip:${freshIp}`);
    const rejected = await fetchWorker(
      new Request(`${rootOrigin}/api/root/slug?slug=first-filter`, {
        headers: { "CF-Connecting-IP": freshIp },
      }),
      prodEnv(rejectRl),
    );
    expect(rejected.status).toBe(429);
    expect(await readRow(freshHash)).toBeNull();

    const existingIp = "198.51.100.208";
    const existingHash = await keyHashOf(KEY, `slug-ip:${existingIp}`);
    const allowed = await fetchWorker(
      new Request(`${rootOrigin}/api/root/slug?slug=seed-row`, {
        headers: { "CF-Connecting-IP": existingIp },
      }),
      prodEnv(passThroughRl),
    );
    expect(allowed.status).toBe(200);
    expect((await readRow(existingHash))?.count).toBe(1);

    const blocked = await fetchWorker(
      new Request(`${rootOrigin}/api/root/slug?slug=no-increment`, {
        headers: { "CF-Connecting-IP": existingIp },
      }),
      prodEnv(rejectRl),
    );
    expect(blocked.status).toBe(429);
    expect((await readRow(existingHash))?.count).toBe(1);
  });

  it("leaves a different client IP unaffected when another IP hits 429", async () => {
    const a = await createTestTenant(env, SELF);
    const blockedIp = "198.51.100.209";
    const otherIp = "198.51.100.210";

    for (let i = 0; i < 20; i++) {
      const res = await fetchWorker(
        new Request(`${a.origin}/api/auth/code/verify`, {
          method: "POST",
          headers: { Origin: a.origin, "Content-Type": "application/json", "CF-Connecting-IP": blockedIp },
          body: JSON.stringify({ email: a.email, code: "000000" }),
        }),
        prodEnv(),
      );
      expect(res.status).toBe(401);
    }

    const throttled = await fetchWorker(
      new Request(`${a.origin}/api/auth/code/verify`, {
        method: "POST",
        headers: { Origin: a.origin, "Content-Type": "application/json", "CF-Connecting-IP": blockedIp },
        body: JSON.stringify({ email: a.email, code: "000000" }),
      }),
      prodEnv(),
    );
    expect(throttled.status).toBe(429);

    const unaffected = await fetchWorker(
      new Request(`${a.origin}/api/auth/code/verify`, {
        method: "POST",
        headers: { Origin: a.origin, "Content-Type": "application/json", "CF-Connecting-IP": otherIp },
        body: JSON.stringify({ email: a.email, code: "000000" }),
      }),
      prodEnv(),
    );
    expect(unaffected.status).toBe(401);
  });
});
