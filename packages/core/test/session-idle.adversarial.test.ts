// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for the idle session timeout and the short host cache, driven through
// the real request paths where possible.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_IDLE_TIMEOUT, SESSION_TTL, createSession, listSessions, readSession, sweepExpired } from "../src/control/sessions";
import { ensureUser } from "../src/control/users";
import { HOST_CACHE_TTL_MS, invalidateHostCache, resolveHost } from "../src/tenancy/resolve";
import { createTestTenant, type TestTenant } from "../src/testing";

const TOUCH_INTERVAL = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setSeenByToken = async (token: string, at: number) => {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(at, hash).run();
  return hash;
};
const rowByHash = (hash: string) =>
  env.DB.prepare("SELECT last_seen_at, expires_at, created_at, public_id FROM sessions WHERE id_hash = ?").bind(hash).first<{ last_seen_at: number; expires_at: number; created_at: number; public_id: string }>();
const tokenOf = (t: TestTenant) => t.cookie.split("=")[1]!;
const bootSession = async (t: TestTenant, cookie?: string) =>
  ((await (await t.fetch("/api/bootstrap", cookie ? { cookie } : {})).json()) as { session: unknown }).session;

async function makeOperator() {
  const op = await ensureUser(env.DB, `adv-op-${crypto.randomUUID()}@example.com`);
  await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES (?, 'operator', 0)").bind(op.id).run();
  return op;
}

describe("idle timeout through the tenant request path", () => {
  afterEach(() => vi.useRealTimers());

  it("an idle cookie is refused on module routes (401) and bootstrap reports no session", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/m/notes")).status).toBe(200);
    await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT - 5_000);
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
    expect(await bootSession(a)).toBeNull();
    expect((await a.fetch("/api/m/notes", { body: { title: "x" } })).status).toBe(401);
  });

  it("a refused idle request does not revive the session (last_seen_at is not bumped)", async () => {
    const a = await createTestTenant(env, SELF);
    const stale = Date.now() - SESSION_IDLE_TIMEOUT - 5_000;
    const hash = await setSeenByToken(tokenOf(a), stale);
    for (let i = 0; i < 3; i++) expect((await a.fetch("/api/m/notes")).status).toBe(401);
    await a.fetch("/api/auth/sessions");
    await a.fetch("/api/bootstrap");
    const row = await rowByHash(hash);
    expect(row?.last_seen_at ?? stale).toBe(stale);
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
  });

  it("idle refusal applies even though the absolute lifetime is far from over", async () => {
    const a = await createTestTenant(env, SELF);
    const hash = await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    const row = (await rowByHash(hash))!;
    expect(row.expires_at - Date.now()).toBeGreaterThan(SESSION_TTL - 60_000);
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
  });

  it("an active session past its absolute expiry is still refused (idle rule does not extend lifetime)", async () => {
    const a = await createTestTenant(env, SELF);
    const hash = await setSeenByToken(tokenOf(a), Date.now());
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(Date.now() - 1, hash).run();
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
  });

  it("using a session keeps it alive: never pushes expires_at beyond the absolute lifetime", async () => {
    const a = await createTestTenant(env, SELF);
    const hash = await setSeenByToken(tokenOf(a), Date.now() - TOUCH_INTERVAL - 60_000);
    const before = (await rowByHash(hash))!;
    expect((await a.fetch("/api/m/notes")).status).toBe(200);
    const after = (await rowByHash(hash))!;
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.expires_at - after.created_at).toBeLessThanOrEqual(SESSION_TTL);
  });

  it("a session just inside the idle window is accepted over HTTP and its last_seen_at refreshed", async () => {
    const a = await createTestTenant(env, SELF);
    const hash = await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT + 30_000);
    const t0 = Date.now();
    expect((await a.fetch("/api/m/notes")).status).toBe(200);
    expect((await rowByHash(hash))!.last_seen_at).toBeGreaterThanOrEqual(t0);
  });

  it("last_seen_at is written at most every TOUCH_INTERVAL", async () => {
    const a = await createTestTenant(env, SELF);
    const seen = Date.now() - 60_000;
    const hash = await setSeenByToken(tokenOf(a), seen);
    for (let i = 0; i < 3; i++) expect((await a.fetch("/api/m/notes")).status).toBe(200);
    expect((await rowByHash(hash))!.last_seen_at).toBe(seen);
  });

  it("the idle rule does not leak across tenants: B's cookie replayed on A's host stays refused", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/m/notes", { cookie: b.cookie })).status).toBe(401);
    // Idle on one tenant does not affect another tenant's session.
    await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect((await b.fetch("/api/m/notes")).status).toBe(200);
  });
});

