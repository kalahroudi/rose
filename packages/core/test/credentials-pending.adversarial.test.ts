// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { beginLogin, type PasskeySite } from "../src/auth/passkeys";
import { issueLoginCode } from "../src/control/otp";
import { createHandoff, createSession } from "../src/control/sessions";
import { requestTenantDeletion, type TenantStatus } from "../src/control/tenants";
import { createTestTenant } from "../src/testing";

type NonActiveStatus = Exclude<TenantStatus, "active">;
const REFUSAL: Record<NonActiveStatus, string> = {
  pending_deletion: "This workspace is scheduled for deletion.",
  suspended: "This workspace is suspended. Contact support.",
  deleting: "Not found.",
};

const count = (table: string, scope: string) =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope = ?`).bind(scope).first<{ n: number }>().then((r) => r?.n ?? 0);

const setStatus = (id: string, status: TenantStatus) => env.DB.prepare("UPDATE tenants SET status = ? WHERE id = ?").bind(status, id).run();

const site = (scope: string): PasskeySite => ({ scope, rpId: "login.rose.test", origin: "https://login.rose.test", rpName: "Test" });

const nonActiveStatuses: NonActiveStatus[] = ["pending_deletion", "suspended", "deleting"];

describe("no credential row is created for a non-active tenant (adversarial)", () => {
  it.each(nonActiveStatuses)("createSession refuses a %s tenant and inserts no row", async (status) => {
    const a = await createTestTenant(env, SELF);
    await setStatus(a.id, status);
    const before = await count("sessions", a.id);
    await expect(createSession(env.DB, { userId: a.userId, scope: a.id, method: "code" })).rejects.toThrow(REFUSAL[status]);
    expect(await count("sessions", a.id)).toBe(before);
  });

  it.each(nonActiveStatuses)("createHandoff refuses a %s tenant and inserts no row", async (status) => {
    const a = await createTestTenant(env, SELF);
    await setStatus(a.id, status);
    const before = await count("handoffs", a.id);
    await expect(createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id })).rejects.toThrow(REFUSAL[status]);
    expect(await count("handoffs", a.id)).toBe(before);
  });

  it.each(nonActiveStatuses)("issueLoginCode refuses a %s tenant and inserts no row", async (status) => {
    const a = await createTestTenant(env, SELF);
    await setStatus(a.id, status);
    const before = await count("login_codes", a.id);
    await expect(issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1")).rejects.toThrow(REFUSAL[status]);
    expect(await count("login_codes", a.id)).toBe(before);
  });

  it.each(nonActiveStatuses)("beginLogin refuses a %s tenant and inserts no challenge row", async (status) => {
    const a = await createTestTenant(env, SELF);
    await setStatus(a.id, status);
    const before = await count("webauthn_challenges", a.id);
    await expect(beginLogin(env.DB, site(a.id))).rejects.toThrow(REFUSAL[status]);
    expect(await count("webauthn_challenges", a.id)).toBe(before);
  });

  it("a login code is not created for a pending tenant while the host cache still says active", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/bootstrap", { cookie: null });
    await requestTenantDeletion(env.DB, a.id);
    const before = await count("login_codes", a.id);
    const req = await a.fetch("/api/auth/code/request", { cookie: null, body: { email: a.email } });
    expect(req.status).toBe(403);
    expect(await count("login_codes", a.id)).toBe(before);
  });
});

describe("credentials for active tenants and non-tenant scopes still work", () => {
  it("createSession, createHandoff, issueLoginCode and beginLogin succeed for an active tenant", async () => {
    const a = await createTestTenant(env, SELF);
    const sessions = await count("sessions", a.id);
    await expect(createSession(env.DB, { userId: a.userId, scope: a.id, method: "code" })).resolves.toBeTruthy();
    expect(await count("sessions", a.id)).toBe(sessions + 1);
    const handoffs = await count("handoffs", a.id);
    await expect(createHandoff(env.DB, { purpose: "session", userId: a.userId, scope: a.id })).resolves.toBeTruthy();
    expect(await count("handoffs", a.id)).toBe(handoffs + 1);
    const codes = await count("login_codes", a.id);
    await expect(issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1")).resolves.toBeTruthy();
    expect(await count("login_codes", a.id)).toBe(codes + 1);
    const challenges = await count("webauthn_challenges", a.id);
    await expect(beginLogin(env.DB, site(a.id))).resolves.toBeTruthy();
    expect(await count("webauthn_challenges", a.id)).toBe(challenges + 1);
  });

  it.each(["platform", "root"] as const)("createSession, createHandoff, issueLoginCode and beginLogin succeed for scope %s", async (scope) => {
    const a = await createTestTenant(env, SELF);
    const sessions = await count("sessions", scope);
    await expect(createSession(env.DB, { userId: a.userId, scope, method: "code" })).resolves.toBeTruthy();
    expect(await count("sessions", scope)).toBe(sessions + 1);
    const handoffs = await count("handoffs", scope);
    await expect(createHandoff(env.DB, { purpose: "session", userId: a.userId, scope })).resolves.toBeTruthy();
    expect(await count("handoffs", scope)).toBe(handoffs + 1);
    const codes = await count("login_codes", scope);
    await expect(issueLoginCode(env.DB, env.ROSE_MASTER_KEY, scope, a.email, "127.0.0.1")).resolves.toBeTruthy();
    expect(await count("login_codes", scope)).toBe(codes + 1);
    const challenges = await count("webauthn_challenges", scope);
    await expect(beginLogin(env.DB, site(scope))).resolves.toBeTruthy();
    expect(await count("webauthn_challenges", scope)).toBe(challenges + 1);
  });

  it("issueLoginCode keeps its rate-limit behaviour for an active tenant", async () => {
    const a = await createTestTenant(env, SELF);
    const first = await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1");
    expect(first).toBeTruthy();
    const second = await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1");
    expect(second).toBeUndefined();
    expect(await count("login_codes", a.id)).toBe(1);
  });
});

describe("deletion racing credential creation (adversarial)", () => {
  it("no session or login code survives for the pending tenant", async () => {
    const a = await createTestTenant(env, SELF);
    await Promise.allSettled(
      Array.from({ length: 20 }, () => [
        requestTenantDeletion(env.DB, a.id),
        createSession(env.DB, { userId: a.userId, scope: a.id, method: "code" }),
        issueLoginCode(env.DB, env.ROSE_MASTER_KEY, a.id, a.email, "127.0.0.1"),
      ]).flat(),
    );
    expect(await env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(a.id).first<{ status: string }>()).toEqual({ status: "pending_deletion" });
    expect(await count("sessions", a.id)).toBe(0);
    expect(await count("login_codes", a.id)).toBe(0);
  });
});
