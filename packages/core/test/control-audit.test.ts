// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listPlatformAudit, writePlatformAudit } from "../src/control/audit";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM platform_audit").run();
});

describe("writePlatformAudit", () => {
  it("serialises meta to JSON and stores the other fields", async () => {
    await writePlatformAudit(env.DB, { actor: "actor-1", action: "tenant.suspend", target: "tn_1", meta: { reason: "abuse", n: 2 }, ip: "1.2.3.4" });
    const rows = await env.DB.prepare("SELECT * FROM platform_audit WHERE actor = 'actor-1'").all<{ target: string; meta: string; ip: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.target).toBe("tn_1");
    expect(rows.results[0]!.ip).toBe("1.2.3.4");
    expect(JSON.parse(rows.results[0]!.meta)).toEqual({ reason: "abuse", n: 2 });
  });

  it("writes nulls for absent target, meta and ip", async () => {
    await writePlatformAudit(env.DB, { actor: "actor-2", action: "no.meta" });
    const rows = await env.DB.prepare("SELECT * FROM platform_audit WHERE actor = 'actor-2'").all<{ target: string | null; meta: string | null; ip: string | null }>();
    expect(rows.results[0]).toMatchObject({ target: null, meta: null, ip: null });
  });
});

describe("listPlatformAudit", () => {
  it("returns newest first and filters by action prefix", async () => {
    await writePlatformAudit(env.DB, { actor: "a", action: "member.join" });
    await writePlatformAudit(env.DB, { actor: "a", action: "member.remove" });
    await writePlatformAudit(env.DB, { actor: "b", action: "tenant.suspend" });
    await env.DB.prepare("UPDATE platform_audit SET at = ? WHERE actor = ?").bind(Date.now() - 3000, "a").run();
    await env.DB.prepare("UPDATE platform_audit SET at = ? WHERE actor = ?").bind(Date.now() - 2000, "b").run();

    const all = await listPlatformAudit(env.DB, { page: 1, pageSize: 25, q: "", sort: "" });
    expect(all.total).toBe(3);
    expect(all.items[0]!.action).toBe("tenant.suspend");

    const joins = await listPlatformAudit(env.DB, { page: 1, pageSize: 25, q: "", sort: "", action: "member." });
    expect(joins.total).toBe(2);
    expect(joins.items.map((e) => e.action).sort()).toEqual(["member.join", "member.remove"]);
  });

  it("searches actor, target and action, and paginates", async () => {
    await writePlatformAudit(env.DB, { actor: "needle-actor", action: "x", target: "t-1" });
    await writePlatformAudit(env.DB, { actor: "other", action: "needle-action", target: "t-2" });
    await writePlatformAudit(env.DB, { actor: "other", action: "y", target: "needle-target" });
    await writePlatformAudit(env.DB, { actor: "other", action: "y", target: "t-3" });
    await writePlatformAudit(env.DB, { actor: "filler-1", action: "z", target: "t-4" });
    await writePlatformAudit(env.DB, { actor: "filler-2", action: "z", target: "t-5" });
    await writePlatformAudit(env.DB, { actor: "filler-3", action: "z", target: "t-6" });

    const byQ = await listPlatformAudit(env.DB, { page: 1, pageSize: 25, q: "needle", sort: "" });
    expect(byQ.total).toBe(3);

    const page = await listPlatformAudit(env.DB, { page: 2, pageSize: 2, q: "", sort: "" });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(7);
  });
});
