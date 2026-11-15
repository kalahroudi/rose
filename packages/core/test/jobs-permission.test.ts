// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CORE_PERMISSIONS } from "../src/modules";
import { createTestTenant } from "../src/testing";

describe("/api/jobs authorisation", () => {
  it("declares jobs:read for every role, because every role can start background work", () => {
    expect([...CORE_PERMISSIONS["jobs:read"]!].sort()).toEqual(["admin", "member", "owner"]);
  });

  it("serves each role that holds jobs:read, scoped to its own tenant", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      const t = await createTestTenant(env, SELF, { role });
      const r = await t.fetch("/api/jobs");
      expect(r.status, role).toBe(200);
      expect(((await r.json()) as { items: unknown[] }).items).toEqual([]);
    }
  });

  it("refuses anonymous, forged and cross-tenant callers", async () => {
    const a = await createTestTenant(env, SELF);
    const b = await createTestTenant(env, SELF);
    expect((await a.fetch("/api/jobs", { cookie: null })).status).toBe(401);
    expect((await a.fetch("/api/jobs", { cookie: null, headers: { Authorization: "Bearer rose_forged" } })).status).toBe(401);
    expect((await b.fetch("/api/jobs", { cookie: a.cookie })).status).toBe(401);
  });
});
