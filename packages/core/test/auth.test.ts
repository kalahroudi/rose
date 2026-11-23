// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantWorker } from "../src";
import { requesterKey } from "../src/http/base";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { sha256Hex } from "../src/crypto";
import { consumeHandoff, createHandoff, createSession, HANDOFF_TOKEN_MAX, readSession } from "../src/control/sessions";
import { createTenant } from "../src/control/tenants";
import { addMembership, ensureUser, getMembership } from "../src/control/users";
import { maxWorkspacesPerUser } from "../src/env";
import { createTestTenant } from "../src/testing";
import { cookiePair, handoffCookieName, hasCookie } from "./cookie-helpers";
import { ageOut } from "./otp-helpers";
import { notes } from "./worker";

const post = (origin: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

describe("email sign-in codes", () => {
  it("signs a member in and sets a host-bound cookie", async () => {
    const a = await createTestTenant(env, SELF);
    const req = await (await post(a.origin, "/api/auth/code/request", { email: a.email.toUpperCase() })).json<{ devCode: string }>();
    expect(req.devCode).toMatch(/^\d{6}$/);
    const res = await post(a.origin, "/api/auth/code/verify", { email: a.email, code: req.devCode });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-rose_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Domain=/i);
    const boot = await (await a.fetch("/api/bootstrap", { cookie: cookieOf(res) })).json<{ session: { user: { email: string } } }>();
    expect(boot.session.user.email).toBe(a.email);
  });

  it("answers identically for members and strangers, and sends strangers nothing", async () => {
    const a = await createTestTenant(env, SELF);
    const res = await post(a.origin, "/api/auth/code/request", { email: "stranger@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT 1 FROM login_codes WHERE email = 'stranger@example.com'").first()).toBeNull();
  });

  it("a code issued for one tenant does not work on another", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    // Same person is a member of both workspaces.
    await env.DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(b.id, a.userId).run();
    const { devCode } = await (await post(a.origin, "/api/auth/code/request", { email: a.email })).json<{ devCode: string }>();
    expect((await post(b.origin, "/api/auth/code/verify", { email: a.email, code: devCode })).status).toBe(401);
    expect((await post(a.origin, "/api/auth/code/verify", { email: a.email, code: devCode })).status).toBe(200);
  });

  it("codes are single use, expire, and lock after five wrong guesses", async () => {
    const key = env.ROSE_MASTER_KEY;
    const { code } = (await issueLoginCode(env.DB, key, "s1", "u@example.com", "r1"))!;
    expect(await verifyLoginCode(env.DB, key, "s1", "u@example.com", code, "r1")).toBe(true);
    expect(await verifyLoginCode(env.DB, key, "s1", "u@example.com", code, "r1")).toBe(false);

    const { code: second } = (await issueLoginCode(env.DB, key, "s2", "u@example.com", "r1"))!;
    const wrong = second === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await verifyLoginCode(env.DB, key, "s2", "u@example.com", wrong, "r1")).toBe(false);
    expect(await verifyLoginCode(env.DB, key, "s2", "u@example.com", second, "r1")).toBe(false);

    const { code: third } = (await issueLoginCode(env.DB, key, "s3", "u@example.com", "r1"))!;
    await env.DB.prepare("UPDATE login_codes SET expires_at = 1 WHERE scope = 's3'").run();
    expect(await verifyLoginCode(env.DB, key, "s3", "u@example.com", third, "r1")).toBe(false);
  });

  it("limits how many codes can be requested", async () => {
    for (let i = 0; i < 5; i++) {
      await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s4", "u@example.com", "r1");
      await ageOut("s4");
    }
    await expect(issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s4", "u@example.com", "r1")).rejects.toThrow(/Too many/);
  });

  it("limits codes per requester, with a higher overall cap per address", async () => {
    const k = env.ROSE_MASTER_KEY;
    for (let i = 0; i < 5; i++) {
      await issueLoginCode(env.DB, k, "s6", "v@example.com", "abuser");
      await ageOut("s6");
    }
    await expect(issueLoginCode(env.DB, k, "s6", "v@example.com", "abuser")).rejects.toThrow(/Too many/);
    // A different requester can still get and use a code.
    const { code } = (await issueLoginCode(env.DB, k, "s6", "v@example.com", "legit"))!;
    expect(await verifyLoginCode(env.DB, k, "s6", "v@example.com", code, "legit")).toBe(true);
    await ageOut("s6");
    // The overall per-address cap is a backstop now that the 2-minute send gap bounds issuance; seed the window directly.
    const capScope = "s6-cap";
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester) VALUES (?, ?, ?, 'x', ?, ?, ?)")
        .bind(`raw-${i}`, "v@example.com", capScope, t + 600_000, t - 120_000 - i * 30_000, `raw${i}`).run();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE scope = ? AND email = ?").bind(capScope, "v@example.com").first<{ n: number }>())!.n).toBe(20);
    await expect(issueLoginCode(env.DB, k, capScope, "v@example.com", "fresh")).rejects.toThrow(/Too many/);
    // Other scopes are unaffected.
    await issueLoginCode(env.DB, k, "s7", "v@example.com", "abuser");
  });

  it("one requester's new code does not invalidate another's, and verification falls back for a new address", async () => {
    const k = env.ROSE_MASTER_KEY;
    const { code: b } = (await issueLoginCode(env.DB, k, "s8", "w@example.com", "B"))!;
    await ageOut("s8");
    const { code: a } = (await issueLoginCode(env.DB, k, "s8", "w@example.com", "A"))!;
    expect(await verifyLoginCode(env.DB, k, "s8", "w@example.com", b, "B")).toBe(true);
    expect(await verifyLoginCode(env.DB, k, "s8", "w@example.com", a, "A")).toBe(true);
    // Verifying from an address that never requested falls back to the latest code.
    const { code: c } = (await issueLoginCode(env.DB, k, "s9", "w@example.com", "A"))!;
    expect(await verifyLoginCode(env.DB, k, "s9", "w@example.com", c, "elsewhere")).toBe(true);
  });

  it("accepts the newest emailed code from a changed address (R1, R2)", async () => {
    const k = env.ROSE_MASTER_KEY;
    await issueLoginCode(env.DB, k, "r1", "x@example.com", "A");
    await ageOut("r1");
    const { code: b } = (await issueLoginCode(env.DB, k, "r1", "x@example.com", "B"))!;
    expect(await verifyLoginCode(env.DB, k, "r1", "x@example.com", b, "A")).toBe(true);
    const { code: a2 } = (await issueLoginCode(env.DB, k, "r2", "x@example.com", "A"))!;
    expect(await verifyLoginCode(env.DB, k, "r2", "x@example.com", a2, "A")).toBe(true);
    await ageOut("r2");
    const { code: b2 } = (await issueLoginCode(env.DB, k, "r2", "x@example.com", "B"))!;
    expect(await verifyLoginCode(env.DB, k, "r2", "x@example.com", b2, "A")).toBe(true);
  });

  it("an older own code never becomes valid again once the newer one is used up", async () => {
    const k = env.ROSE_MASTER_KEY;
    const { code: old1 } = (await issueLoginCode(env.DB, k, "r4", "z@example.com", "A"))!;
    await ageOut("r4");
    const { code: new1 } = (await issueLoginCode(env.DB, k, "r4", "z@example.com", "A"))!;
    expect(await verifyLoginCode(env.DB, k, "r4", "z@example.com", new1, "A")).toBe(true);
    if (old1 !== new1) expect(await verifyLoginCode(env.DB, k, "r4", "z@example.com", old1, "A")).toBe(false);
    const { code: old2 } = (await issueLoginCode(env.DB, k, "r5", "z@example.com", "A"))!;
    await ageOut("r5");
    const { code: new2 } = (await issueLoginCode(env.DB, k, "r5", "z@example.com", "A"))!;
    const wrong = new2 === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verifyLoginCode(env.DB, k, "r5", "z@example.com", wrong === old2 ? "222222" : wrong, "A");
    expect(await verifyLoginCode(env.DB, k, "r5", "z@example.com", old2, "A")).toBe(false);
  });

  it("rejects malformed addresses instead of normalising them to another key", () => {
    expect(requesterKey("::ffff:1234.2.3.4")).toBe("::ffff:1234.2.3.4");
    expect(requesterKey("2001:db8:1:2::abc1.2.3.4")).toBe("2001:db8:1:2::abc1.2.3.4");
    expect(requesterKey("   ")).toBe("unknown");
  });

  it("buckets IPv6 to /64 and maps IPv4-mapped to IPv4", () => {
    expect(requesterKey("203.0.113.9")).toBe("203.0.113.9");
    expect(requesterKey(null)).toBe("unknown");
    const k = requesterKey("2001:db8:1:2::1");
    expect(k).toBe("2001:db8:1:2::/64");
    for (const ip of ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:0DB8:1:2::ffff", "2001:db8:1:2:0:0:0:7"]) expect(requesterKey(ip)).toBe(k);
    expect(requesterKey("2001:db8:1:3::1")).not.toBe(k);
    expect(requesterKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(requesterKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(requesterKey("::1")).toBe("0:0:0:0::/64");
  });

  it("four addresses in one /64 count as one requester", async () => {
    const k = env.ROSE_MASTER_KEY;
    for (let i = 1; i <= 4; i++) {
      await issueLoginCode(env.DB, k, "r3", "y@example.com", requesterKey(`2001:db8:9:9::${i}`));
      await ageOut("r3");
    }
    const fifth = await issueLoginCode(env.DB, k, "r3", "y@example.com", requesterKey("2001:db8:9:9::5"));
    expect(fifth?.code).toMatch(/^\d{6}$/);
  });

  it("stores only keyed hashes of codes and hashes of session tokens", async () => {
    const { code, key } = (await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s5", "u@example.com", "r1"))!;
    const row = await env.DB.prepare("SELECT code_hash, link_hash FROM login_codes WHERE scope = 's5'").first<{ code_hash: string; link_hash: string }>();
    expect(row!.code_hash).not.toContain(code);
    expect(row!.link_hash).not.toContain(key);
    const a = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    const all = await env.DB.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(a.userId).all();
    expect(JSON.stringify(all.results)).not.toContain(token);
  });
});

describe("invitations", () => {
  it("invited address joins by proving the email; nobody else can", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/invitations", { body: { email: "new@example.com", role: "member" } })).status).toBe(201);
    const { devCode } = await (await post(a.origin, "/api/auth/code/request", { email: "new@example.com" })).json<{ devCode: string }>();
    const res = await post(a.origin, "/api/auth/code/verify", { email: "new@example.com", code: devCode });
    expect(res.status).toBe(200);
    const members = await (await a.fetch("/api/members?q=new@")).json<{ items: { role: string }[]; total: number }>();
    expect(members.total).toBe(1);
    expect(members.items[0]!.role).toBe("member");
    expect((await (await a.fetch("/api/invitations")).json<{ total: number }>()).total).toBe(0);
    const audit = await (await a.fetch("/api/audit?action=member.join")).json<{ items: { actor: string; action: string }[] }>();
    expect(audit.items.some((e) => e.actor === "new@example.com" && e.action === "member.join")).toBe(true);
  });

  it("only owners can invite owners or change owner access; last owner is protected", async () => {
    const owner = await createTestTenant(env, SELF);
    const adminUser = await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_adm', 'adm@example.com', 0) RETURNING id").first<{ id: string }>();
    await env.DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'admin', 0)").bind(owner.id, adminUser!.id).run();
    const { token } = await createSession(env.DB, { userId: adminUser!.id, scope: owner.id, method: "test" });
    const adminCookie = `__Host-rose_session=${token}`;
    expect((await owner.fetch("/api/invitations", { cookie: adminCookie, body: { email: "x@example.com", role: "owner" } })).status).toBe(403);
    expect((await owner.fetch(`/api/members/${owner.userId}`, { cookie: adminCookie, method: "PATCH", body: { role: "member" } })).status).toBe(403);
    expect((await owner.fetch(`/api/members/${owner.userId}`, { cookie: adminCookie, method: "DELETE" })).status).toBe(403);
    expect((await owner.fetch(`/api/members/${owner.userId}`, { method: "PATCH", body: { role: "member" } })).status).toBe(409);
  });

  it("a member promoted to owner after the route's read can not be demoted or removed with a stale expected role", async () => {
    const worker = createTenantWorker({ modules: [notes] });
    const owner = await createTestTenant(env, SELF);
    const staleOwner = await createSession(env.DB, { userId: owner.userId, scope: owner.id, method: "stale" });
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE user_id = ? AND scope = ? AND method = ?").bind(15 * 60_000, owner.userId, owner.id, "stale").run();
    const staleOwnerCookie = `__Host-rose_session=${staleOwner.token}`;
    const adminUser = await ensureUser(env.DB, `adm-${Math.random().toString(36).slice(2, 10)}@example.com`);
    await addMembership(env.DB, owner.id, adminUser.id, "admin");
    const adminSession = await createSession(env.DB, { userId: adminUser.id, scope: owner.id, method: "test" });
    const adminCookie = `__Host-rose_session=${adminSession.token}`;

    const interceptTargetRead = (tenantId: string, targetUserId: string) => {
      let triggered = false;
      const raw = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
      const db: D1Database = {
        prepare(query: string) {
          const wrap = (stmt: D1PreparedStatement, values: unknown[] = []): D1PreparedStatement => {
            const proxy: D1PreparedStatement = {
              bind(...next: unknown[]) {
                return wrap(stmt.bind(...next), next);
              },
              async first<T = unknown>(colName?: string) {
                const res = colName === undefined ? await stmt.first<T>() : await stmt.first<T>(colName);
                if (
                  !triggered &&
                  query === "SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?" &&
                  values[0] === tenantId &&
                  values[1] === targetUserId
                ) {
                  triggered = true;
                  await env.DB.prepare("UPDATE memberships SET role = 'owner' WHERE tenant_id = ? AND user_id = ?").bind(tenantId, targetUserId).run();
                }
                return res as never;
              },
              run: () => stmt.run(),
              all: () => stmt.all(),
              raw: ((options?: { columnNames?: boolean }) => (options ? stmt.raw(options as never) : stmt.raw())) as D1PreparedStatement["raw"],
            };
            raw.set(proxy, stmt);
            return proxy;
          };
          return wrap(env.DB.prepare(query));
        },
        batch(statements: D1PreparedStatement[]) {
          return env.DB.batch(statements.map((s) => raw.get(s) ?? s));
        },
        exec(query: string) { return env.DB.exec(query); },
        dump() { return env.DB.dump(); },
        withSession(constraintOrBookmark?: string) { return env.DB.withSession(constraintOrBookmark); },
      };
      return { db, triggered: () => triggered };
    };

    const makeTarget = async () => {
      const id = Math.random().toString(36).slice(2, 10);
      const user = await ensureUser(env.DB, `promoted-${id}@example.com`);
      await addMembership(env.DB, owner.id, user.id, "member");
      await createSession(env.DB, { userId: user.id, scope: owner.id, method: "test" });
      await env.DB
        .prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, name, created_at) VALUES (?, ?, ?, 'rose.test', 'key', 'pk', 0)")
        .bind(`cred-${id}`, user.id, owner.id)
        .run();
      return user;
    };

    const cases: readonly { cookie: string; method: "PATCH" | "DELETE"; body?: { role: string } }[] = [
      { cookie: staleOwnerCookie, method: "PATCH", body: { role: "admin" } },
      { cookie: staleOwnerCookie, method: "DELETE" },
      { cookie: adminCookie, method: "PATCH", body: { role: "admin" } },
      { cookie: adminCookie, method: "DELETE" },
    ];

    for (const testCase of cases) {
      const target = await makeTarget();
      const hook = interceptTargetRead(owner.id, target.id);
      const headers: Record<string, string> = { Origin: owner.origin, Cookie: testCase.cookie };
      const init: RequestInit = { method: testCase.method, headers };
      if (testCase.body) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(testCase.body);
      }
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`${owner.origin}/api/members/${target.id}`, init), { ...env, DB: hook.db }, ctx);
      await waitOnExecutionContext(ctx);
      expect(hook.triggered()).toBe(true);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "conflict", message: "This member's role changed. Reload and try again." },
      });
      expect((await getMembership(env.DB, owner.id, target.id))!.role).toBe("owner");
      expect(await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE user_id = ? AND scope = ?").bind(target.id, owner.id).first()).not.toBeNull();
      expect(await env.DB.prepare("SELECT 1 AS x FROM passkeys WHERE user_id = ? AND scope = ?").bind(target.id, owner.id).first()).not.toBeNull();
    }
  });
});

