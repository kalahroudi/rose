// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createTenantWorker } from "../src";
import { createSession } from "../src/control/sessions";
import { addMembership, ensureUser } from "../src/control/users";
import { createTestTenant, type TestTenant } from "../src/testing";
import { noneAttestation } from "./passkey-attestation";
import { notes } from "./worker";

const byText = (a: string, b: string) => a.localeCompare(b);

const addPasskey = (t: TestTenant, credentialId: string, rpId: string) =>
  env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, ?, ?, 'k', ?)").bind(credentialId, t.userId, t.id, rpId, Date.now()).run();

const addDomain = (t: TestTenant, hostname: string, status: string) =>
  env.DB.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES (?, ?, ?, 0, 0)").bind(hostname, t.id, status).run();

const passkeyList = async (t: TestTenant, cookie: string) =>
  (await t.fetch("/api/auth/passkeys", { cookie })).json<{ items: { id: string; name: string; host: string; usable: boolean }[] }>();

const freshCodeCookie = async (t: TestTenant) => `__Host-rose_session=${(await createSession(env.DB, { userId: t.userId, scope: t.id, method: "code" })).token}`;

describe("passkeys on a host the workspace no longer serves", () => {
  it("do not count: a fresh code session can enrol, remove, invite an owner and delete the workspace", async () => {
    const t = await createTestTenant(env, SELF);
    await addPasskey(t, "cred-gone", "gone.custom.example");
    const cookie = await freshCodeCookie(t);

    const list = await passkeyList(t, cookie);
    expect(list.items.map(({ id, host, usable }) => ({ id, host, usable }))).toEqual([
      { id: "cred-gone", host: "gone.custom.example", usable: false },
    ]);
    const boot = await (await t.fetch("/api/bootstrap", { cookie })).json<{ session: { hasPasskey: boolean } }>();
    expect(boot.session.hasPasskey).toBe(false);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(200);
    expect((await t.fetch("/api/invitations", { cookie, body: { email: "co-owner@x.example", role: "owner" } })).status).toBe(201);
    expect((await t.fetch("/api/auth/passkeys/cred-gone", { cookie, method: "DELETE" })).status).toBe(200);
    expect((await t.fetch("/api/workspace/delete", { cookie, body: { confirm: t.slug } })).status).toBe(202);
  });

  it("still count while their host is an active domain of the workspace", async () => {
    const t = await createTestTenant(env, SELF);
    await addDomain(t, "live.custom.example", "active");
    await addPasskey(t, "cred-live", "live.custom.example");
    const cookie = await freshCodeCookie(t);

    const list = await passkeyList(t, cookie);
    expect(list.items.map(({ id, host, usable }) => ({ id, host, usable }))).toEqual([{ id: "cred-live", host: "live.custom.example", usable: true }]);
    const boot = await (await t.fetch("/api/bootstrap", { cookie })).json<{ session: { hasPasskey: boolean } }>();
    expect(boot.session.hasPasskey).toBe(true);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(403);
    expect((await t.fetch("/api/invitations", { cookie, body: { email: "co-owner@x.example", role: "owner" } })).status).toBe(403);
    expect((await t.fetch("/api/auth/passkeys/cred-live", { cookie, method: "DELETE" })).status).toBe(403);
    expect((await t.fetch("/api/workspace/delete", { cookie, body: { confirm: t.slug } })).status).toBe(403);
  });

  it.each(["pending", "active-then-pending"])("still count while their host is a %s domain of the workspace", async (kind) => {
    const t = await createTestTenant(env, SELF);
    const host = `${kind}.${t.slug}.custom.example`;
    await addDomain(t, host, kind === "pending" ? "pending" : "active");
    if (kind !== "pending") await env.DB.prepare("UPDATE tenant_domains SET status = 'pending' WHERE hostname = ?").bind(host).run();
    await addPasskey(t, `cred-${kind}-${t.slug}`, host);
    const cookie = await freshCodeCookie(t);

    const list = await passkeyList(t, cookie);
    expect(list.items.map(({ id, host, usable }) => ({ id, host, usable }))).toEqual([{ id: `cred-${kind}-${t.slug}`, host, usable: true }]);
    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(403);
    expect((await t.fetch("/api/workspace/delete", { cookie, body: { confirm: t.slug } })).status).toBe(403);
  });

  it("limits passkey registration per person and caps passkeys at 50", async () => {
    const t = await createTestTenant(env, SELF);
    await addPasskey(t, `cred-limit-${t.slug}`, "gone.custom.example");
    const cookie = await freshCodeCookie(t);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await t.fetch("/api/auth/passkey/register/verify", { cookie, body: {} })).status).toBe(429);

    const u = await createTestTenant(env, SELF);
    for (let i = 0; i < 49; i++) await addPasskey(u, `cred-fill-${u.slug}-${i}`, "gone.custom.example");
    const ucookie = await freshCodeCookie(u);
    const worker = createTenantWorker({ modules: [notes] });
    const post = (path: string, body: unknown) => new Request(u.origin + path, { method: "POST", headers: { Origin: u.origin, Cookie: ucookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const begin = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(post("/api/auth/passkey/register/options", {}), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.json<{ id: string; options: { challenge: string } }>();
    };
    // Both challenges are issued while no passkey counts yet; the first enrolment then makes one count.
    const begun = [await begin(), await begin()];
    const enrol = async () => {
      const ctx = createExecutionContext();
      const ch = begun.shift()!;
      const res = await worker.fetch(post("/api/auth/passkey/register/verify", { id: ch.id, name: "Laptop", response: await noneAttestation(u.host, u.origin, ch.options.challenge) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    expect(await enrol()).toBe(200);
    await env.DB.prepare("UPDATE passkeys SET rp_id = 'gone.custom.example' WHERE user_id = ? AND scope = ?").bind(u.userId, u.id).run();
    expect(await enrol()).toBe(409);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND scope = ?").bind(u.userId, u.id).first<{ n: number }>();
    expect(count?.n).toBe(50);
  });

  it("enrolling one after the move emails the person and the workspace admins", async () => {
    const t = await createTestTenant(env, SELF);
    const admin = await ensureUser(env.DB, `admin@${t.slug}.example`);
    const member = await ensureUser(env.DB, `member@${t.slug}.example`);
    await addMembership(env.DB, t.id, admin.id, "admin");
    await addMembership(env.DB, t.id, member.id, "member");
    await addPasskey(t, "cred-gone", "gone.custom.example");
    const cookie = await freshCodeCookie(t);
    const worker = createTenantWorker({ modules: [notes] });
    const call = async (path: string, body: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(t.origin + path, { method: "POST", headers: { Origin: t.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const begin = await (await call("/api/auth/passkey/register/options", {})).json<{ id: string; options: { challenge: string } }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call("/api/auth/passkey/register/verify", { id: begin.id, name: "Laptop", response: await noneAttestation(t.host, t.origin, begin.options.challenge) });
    const sent = log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("New passkey for"));
    log.mockRestore();

    expect(res.status).toBe(200);
    expect(sent.map((line) => /To: (\S+)/.exec(line)?.[1] ?? "").sort(byText)).toEqual([`admin@${t.slug}.example`, t.email].sort(byText));
    const list = await passkeyList(t, cookie);
    expect(list.items.map(({ name, host, usable }) => ({ name, host, usable }))).toEqual([
      { name: "Passkey", host: "gone.custom.example", usable: false },
      { name: "Laptop", host: t.host, usable: true },
    ]);
  });

  it("an active domain of another workspace does not make a passkey usable here", async () => {
    const t = await createTestTenant(env, SELF);
    const other = await createTestTenant(env, SELF);
    await addDomain(other, "theirs.custom.example", "active");
    await addPasskey(t, "cred-theirs", "theirs.custom.example");
    const cookie = await freshCodeCookie(t);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(200);
  });
});
