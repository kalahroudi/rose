// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issueLoginCode, verifyLoginCode } from "../src/control/otp";
import { consumeHandoff, createHandoff, createSession, readSession } from "../src/control/sessions";
import { createTestTenant } from "../src/testing";

const post = (origin: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

describe("email sign-in codes", () => {
  it("signs a member in and sets a host-bound cookie", async () => {
    const a = await createTestTenant(env, SELF);
    const req = (await (await post(a.origin, "/api/auth/code/request", { email: a.email.toUpperCase() })).json()) as { devCode: string };
    expect(req.devCode).toMatch(/^\d{6}$/);
    const res = await post(a.origin, "/api/auth/code/verify", { email: a.email, code: req.devCode });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-rose_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Domain=/i);
    const boot = (await (await a.fetch("/api/bootstrap", { cookie: cookieOf(res) })).json()) as { session: { user: { email: string } } };
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
    const { devCode } = (await (await post(a.origin, "/api/auth/code/request", { email: a.email })).json()) as { devCode: string };
    expect((await post(b.origin, "/api/auth/code/verify", { email: a.email, code: devCode })).status).toBe(401);
    expect((await post(a.origin, "/api/auth/code/verify", { email: a.email, code: devCode })).status).toBe(200);
  });

  it("codes are single use, expire, and lock after five wrong guesses", async () => {
    const key = env.ROSE_MASTER_KEY;
    const code = await issueLoginCode(env.DB, key, "s1", "u@example.com");
    expect(await verifyLoginCode(env.DB, key, "s1", "u@example.com", code)).toBe(true);
    expect(await verifyLoginCode(env.DB, key, "s1", "u@example.com", code)).toBe(false);

    const second = await issueLoginCode(env.DB, key, "s2", "u@example.com");
    const wrong = second === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await verifyLoginCode(env.DB, key, "s2", "u@example.com", wrong)).toBe(false);
    expect(await verifyLoginCode(env.DB, key, "s2", "u@example.com", second)).toBe(false);

    const third = await issueLoginCode(env.DB, key, "s3", "u@example.com");
    await env.DB.prepare("UPDATE login_codes SET expires_at = 1 WHERE scope = 's3'").run();
    expect(await verifyLoginCode(env.DB, key, "s3", "u@example.com", third)).toBe(false);
  });

  it("limits how many codes can be requested", async () => {
    for (let i = 0; i < 5; i++) await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s4", "u@example.com");
    await expect(issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s4", "u@example.com")).rejects.toThrow(/Too many/);
  });

  it("stores only keyed hashes of codes and hashes of session tokens", async () => {
    const code = await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, "s5", "u@example.com");
    const row = await env.DB.prepare("SELECT code_hash FROM login_codes WHERE scope = 's5'").first<{ code_hash: string }>();
    expect(row!.code_hash).not.toContain(code);
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
    const { devCode } = (await (await post(a.origin, "/api/auth/code/request", { email: "new@example.com" })).json()) as { devCode: string };
    const res = await post(a.origin, "/api/auth/code/verify", { email: "new@example.com", code: devCode });
    expect(res.status).toBe(200);
    const members = (await (await a.fetch("/api/members?q=new@")).json()) as { items: { role: string }[]; total: number };
    expect(members.total).toBe(1);
    expect(members.items[0]!.role).toBe("member");
    expect(((await (await a.fetch("/api/invitations")).json()) as { total: number }).total).toBe(0);
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

  it("a handoff for tenant A does not sign you in to tenant B", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    const token = await createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id });
    const res = await SELF.fetch(`${b.origin}/auth/handoff?token=${token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("self-service signup on the root host", () => {
  const root = `https://${env.APP_BASE_DOMAIN}`;

  it("verifies the email, creates a workspace and hands the session to its host", async () => {
    const { devCode } = (await (await post(root, "/api/root/code/request", { email: "founder@example.com" })).json()) as { devCode: string };
    const verified = (await (await post(root, "/api/root/code/verify", { email: "founder@example.com", code: devCode })).json()) as { ticket: string; workspaces: unknown[] };
    expect(verified.workspaces).toEqual([]);
    const entered = await post(root, "/api/root/enter", { ticket: verified.ticket, create: { name: "Acme Inc", slug: "acme-inc" } });
    expect(entered.status).toBe(200);
    const { url } = (await entered.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/acme-inc\.rose\.test\/auth\/handoff\?token=/);
    const landed = await SELF.fetch(url, { redirect: "manual" });
    const cookie = cookieOf(landed);
    expect(cookie).toMatch(/^__Host-rose_session=/);
    const boot = (await (await SELF.fetch("https://acme-inc.rose.test/api/bootstrap", { headers: { Cookie: cookie } })).json()) as { session: { role: string } };
    expect(boot.session.role).toBe("owner");
    // The ticket and the handoff are both spent.
    expect((await post(root, "/api/root/enter", { ticket: verified.ticket, slug: "acme-inc" })).status).toBe(401);
    expect((await SELF.fetch(url, { redirect: "manual" })).headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects reserved, malformed and taken addresses", async () => {
    await createTestTenant(env, SELF, { slug: "taken-co" });
    for (const slug of ["admin", "A B", "-x-", "a", "taken-co", "x.y"]) {
      const { devCode } = (await (await post(root, "/api/root/code/request", { email: `s${Math.random()}@example.com` })).json()) as { devCode: string };
      void devCode;
      const r = (await (await SELF.fetch(`${root}/api/root/slug?slug=${encodeURIComponent(slug)}`)).json()) as { available: boolean };
      expect(r.available, slug).toBe(false);
    }
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
    const r = (await (await a.fetch("/api/invitations?q=zzz%00")).json()) as { total: number };
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
