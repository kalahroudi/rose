// SPDX-License-Identifier: Apache-2.0
// Adversarial: migration 0002 rebuilds `tenants`; rows that reference it must survive and
// the foreign keys must still work afterwards.
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Migration = { name: string; queries: string[] };
const DB = (env as unknown as { DB: D1Database }).DB;
const ALL = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;

async function resetDatabase(): Promise<void> {
  const tables = await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  // Children first so foreign keys never block a drop.
  const order = ["tenant_domains", "memberships", "invitations", "sessions", "passkeys", "handoffs", "operators"];
  const names = tables.results.map((t) => t.name).sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  for (const n of names) await DB.prepare(`DROP TABLE IF EXISTS "${n}"`).run();
}

describe("migration 0002 (adversarial)", () => {
  it("preserves tenant_domains, memberships and invitations, and keeps foreign keys pointing at tenants", async () => {
    const m1 = ALL.find((m) => m.name.startsWith("0001"))!;
    expect(ALL.some((m) => m.name.startsWith("0002"))).toBe(true);
    await resetDatabase();
    await applyD1Migrations(DB, [m1]);

    const t = Date.now();
    await DB.batch([
      DB.prepare("INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at) VALUES ('tn_a', 'a', 'A', 'active', 'free', ?, ?)").bind(t, t),
      DB.prepare("INSERT INTO tenants (id, slug, name, status, plan, created_at, updated_at) VALUES ('tn_b', 'b', 'B', 'deleting', 'pro', ?, ?)").bind(t, t),
      DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_1', 'one@x.test', ?)").bind(t),
      DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_2', 'two@x.test', ?)").bind(t),
      DB.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES ('a.example', 'tn_a', 'active', ?, ?)").bind(t, t),
      DB.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES ('b.example', 'tn_b', 'pending', ?, ?)").bind(t, t),
      DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES ('tn_a', 'us_1', 'owner', ?)").bind(t),
      DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES ('tn_b', 'us_2', 'admin', ?)").bind(t),
      DB.prepare("INSERT INTO invitations (id, tenant_id, email, role, invited_by, expires_at, created_at) VALUES ('in_1', 'tn_a', 'new@x.test', 'member', 'us_1', ?, ?)").bind(t + 86_400_000, t),
    ]);
    const snap = async () => ({
      domains: (await DB.prepare("SELECT * FROM tenant_domains ORDER BY hostname").all()).results,
      members: (await DB.prepare("SELECT * FROM memberships ORDER BY tenant_id").all()).results,
      invites: (await DB.prepare("SELECT * FROM invitations ORDER BY id").all()).results,
      tenants: (await DB.prepare("SELECT id, slug, name, status, plan, created_at, updated_at FROM tenants ORDER BY id").all()).results,
    });
    const before = await snap();

    await applyD1Migrations(DB, ALL);

    expect(await snap()).toEqual(before);
    const cols = (await DB.prepare("PRAGMA table_info(tenants)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toContain("delete_after");
    // No leftover backup tables.
    expect((await DB.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_bak_%'").all()).results).toEqual([]);
    // The new status is accepted, nonsense is still rejected.
    await DB.prepare("UPDATE tenants SET status = 'pending_deletion', delete_after = ? WHERE id = 'tn_a'").bind(t).run();
    await expect(DB.prepare("UPDATE tenants SET status = 'bogus' WHERE id = 'tn_a'").run()).rejects.toThrow();
    // Foreign keys still bind to the rebuilt table: integrity holds, orphans are refused, and cascade still works.
    expect((await DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(DB.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES ('tn_ghost', 'us_1', 'member', ?)").bind(t).run()).rejects.toThrow();
    await DB.prepare("DELETE FROM tenants WHERE id = 'tn_b'").run();
    expect(await DB.prepare("SELECT 1 FROM tenant_domains WHERE tenant_id = 'tn_b'").first()).toBeNull();
    expect(await DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = 'tn_b'").first()).toBeNull();
    expect(await DB.prepare("SELECT 1 FROM memberships WHERE tenant_id = 'tn_a'").first()).not.toBeNull();
    // The status index is back.
    expect(await DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tenants_status'").first()).not.toBeNull();
  });
});
