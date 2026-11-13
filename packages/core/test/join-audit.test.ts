// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestTenant, type TestTenant } from "../src/testing";

const post = (origin: string, path: string, body: unknown) =>
  SELF.fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });

type Entry = { actor: string; action: string; target?: string; meta?: unknown };
const joins = async (t: TestTenant) => ((await (await t.fetch("/api/audit?action=member.join&pageSize=100")).json()) as { items: Entry[] }).items;

async function signInAs(t: TestTenant, email: string): Promise<Response> {
  const { devCode } = (await (await post(t.origin, "/api/auth/code/request", { email })).json()) as { devCode: string };
  return post(t.origin, "/api/auth/code/verify", { email, code: devCode });
}

describe("member.join audit and owner notification", () => {
  it("records the role of an invited owner and member, once each", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/invitations", { body: { email: "co-owner@example.com", role: "owner" } });
    await a.fetch("/api/invitations", { body: { email: "plain@example.com", role: "member" } });
    expect((await signInAs(a, "co-owner@example.com")).status).toBe(200);
    expect((await signInAs(a, "plain@example.com")).status).toBe(200);
    // Signing in again is not a join.
    expect((await signInAs(a, "plain@example.com")).status).toBe(200);
    const entries = await joins(a);
    const owner = entries.filter((e) => e.actor === "co-owner@example.com");
    const member = entries.filter((e) => e.actor === "plain@example.com");
    expect(owner).toHaveLength(1);
    expect(member).toHaveLength(1);
    expect(JSON.stringify(owner[0]!.meta)).toContain("owner");
    expect(JSON.stringify(member[0]!.meta)).toContain("member");
  });

  it("a join is written only to the workspace it happened in", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/invitations", { body: { email: "only-a@example.com", role: "member" } });
    await signInAs(a, "only-a@example.com");
    expect((await joins(a)).some((e) => e.actor === "only-a@example.com")).toBe(true);
    expect(JSON.stringify(await joins(b))).not.toContain("only-a@example.com");
  });

  it("an address without an invitation is refused and leaves no join entry", async () => {
    const a = await createTestTenant(env, SELF);
    const res = await post(a.origin, "/api/auth/code/request", { email: "intruder@example.com" });
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.stringify(await joins(a))).not.toContain("intruder@example.com");
  });

  it("an invitation in one workspace does not admit (or audit) the person in another", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    await a.fetch("/api/invitations", { body: { email: "cross@example.com", role: "owner" } });
    const res = await post(b.origin, "/api/auth/code/request", { email: "cross@example.com" });
    expect(await res.json()).toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id IN (SELECT id FROM users WHERE email = 'cross@example.com')").bind(b.id).first()).toBeNull();
    expect(JSON.stringify(await joins(b))).not.toContain("cross@example.com");
  });

  it("joining with several existing owners still succeeds when notification email fails", async () => {
    const a = await createTestTenant(env, SELF);
    for (const email of ["second-owner@example.com", "third-owner@example.com"]) {
      await a.fetch("/api/invitations", { body: { email, role: "owner" } });
      expect((await signInAs(a, email)).status).toBe(200);
    }
    await a.fetch("/api/invitations", { body: { email: "late@example.com", role: "member" } });
    const res = await signInAs(a, "late@example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-rose_session=/);
    expect((await joins(a)).filter((e) => e.actor === "late@example.com")).toHaveLength(1);
  });

  it("the audit log stays readable only by those with audit permission", async () => {
    const a = await createTestTenant(env, SELF);
    await a.fetch("/api/invitations", { body: { email: "m@example.com", role: "member" } });
    const res = await signInAs(a, "m@example.com");
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    expect((await a.fetch("/api/audit?action=member.join", { cookie })).status).toBe(403);
    expect((await a.fetch("/api/audit?action=member.join", { cookie: null })).status).toBe(401);
  });

  it("self-serve signup records the founder's owner join in the new workspace's log", async () => {
    const root = `https://${env.APP_BASE_DOMAIN}`;
    const email = "founder-audit@example.com";
    const { devCode } = (await (await post(root, "/api/root/code/request", { email })).json()) as { devCode: string };
    const { ticket } = (await (await post(root, "/api/root/code/verify", { email, code: devCode })).json()) as { ticket: string };
    const entered = await post(root, "/api/root/enter", { ticket, create: { name: "Audit Co", slug: "audit-co" } });
    expect(entered.status).toBe(200);
    const { url } = (await entered.json()) as { url: string };
    const cookie = (((await SELF.fetch(url, { redirect: "manual" })).headers.get("Set-Cookie") ?? "").split(";")[0])!;
    const log = (await (await SELF.fetch("https://audit-co.rose.test/api/audit?action=member.join", { headers: { Cookie: cookie } })).json()) as { items: Entry[] };
    expect(log.items).toHaveLength(1);
    expect(JSON.stringify(log.items[0]!.meta)).toContain("owner");
  });
});