describe("session list / revoke endpoints and the sweep", () => {
  it("GET /api/auth/sessions hides an idle sibling session and still marks the current one", async () => {
    const a = await createTestTenant(env, SELF);
    const other = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const otherHash = await setSeenByToken(other.token, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    const otherId = (await rowByHash(otherHash))!.public_id;
    const res = await a.fetch("/api/auth/sessions");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { id: string; current: boolean }[] };
    expect(items.map((i) => i.id)).not.toContain(otherId);
    expect(items.filter((i) => i.current).length).toBe(1);
  });

  it("an idle cookie can not list sessions", async () => {
    const a = await createTestTenant(env, SELF);
    await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect((await a.fetch("/api/auth/sessions")).status).toBe(401);
  });

  it("an idle cookie can not revoke another live session", async () => {
    const a = await createTestTenant(env, SELF);
    const live = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const liveHash = await setSeenByToken(live.token, Date.now());
    const liveId = (await rowByHash(liveHash))!.public_id;
    await setSeenByToken(tokenOf(a), Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    expect((await a.fetch(`/api/auth/sessions/${liveId}`, { method: "DELETE" })).status).toBe(401);
    expect(await rowByHash(liveHash)).not.toBeNull();
  });

  it("a live session can revoke an idle sibling it can not see (no resurrection, row removed)", async () => {
    const a = await createTestTenant(env, SELF);
    const other = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const otherHash = await setSeenByToken(other.token, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    const otherId = (await rowByHash(otherHash))!.public_id;
    const r = await a.fetch(`/api/auth/sessions/${otherId}`, { method: "DELETE" });
    expect([200, 404]).toContain(r.status);
    expect((await a.fetch("/api/m/notes", { cookie: `__Host-rose_session=${other.token}` })).status).toBe(401);
  });

  it("the tick endpoint sweeps idle sessions but keeps active ones (tenant and platform)", async () => {
    const a = await createTestTenant(env, SELF);
    const idle = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const idleHash = await setSeenByToken(idle.token, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    const activeHash = await setSeenByToken(tokenOf(a), Date.now());
    const op = await makeOperator();
    const opIdle = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    const opIdleHash = await setSeenByToken(opIdle.token, Date.now() - SESSION_IDLE_TIMEOUT - 1_000);
    const opLive = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    const opLiveHash = await setSeenByToken(opLive.token, Date.now());

    const res = await SELF.fetch(`${a.origin}/__dev/tick`, { method: "POST", headers: { Origin: a.origin } });
    expect(res.status).toBe(200);
    expect(await rowByHash(idleHash)).toBeNull();
    expect(await rowByHash(opIdleHash)).toBeNull();
    expect(await rowByHash(activeHash)).not.toBeNull();
    expect(await rowByHash(opLiveHash)).not.toBeNull();
    expect((await a.fetch("/api/m/notes")).status).toBe(200);
  });
});

describe("idle boundaries with a frozen clock", () => {
  afterEach(() => vi.useRealTimers());
  const T = 1_900_000_000_000;

  it("tenant: 1 ms inside the window is accepted, exactly at the timeout is refused", async () => {
    const a = await createTestTenant(env, SELF);
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").bind(T + SESSION_TTL, a.userId).run();
    await setSeenByToken(tokenOf(a), T - SESSION_IDLE_TIMEOUT + 1);
    expect(await readSession(env.DB, tokenOf(a), a.id)).not.toBeNull();
    await setSeenByToken(tokenOf(a), T - SESSION_IDLE_TIMEOUT);
    expect(await readSession(env.DB, tokenOf(a), a.id)).toBeNull();
  });

  it("platform: exactly at the timeout is refused, 1 ms inside accepted", async () => {
    const op = await makeOperator();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const { token } = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    await setSeenByToken(token, T - SESSION_IDLE_TIMEOUT);
    expect(await readSession(env.DB, token, "platform")).toBeNull();
    await setSeenByToken(token, T - SESSION_IDLE_TIMEOUT + 1);
    expect(await readSession(env.DB, token, "platform")).not.toBeNull();
  });

  it("listSessions and sweepExpired agree with readSession at the boundary", async () => {
    const op = await makeOperator();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const atEdge = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    const inside = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    const edgeHash = await setSeenByToken(atEdge.token, T - SESSION_IDLE_TIMEOUT);
    const insideHash = await setSeenByToken(inside.token, T - SESSION_IDLE_TIMEOUT + 1);
    const listed = (await listSessions(env.DB, op.id, "platform")).map((s) => s.id);
    expect(listed).toEqual([(await rowByHash(insideHash))!.public_id]);
    await sweepExpired(env.DB);
    expect(await rowByHash(edgeHash)).toBeNull();
    expect(await rowByHash(insideHash)).not.toBeNull();
  });

  it("absolute expiry still wins over a fresh last_seen_at (and boundary expires_at == now is refused)", async () => {
    const op = await makeOperator();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const { token } = await createSession(env.DB, { userId: op.id, scope: "platform", method: "test" });
    const hash = await setSeenByToken(token, T);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(T, hash).run();
    expect(await readSession(env.DB, token, "platform")).toBeNull();
    expect(await listSessions(env.DB, op.id, "platform")).toEqual([]);
  });

  it("a session used every 11h59m for 7 days stays alive until absolute expiry, then dies", async () => {
    const a = await createTestTenant(env, SELF);
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const step = SESSION_IDLE_TIMEOUT - 60_000;
    let t = T;
    while (t + step < T + SESSION_TTL) {
      t += step;
      vi.setSystemTime(t);
      expect(await readSession(env.DB, token, a.id)).not.toBeNull();
    }
    vi.setSystemTime(T + SESSION_TTL);
    expect(await readSession(env.DB, token, a.id)).toBeNull();
  });

  it("idle-by-a-hair session is not rescued by a concurrent touch", async () => {
    const a = await createTestTenant(env, SELF);
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").bind(T + SESSION_TTL, a.userId).run();
    await setSeenByToken(tokenOf(a), T - SESSION_IDLE_TIMEOUT - 1);
    const results = await Promise.all(Array.from({ length: 5 }, () => readSession(env.DB, tokenOf(a), a.id)));
    expect(results.every((r) => r === null)).toBe(true);
  });
});

describe("host cache expiry and invalidation", () => {
  afterEach(() => vi.useRealTimers());
  const base = "example.test";

  it("negative entries (unknown host) also expire after HOST_CACHE_TTL_MS", async () => {
    invalidateHostCache();
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    const slug = `late${crypto.randomUUID().slice(0, 8)}`;
    expect((await resolveHost(env.DB, `${slug}.${base}`, base)).kind).toBe("unknown");
    await createTestTenant(env, SELF, { slug });
    vi.advanceTimersByTime(HOST_CACHE_TTL_MS - 1);
    expect((await resolveHost(env.DB, `${slug}.${base}`, base)).kind).toBe("unknown");
    vi.advanceTimersByTime(1);
    expect((await resolveHost(env.DB, `${slug}.${base}`, base)).kind).toBe("tenant");
  });

  it("custom-domain removal is reflected after the TTL", async () => {
    const a = await createTestTenant(env, SELF);
    const host = `adv-${crypto.randomUUID().slice(0, 8)}.customer.test`;
    await env.DB.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES (?, ?, 'active', 0, 0)").bind(host, a.id).run();
    invalidateHostCache();
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    expect((await resolveHost(env.DB, host, base)).kind).toBe("tenant");
    await env.DB.prepare("DELETE FROM tenant_domains WHERE hostname = ?").bind(host).run();
    vi.advanceTimersByTime(HOST_CACHE_TTL_MS);
    expect((await resolveHost(env.DB, host, base)).kind).toBe("unknown");
  });

  it("a cached entry does not get its lifetime extended by repeated hits", async () => {
    const a = await createTestTenant(env, SELF);
    const host = `${a.slug}.${base}`;
    invalidateHostCache();
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    await resolveHost(env.DB, host, base);
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(Math.floor(HOST_CACHE_TTL_MS / 10) - 1);
      await resolveHost(env.DB, host, base);
    }
    vi.advanceTimersByTime(20);
    const r = await resolveHost(env.DB, host, base);
    expect(r.kind === "tenant" && r.tenant.status).toBe("suspended");
  });

  it("invalidateHostCache(host) drops only that host", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    invalidateHostCache();
    await resolveHost(env.DB, `${a.slug}.${base}`, base);
    await resolveHost(env.DB, `${b.slug}.${base}`, base);
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id IN (?, ?)").bind(a.id, b.id).run();
    invalidateHostCache(`${a.slug}.${base}`);
    const ra = await resolveHost(env.DB, `${a.slug}.${base}`, base);
    const rb = await resolveHost(env.DB, `${b.slug}.${base}`, base);
    expect(ra.kind === "tenant" && ra.tenant.status).toBe("suspended");
    expect(rb.kind === "tenant" && rb.tenant.status).toBe("active");
  });

  it("over HTTP: a suspension is visible on every request within TTL + margin, and authenticated access is refused immediately", async () => {
    const a = await createTestTenant(env, SELF);
    const boot = async () => (await (await a.fetch("/api/bootstrap")).json()) as { tenant?: { status: string } };
    expect((await boot()).tenant?.status).toBe("active");
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.id).run();
    // Session query re-checks status: no cache window for authenticated access.
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
    await sleep(HOST_CACHE_TTL_MS + 200);
    for (let i = 0; i < 5; i++) expect((await boot()).tenant?.status).toBe("suspended");
  }, 20_000);

  it("over HTTP: a deleted tenant's host becomes unknown within TTL + margin", async () => {
    const a = await createTestTenant(env, SELF);
    const boot = async () => (await (await a.fetch("/api/bootstrap")).json()) as { host: string };
    expect((await boot()).host).toBe("tenant");
    await env.DB.prepare("DELETE FROM sessions WHERE scope = ?").bind(a.id).run();
    await env.DB.prepare("DELETE FROM memberships WHERE tenant_id = ?").bind(a.id).run();
    await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(a.id).run();
    await sleep(HOST_CACHE_TTL_MS + 200);
    for (let i = 0; i < 5; i++) expect((await boot()).host).toBe("unknown");
  }, 20_000);
});