describe("sessions and handoffs", () => {
  it("session tokens are scoped, and expire", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const { token } = await createSession(env.DB, { userId: a.userId, scope: a.id, method: "test" });
    expect(await readSession(env.DB, token, a.id)).not.toBeNull();
    expect(await readSession(env.DB, token, b.id)).toBeNull();
    expect(await readSession(env.DB, token, "platform")).toBeNull();
    await env.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = ?").bind(a.userId).run();
    expect(await readSession(env.DB, token, a.id)).toBeNull();
  });

  it("logout revokes the session server-side", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/auth/logout", { method: "POST" })).status).toBe(200);
    expect((await a.fetch("/api/m/notes")).status).toBe(401);
  });

  it("handoffs are single use and bound to purpose and tenant", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const t1 = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id });
    expect(await consumeHandoff(env.DB, t1, "session", b.id)).toBeNull();
    expect(await consumeHandoff(env.DB, t1, "signup", a.id)).toBeNull();
    expect(await consumeHandoff(env.DB, t1, "session", a.id)).toBe(a.userId);
    expect(await consumeHandoff(env.DB, t1, "session", a.id)).toBeNull();
  });

  it("a bound handoff is consumable only with its binding", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "browser-a" });
    expect(await consumeHandoff(env.DB, token, "session", a.id, "browser-b")).toBeNull();
    expect(await consumeHandoff(env.DB, token, "session", a.id, "")).toBeNull();
    expect(await consumeHandoff(env.DB, token, "session", a.id)).toBeNull();
    expect(await consumeHandoff(env.DB, token, "session", a.id, "browser-a")).toBe(a.userId);
    expect(await consumeHandoff(env.DB, token, "session", a.id, "browser-a")).toBeNull();
  });

  it("a bound handoff sent with an empty handoff cookie is refused and not consumed", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "nonce" });
    const name = await handoffCookieName(token);
    const empty = await SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: `${name}=` } });
    expect(hasCookie(empty, "__Host-rose_session")).toBe(false);
    const ok = await SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: `${name}=nonce` } });
    expect(hasCookie(ok, "__Host-rose_session")).toBe(true);
  });

  it("a handoff for tenant A does not sign you in to tenant B", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "nonce" });
    const res = await SELF.fetch(`${b.origin}/auth/handoff?token=${token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const handoffCookie = `${await handoffCookieName(token)}=nonce`;
    const onB = await SELF.fetch(`${b.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: handoffCookie } });
    expect(onB.status).toBe(302);
    expect(hasCookie(onB, "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: handoffCookie } }), "__Host-rose_session")).toBe(true);
  });

  it("parallel consumes of one bound handoff start exactly one session", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "nonce" });
    const handoffCookie = `${await handoffCookieName(token)}=nonce`;
    const results = await Promise.all(Array.from({ length: 8 }, () => SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: handoffCookie } })));
    expect(results.filter((r) => hasCookie(r, "__Host-rose_session"))).toHaveLength(1);
  });
});

