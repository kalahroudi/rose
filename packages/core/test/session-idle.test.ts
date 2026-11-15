// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_IDLE_TIMEOUT, createSession, listSessions, readSession, sweepExpired } from "../src/control/sessions";
import { ensureUser } from "../src/control/users";
import { HOST_CACHE_TTL_MS, invalidateHostCache, resolveHost } from "../src/tenancy/resolve";
import { createTestTenant } from "../src/testing";

const setSeen = (userId: string, at: number) => env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?").bind(at, userId).run();
const lastSeen = async (userId: string) => (await env.DB.prepare("SELECT MAX(last_seen_at) AS t FROM sessions WHERE user_id = ?").bind(userId).first<{ t: number }>())!.t;

describe("idle session timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("is 12 hours", () => expect(SESSION_IDLE_TIMEOUT).toBe(12 * 3_600_000));

  it("refuses an idle tenant session, accepts one inside the window, and refuses exactly at the boundary", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await setSeen(a.userId, Date.now() - SESSION_IDLE_TIMEOUT + 60_000);
    expect(await readSession(env.DB, token, a.id)).not.toBeNull();
    await setSeen(a.userId, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect(await readSession(env.DB, token, a.id)).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await setSeen(a.userId, Date.now() - SESSION_IDLE_TIMEOUT);
    expect(await readSession(env.DB, token, a.id)).toBeNull();
  });

  it("refuses an idle platform session and accepts an active one", async () => {
    const op = await ensureUser(env.DB, `idle-op-${crypto.randomUUID()}@example.com`);
    await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES (?, 'operator', 0)").bind(op.id).run();
    const { token } = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    expect(await readSession(env.DB, token, "platform")).not.toBeNull();
    await setSeen(op.id, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect(await readSession(env.DB, token, "platform")).toBeNull();
  });

  it("an active session is kept alive: last_seen_at is refreshed, so the idle rule never fires", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    // Use it every 6 hours for 3 days: far beyond the idle timeout in total, never idle in between.
    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime(start + i * 6 * 3_600_000);
      expect(await readSession(env.DB, token, a.id)).not.toBeNull();
      expect(await lastSeen(a.userId)).toBe(start + i * 6 * 3_600_000);
    }
  });

  it("listSessions hides idle sessions and sweepExpired deletes them", async () => {
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = ? AND id_hash != (SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)")
      .bind(Date.now() - SESSION_IDLE_TIMEOUT - 1_000, a.userId, a.userId).run();
    const before = await listSessions(env.DB, a.userId, a.id);
    expect(before.length).toBe(1);

    await setSeen(a.userId, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect(await listSessions(env.DB, a.userId, a.id)).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(a.userId).first<{ n: number }>())!.n).toBeGreaterThan(0);
    await sweepExpired(env.DB);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(a.userId).first<{ n: number }>())!.n).toBe(0);
    expect(await readSession(env.DB, token, a.id)).toBeNull();
  });
});

describe("host cache", () => {
  afterEach(() => vi.useRealTimers());

  it("is short, and an entry expires after HOST_CACHE_TTL_MS", async () => {
    expect(HOST_CACHE_TTL_MS).toBeLessThanOrEqual(5_000);
    const a = await createTestTenant(env, SELF);
    const base = "example.test";
    const host = `${a.slug}.${base}`;
    invalidateHostCache();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const first = await resolveHost(env.DB, host, base);
    expect(first.kind).toBe("tenant");
    await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(a.id).run();
    vi.advanceTimersByTime(HOST_CACHE_TTL_MS - 1);
    expect((await resolveHost(env.DB, host, base)).kind).toBe("tenant");
    vi.advanceTimersByTime(2);
    expect((await resolveHost(env.DB, host, base)).kind).toBe("unknown");
  });
});
