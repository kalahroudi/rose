// SPDX-License-Identifier: Apache-2.0
// Adversarial tests for operator-side tenant deletion and cancellation.
import { env, SELF } from "cloudflare:test";
import { createTenant } from "@rose/core/platform";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://admin.rose.test";
const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  SELF.fetch(ORIGIN + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { Origin: ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const errCode = async (r: Response) => ((await r.clone().json()) as { error?: { code: string } }).error?.code;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

/** An operator with a session of the given method and age, created directly (no sign-in rate limits). */
async function operator(role: "owner" | "operator", method: string, ageMs = 0): Promise<{ cookie: string; userId: string }> {
  const id = `us_${uniq()}`;
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(id, `${id}@ops.test`, t).run();
  await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES (?, ?, ?)").bind(id, role, t).run();
  return { cookie: await sessionFor(id, method, ageMs), userId: id };
}
async function sessionFor(userId: string, method: string, ageMs = 0): Promise<string> {
  // Mirrors how the core stores sessions (SHA-256 of the token only), without importing core internals.
  const token = `tok${uniq()}${crypto.randomUUID().replaceAll("-", "")}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const t = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, public_id, user_id, scope, method, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'platform', ?, ?, ?, ?)")
    .bind(hash, `ses_${uniq()}`, userId, method, t - ageMs, t, t + 86_400_000).run();
  return `__Host-rose_admin=${token}`;
}
const seed = async () => {
  const slug = `t${uniq()}`.slice(0, 30);
  return createTenant(env.DB, { name: slug, slug });
};
const row = (id: string) => env.DB.prepare("SELECT status, delete_after FROM tenants WHERE id = ?").bind(id).first<{ status: string; delete_after: number | null }>();
const purgeJobs = (id: string) => env.DB.prepare("SELECT run_after, status FROM jobs WHERE type = 'tenant.purge' AND json_extract(payload, '$.tenantId') = ?").bind(id).all<{ run_after: number; status: string }>();

describe("operator tenant deletion (adversarial)", () => {
  it("role operator gets 403 forbidden on delete and cancel even with a fresh passkey session, and nothing changes", async () => {
    const op = await operator("operator", "passkey");
    const owner = await operator("owner", "passkey");
    const t = await seed();
    for (const path of [`/api/tenants/${t.id}/delete`, `/api/tenants/${t.id}/delete/cancel`]) {
      const r = await call(path, { cookie: op.cookie, body: { confirm: t.slug } });
      expect(r.status, path).toBe(403);
      expect(await errCode(r)).toBe("forbidden");
    }
    expect((await row(t.id))!.status).toBe("active");
    // Owner puts it in pending; the operator still can not cancel.
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: owner.cookie, body: { confirm: t.slug } })).status).toBe(202);
    const r = await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: op.cookie, body: {} });
    expect(r.status).toBe(403);
    expect((await row(t.id))!.status).toBe("pending_deletion");
  });

  it("role operator learns nothing about existence: 403 for an unknown tenant id too", async () => {
    const op = await operator("operator", "passkey");
    const r = await call(`/api/tenants/tn_doesnotexist/delete`, { cookie: op.cookie, body: { confirm: "x" } });
    expect(r.status).toBe(403);
  });

  it("an owner needs a passkey session: code, test, empty and look-alike methods are reauth_required", async () => {
    const t = await seed();
    for (const method of ["code", "Passkey", "passkey ", "", "test"]) {
      const o = await operator("owner", method);
      for (const path of [`/api/tenants/${t.id}/delete`, `/api/tenants/${t.id}/delete/cancel`]) {
        const r = await call(path, { cookie: o.cookie, body: { confirm: t.slug } });
        expect(r.status, `${method} ${path}`).toBe(403);
        expect(await errCode(r), `${method} ${path}`).toBe("reauth_required");
      }
    }
    expect((await row(t.id))!.status).toBe("active");
  });

  it("an owner passkey session just past 10 minutes is reauth_required on delete and cancel", async () => {
    const t = await seed();
    const fresh = await operator("owner", "passkey");
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: fresh.cookie, body: { confirm: t.slug } })).status).toBe(202);
    const stale = await operator("owner", "passkey", 10 * 60_000 + 2000);
    for (const path of [`/api/tenants/${t.id}/delete`, `/api/tenants/${t.id}/delete/cancel`]) {
      const r = await call(path, { cookie: stale.cookie, body: { confirm: t.slug } });
      expect(r.status, path).toBe(403);
      expect(await errCode(r)).toBe("reauth_required");
    }
    expect((await row(t.id))!.status).toBe("pending_deletion");
  });

  it("an owner demoted to operator after signing in with a passkey loses the right immediately", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    await env.DB.prepare("UPDATE operators SET role = 'operator' WHERE user_id = ?").bind(o.userId).run();
    const r = await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } });
    expect(r.status).toBe(403);
    expect((await row(t.id))!.status).toBe("active");
  });

  it("delete enters a 48h grace with the purge held back; repeating it does not shorten the deadline", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    const before = Date.now();
    const r1 = await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } });
    expect(r1.status).toBe(202);
    const { deleteAfter } = (await r1.json()) as { deleteAfter: number };
    expect(deleteAfter).toBeGreaterThanOrEqual(before + 48 * 3_600_000);
    expect(deleteAfter).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000);
    expect(await row(t.id)).toEqual({ status: "pending_deletion", delete_after: deleteAfter });
    const r2 = await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } });
    expect([202, 409]).toContain(r2.status);
    expect((await row(t.id))!.delete_after).toBe(deleteAfter);
    for (const j of (await purgeJobs(t.id)).results) expect(j.run_after).toBeGreaterThanOrEqual(deleteAfter - 1000);
  });

  it("a typo in the confirmation changes nothing", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    for (const confirm of [t.slug.toUpperCase(), ` ${t.slug}`, `${t.slug} `, t.name + "x", t.id]) {
      expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm } })).status, confirm).toBe(422);
    }
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: {} })).status).toBe(422);
    expect(await row(t.id)).toEqual({ status: "active", delete_after: null });
    expect((await purgeJobs(t.id)).results).toEqual([]);
  });

  it("pending tenants can not be revived or altered by bulk actions (ids or filter)", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } })).status).toBe(202);
    const bulk = async (body: unknown) => ((await (await call("/api/tenants/bulk", { cookie: o.cookie, body })).json()) as { affected: number }).affected;
    expect(await bulk({ action: "resume", ids: [t.id] })).toBe(0);
    expect(await bulk({ action: "resume", filter: { q: t.slug, status: "pending_deletion" } })).toBe(0);
    expect(await bulk({ action: "resume", filter: { q: t.slug, status: "" } })).toBe(0);
    // Suspend-then-resume must not be a backdoor either.
    expect(await bulk({ action: "suspend", ids: [t.id] })).toBe(0);
    expect(await bulk({ action: "resume", ids: [t.id] })).toBe(0);
    expect((await row(t.id))!.status).toBe("pending_deletion");
  });

  it("PATCHing a pending tenant can not change its status back to active", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } })).status).toBe(202);
    await call(`/api/tenants/${t.id}`, { method: "PATCH", cookie: o.cookie, body: { status: "active", delete_after: null } });
    expect((await row(t.id))!.status).toBe("pending_deletion");
  });

  it("cancel restores active, clears the deadline and removes the held purge job; cancel on a non-pending tenant is 409", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: o.cookie, body: {} })).status).toBe(409);
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } })).status).toBe(202);
    expect((await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } })).status).toBeLessThan(500);
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: o.cookie, body: {} })).status).toBe(200);
    expect(await row(t.id)).toEqual({ status: "active", delete_after: null });
    expect((await purgeJobs(t.id)).results.filter((j) => j.status === "queued")).toEqual([]);
  });

  it("cancel can not pull a tenant back once the purge has begun", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    await env.DB.prepare("UPDATE tenants SET status = 'deleting', delete_after = ? WHERE id = ?").bind(Date.now() - 1, t.id).run();
    expect((await call(`/api/tenants/${t.id}/delete/cancel`, { cookie: o.cookie, body: {} })).status).toBe(409);
    expect((await row(t.id))!.status).toBe("deleting");
    // And re-requesting deletion does not reset it to pending.
    const r = await call(`/api/tenants/${t.id}/delete`, { cookie: o.cookie, body: { confirm: t.slug } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await row(t.id))!.status).toBe("deleting");
  });

  it("unknown tenant id with a fresh owner session is 404 on both routes", async () => {
    const o = await operator("owner", "passkey");
    expect((await call(`/api/tenants/tn_nope/delete`, { cookie: o.cookie, body: { confirm: "x" } })).status).toBe(404);
    expect((await call(`/api/tenants/tn_nope/delete/cancel`, { cookie: o.cookie, body: {} })).status).toBe(404);
  });

  it("cross-site requests to delete/cancel are refused even with a fresh owner passkey session", async () => {
    const t = await seed();
    const o = await operator("owner", "passkey");
    const r = await SELF.fetch(`${ORIGIN}/api/tenants/${t.id}/delete`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: o.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: t.slug }),
    });
    expect(r.status).toBe(403);
    expect((await row(t.id))!.status).toBe("active");
  });
});