describe("self-service signup on the root host", () => {
  const root = `https://${env.APP_BASE_DOMAIN}`;
  type Send = (req: Request) => Promise<Response>;
  /** POST /api/root/enter for a new workspace; returns the response, the handoff URL and the per-handoff cookie it set. */
  const enterWorkspace = async (slug: string, opts: { ticket?: string; origin?: string; send?: Send } = {}) => {
    const { origin = root, send = (req: Request) => SELF.fetch(req) } = opts;
    const ticket = opts.ticket ?? (await createHandoff(env.DB, { purpose: "signup", userId: (await ensureUser(env.DB, `${slug}@example.com`)).id, scope: "root", ttlMs: 15 * 60_000 }));
    const entered = await send(new Request(`${origin}/api/root/enter`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket, create: { name: slug, slug } }), redirect: "manual" }));
    expect(entered.ok).toBe(true);
    const { url } = await entered.json<{ url: string }>();
    const name = await handoffCookieName(new URL(url).searchParams.get("token")!, origin.startsWith("https:"));
    const set = entered.headers.getSetCookie().find((s) => s.startsWith(`${name}=`)) ?? "";
    return { entered, url, set, handoffCookie: cookiePair(entered, name) };
  };

  it("verifies the email, creates a workspace and hands the session to its host", async () => {
    const { devCode } = await (await post(root, "/api/root/code/request", { email: "founder@example.com" })).json<{ devCode: string }>();
    const verified = await (await post(root, "/api/root/code/verify", { email: "founder@example.com", code: devCode })).json<{ ticket: string; workspaces: unknown[] }>();
    expect(verified.workspaces).toEqual([]);
    const { entered, url, handoffCookie } = await enterWorkspace("acme-inc", { ticket: verified.ticket });
    expect(entered.status).toBe(200);
    expect(url).toMatch(/^https:\/\/acme-inc\.rose\.test\/auth\/handoff\?token=/);
    const landed = await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie } });
    const cookie = cookiePair(landed, "__Host-rose_session");
    expect(cookie).toMatch(/^__Host-rose_session=/);
    const boot = await (await SELF.fetch("https://acme-inc.rose.test/api/bootstrap", { headers: { Cookie: cookie } })).json<{ session: { role: string } }>();
    expect(boot.session.role).toBe("owner");
    // The ticket and the handoff are both spent, even when replayed with the handoff cookie.
    expect((await post(root, "/api/root/enter", { ticket: verified.ticket, slug: "acme-inc" })).status).toBe(401);
    expect((await SELF.fetch(url, { redirect: "manual" })).headers.get("Set-Cookie")).toBeNull();
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie } }), "__Host-rose_session")).toBe(false);
  });

  it("the enter response sets a scoped, short-lived handoff cookie", async () => {
    const { entered, set } = await enterWorkspace("attrs-co");
    expect(entered.status).toBe(200);
    expect(set).toMatch(/^__Secure-rose_handoff_[0-9a-f]{16}=[^;]+;/);
    expect(set).toMatch(/Domain=rose\.test/);
    expect(set).toMatch(/Path=\/auth\/handoff/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Max-Age=60/);
  });

  it("a handoff without its browser cookie starts no session and leaves the token unspent", async () => {
    const { entered, url, handoffCookie } = await enterWorkspace("nocookie-ws");
    expect(entered.status).toBe(200);
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual" }), "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie } }), "__Host-rose_session")).toBe(true);
  });

  it("two tabs entering workspaces at once get distinct handoff cookies that each work", async () => {
    const [tabA, tabB] = await Promise.all([enterWorkspace("tab-a-ws"), enterWorkspace("tab-b-ws")]);
    for (const { entered } of [tabA, tabB]) {
      expect(entered.status).toBe(200);
    }
    expect(tabA.handoffCookie).not.toBe(tabB.handoffCookie);
    expect(hasCookie(await SELF.fetch(tabA.url, { redirect: "manual", headers: { Cookie: tabB.handoffCookie } }), "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(tabB.url, { redirect: "manual", headers: { Cookie: tabA.handoffCookie } }), "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(tabA.url, { redirect: "manual", headers: { Cookie: tabA.handoffCookie } }), "__Host-rose_session")).toBe(true);
    expect(hasCookie(await SELF.fetch(tabB.url, { redirect: "manual", headers: { Cookie: tabB.handoffCookie } }), "__Host-rose_session")).toBe(true);
  });

  it("on the dev host shape (http rose.localhost:5174 to acme.rose.localhost:5174) the bound handoff works same-site and cross-site is refused", async () => {
    const worker = createTenantWorker({ modules: [notes] });
    const devEnv = { ...env, APP_BASE_DOMAIN: "rose.localhost" };
    const send: Send = async (req) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, devEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const { entered, url, set, handoffCookie } = await enterWorkspace("acme", { origin: "http://rose.localhost:5174", send });
    expect(entered.status).toBe(200);
    expect(url).toMatch(/^http:\/\/acme\.rose\.localhost:5174\/auth\/handoff\?token=/);
    expect(set).toMatch(/^rose_handoff_[0-9a-f]{16}=[^;]+;/);
    expect(set).toMatch(/Domain=rose\.localhost/);
    const visit = (site: string) => send(new Request(url, { redirect: "manual", headers: { Cookie: handoffCookie, "Sec-Fetch-Site": site } }));
    expect(hasCookie(await visit("cross-site"), "rose_session")).toBe(false);
    expect(hasCookie(await visit("same-site"), "rose_session")).toBe(true);
  });

  it("a handoff with another browser's nonce starts no session and leaves the token unspent", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "right-nonce" });
    const url = `${a.origin}/auth/handoff?token=${token}`;
    const handoffCookie = `${await handoffCookieName(token)}=right-nonce`;
    // The right cookie name carrying another browser's value: the bound hash does not match.
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: `${await handoffCookieName(token)}=someone-elses-nonce` } }), "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie } }), "__Host-rose_session")).toBe(true);
  });

  it("Sec-Fetch-Site cross-site starts no session even with the right cookie", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "nonce" });
    const url = `${a.origin}/auth/handoff?token=${token}`;
    const handoffCookie = `${await handoffCookieName(token)}=nonce`;
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie, "Sec-Fetch-Site": "cross-site" } }), "__Host-rose_session")).toBe(false);
    expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers: { Cookie: handoffCookie, "Sec-Fetch-Site": "same-site" } }), "__Host-rose_session")).toBe(true);
  });

  it("Sec-Fetch-Site same-origin and absent are allowed", async () => {
    const a = await createTestTenant(env, SELF);
    for (const site of ["same-origin", "none", undefined] as const) {
      const nonce = site ?? "absent";
      const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: nonce });
      const url = `${a.origin}/auth/handoff?token=${token}`;
      const headers: Record<string, string> = { Cookie: `${await handoffCookieName(token)}=${nonce}` };
      if (site) headers["Sec-Fetch-Site"] = site;
      expect(hasCookie(await SELF.fetch(url, { redirect: "manual", headers }), "__Host-rose_session")).toBe(true);
    }
  });

  it("the handoff response clears the handoff cookie it was sent, matching or not", async () => {
    const a = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: "nonce" });
    const url = `${a.origin}/auth/handoff?token=${token}`;
    const name = await handoffCookieName(token);
    for (const value of ["wrong", "nonce"]) {
      const clear = (await SELF.fetch(url, { redirect: "manual", headers: { Cookie: `${name}=${value}` } })).headers.getSetCookie().find((s) => s.startsWith(`${name}=`))!;
      expect(clear).toMatch(new RegExp(`^${name}=;`));
      expect(clear).toMatch(/Max-Age=0/);
      expect(clear).toMatch(/Domain=rose\.test/);
      expect(clear).toMatch(/Path=\/auth\/handoff/);
    }
  });

  it("an over-long handoff token is refused without reading, consuming or clearing anything", async () => {
    const a = await createTestTenant(env, SELF);
    const plant = async (token: string) => {
      const hash = await sha256Hex(`${token}.nonce`);
      await env.DB.prepare("INSERT INTO handoffs (token_hash, purpose, user_id, scope, expires_at) VALUES (?, 'session', ?, ?, ?)").bind(hash, a.userId, a.id, Date.now() + 60_000).run();
      return hash;
    };
    const visit = async (token: string) => SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: `${await handoffCookieName(token)}=nonce` } });
    const remaining = (hash: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE token_hash = ?").bind(hash).first<number>("n");
    const atCap = "a".repeat(HANDOFF_TOKEN_MAX);
    const overCap = "b".repeat(HANDOFF_TOKEN_MAX + 1);
    const atCapHash = await plant(atCap);
    const overCapHash = await plant(overCap);
    const refused = await visit(overCap);
    expect(refused.status).toBe(302);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(await remaining(overCapHash)).toBe(1);
    expect(hasCookie(await visit(atCap), "__Host-rose_session")).toBe(true);
    expect(await remaining(atCapHash)).toBe(0);
  });

  it("an over-long handoff cookie nonce matches nothing, is not consumed, and the cookie is cleared", async () => {
    const a = await createTestTenant(env, SELF);
    const long = "n".repeat(HANDOFF_TOKEN_MAX + 1);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id, binding: long });
    const name = await handoffCookieName(token);
    const res = await SELF.fetch(`${a.origin}/auth/handoff?token=${token}`, { redirect: "manual", headers: { Cookie: `${name}=${long}` } });
    expect(res.status).toBe(302);
    expect(hasCookie(res, "__Host-rose_session")).toBe(false);
    expect(res.headers.getSetCookie().find((s) => s.startsWith(`${name}=`))).toMatch(/Max-Age=0/);
    const hash = await sha256Hex(`${token}.${long}`);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE token_hash = ?").bind(hash).first<number>("n")).toBe(1);
  });

  it("the sign-in key verifies the email on the root host and returns a ticket", async () => {
    const { devKey } = await (await post(root, "/api/root/code/request", { email: "keyed@example.com" })).json<{ devKey: string }>();
    const verified = await (await post(root, "/api/root/code/link", { email: "keyed@example.com", key: devKey })).json<{ ticket: string; workspaces: unknown[] }>();
    expect(verified.workspaces).toEqual([]);
    expect((await post(root, "/api/root/enter", { ticket: verified.ticket, create: { name: "Key Co", slug: "key-co" } })).status).toBe(200);
  });

  it("parallel sign-in key verifications on the root host yield exactly one ticket", async () => {
    const email = "parlink@example.com";
    const { devKey } = await (await post(root, "/api/root/code/request", { email })).json<{ devKey: string }>();
    expect(devKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    const results = await Promise.all(Array.from({ length: 4 }, () => post(root, "/api/root/code/link", { email, key: devKey })));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  it("rejects reserved, malformed and taken addresses", async () => {
    await createTestTenant(env, SELF, { slug: "taken-co" });
    for (const slug of ["admin", "A B", "-x-", "a", "taken-co", "x.y"]) {
      const { devCode } = await (await post(root, "/api/root/code/request", { email: `s${Math.random()}@example.com` })).json<{ devCode: string }>();
      void devCode;
      const r = await (await SELF.fetch(`${root}/api/root/slug?slug=${encodeURIComponent(slug)}`)).json<{ available: boolean }>();
      expect(r.available, slug).toBe(false);
    }
  });

  describe("workspace cap per verified email", () => {
    const verify = async (email: string) => {
      const { devCode } = await (await post(root, "/api/root/code/request", { email })).json<{ devCode: string }>();
      return (await (await post(root, "/api/root/code/verify", { email, code: devCode })).json<{ ticket: string }>()).ticket;
    };
    const own = async (email: string, n: number, status?: string) => {
      const user = await ensureUser(env.DB, email);
      const slugs: string[] = [];
      for (let i = 0; i < n; i++) {
        const slug = `cap-${Math.random().toString(36).slice(2, 10)}`;
        const t = await createTenant(env.DB, { name: slug, slug });
        await addMembership(env.DB, t.id, user.id, "owner");
        if (status) await env.DB.prepare("UPDATE tenants SET status = ? WHERE id = ?").bind(status, t.id).run();
        slugs.push(slug);
      }
      return slugs;
    };
    const tenantCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())!.n;

    it("refuses create at the cap with 403, keeps the ticket usable, and writes nothing", async () => {
      const email = "capped@example.com";
      const [first] = await own(email, 5);
      const ticket = await verify(email);
      const before = await tenantCount();
      const res = await post(root, "/api/root/enter", { ticket, create: { name: "One Too Many", slug: "one-too-many" } });
      expect(res.status).toBe(403);
      expect(await tenantCount()).toBe(before);
      expect(await env.DB.prepare("SELECT 1 FROM tenants WHERE slug = 'one-too-many'").first()).toBeNull();
      // The rejection did not burn the ticket, and entering an existing workspace is not capped.
      expect((await post(root, "/api/root/enter", { ticket, slug: first })).status).toBe(200);
    });

    it("allows create below the cap", async () => {
      const email = "below@example.com";
      await own(email, 4);
      const res = await post(root, "/api/root/enter", { ticket: await verify(email), create: { name: "Fifth", slug: "fifth-ws" } });
      expect(res.status).toBe(200);
    });

    it("does not count workspaces being deleted, but counts pending-deletion and suspended ones", async () => {
      const email = "deleting@example.com";
      await own(email, 3);
      await own(email, 1, "deleting");
      await own(email, 1, "deleting");
      expect((await post(root, "/api/root/enter", { ticket: await verify(email), create: { name: "Ok Ws", slug: "ok-ws" } })).status).toBe(200);
      const other = "pending@example.com";
      await own(other, 3);
      await own(other, 1, "pending_deletion");
      await own(other, 1, "suspended");
      expect((await post(root, "/api/root/enter", { ticket: await verify(other), create: { name: "No Ws", slug: "no-ws" } })).status).toBe(403);
    });

    it("counts only owned workspaces", async () => {
      const email = "member-only@example.com";
      const user = await ensureUser(env.DB, email);
      for (let i = 0; i < 6; i++) {
        const slug = `mem-${Math.random().toString(36).slice(2, 10)}`;
        await addMembership(env.DB, (await createTenant(env.DB, { name: slug, slug })).id, user.id, "member");
      }
      expect((await post(root, "/api/root/enter", { ticket: await verify(email), create: { name: "Mine", slug: "mine-ws" } })).status).toBe(200);
    });

    it("parses MAX_WORKSPACES_PER_USER: any positive integer, otherwise 5", () => {
      const p = (v: string | undefined) => maxWorkspacesPerUser(v === undefined ? {} : { MAX_WORKSPACES_PER_USER: v });
      expect(p("1")).toBe(1);
      expect(p("1000000")).toBe(1_000_000);
      expect(p("12345678901")).toBe(12_345_678_901);
      for (const bad of [undefined, "", " ", "0", "-3", "2.5", "abc", "1e3", "0x10"]) expect(p(bad), String(bad)).toBe(5);
    });
  });

  it("root routes do not exist on tenant hosts", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await post(a.origin, "/api/root/code/request", { email: "x@example.com" })).status).toBe(404);
  });
});

describe("http hardening", () => {
  it("sets security headers and never caches API responses publicly", async () => {
    const a = await createTestTenant(env, SELF);
    const res = await a.fetch("/api/m/notes");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("ETag")).toBeTruthy();
    const again = await a.fetch("/api/m/notes", { headers: { "If-None-Match": res.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });

  it("does not leak internals on errors", async () => {
    const a = await createTestTenant(env, SELF);
    const res = await a.fetch("/api/m/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: undefined });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toMatch(/stack|sqlite|at \w+ \(/i);
  });

  it("caps page size", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/members?pageSize=100000")).status).toBe(422);
  });
});

describe("search patterns", () => {
  it("long and hostile search terms never reach SQLite as an over-long LIKE pattern", async () => {
    const { likePattern, likePrefix } = await import("../src/http/pagination");
    const enc = new TextEncoder();
    for (const q of ["%".repeat(40), "\\".repeat(40), "é".repeat(40), "a".repeat(40), "_%\\".repeat(13)]) {
      expect(enc.encode(likePattern(q)).length).toBeLessThanOrEqual(50);
      expect(enc.encode(likePrefix(q)).length).toBeLessThanOrEqual(50);
      expect(likePattern(q)).not.toMatch(/(^|[^\\])(\\\\)*\\%$/);
    }
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch(`/api/m/notes?q=${"x".repeat(41)}`)).status).toBe(200);
    expect((await a.fetch(`/api/members?q=${encodeURIComponent("%".repeat(40))}`)).status).toBe(200);
    expect((await a.fetch(`/api/members?q=${"x".repeat(41)}`)).status).toBe(422);
    expect((await a.fetch(`/api/audit?action=${"x".repeat(300)}`)).status).toBe(200);
  });

  it("a malformed Authorization header is never rescued by a valid cookie", async () => {
    const a = await createTestTenant(env, SELF);
    for (const h of ["Bearer", "Bearer ", "Basic abc", "bearer x", "x"]) {
      expect((await a.fetch("/api/members", { headers: { Authorization: h } })).status, h).toBe(401);
    }
  });
});

describe("abuse limits", () => {
  it("a NUL byte in a search term can not turn it into match-everything", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/invitations", { body: { email: "nul@example.com", role: "member" } });
    const r = await (await a.fetch("/api/invitations?q=zzz%00")).json<{ total: number }>();
    expect(r.total).toBe(0);
  });
});

describe("sort keys", () => {
  it("inherited object properties are not valid sort columns", async () => {
    const { orderBy } = await import("../src/http/pagination");
    for (const k of ["__proto__", "constructor", "toString", "-hasOwnProperty", "constructor.prototype"]) expect(orderBy(k, { name: "name" }, "created_at DESC")).toBe("created_at DESC");
    expect(orderBy("-name", { name: "name" }, "x")).toBe("name DESC");
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/members?sort=__proto__")).status).toBe(200);
    expect((await a.fetch("/api/members?sort=constructor")).status).toBe(200);
  });
});
