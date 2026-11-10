// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { createTestTenant } from "@rose/core/testing";
import { tenantTick } from "@rose/core";
import { describe, expect, it } from "vitest";
import { modules } from "..";
import { parseCsvLine } from ".";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
type List = { items: { id: string; name: string; email: string; status: string }[]; total: number };

describe("contacts", () => {
  it("creates, lists, searches, sorts and paginates", async () => {
    const t = await createTestTenant(env, SELF);
    for (const [name, company] of [["Ada Lovelace", "Analytical"], ["Grace Hopper", "Navy"], ["Alan Turing", "Bletchley"]]) {
      expect((await t.fetch("/api/m/contacts", { body: { name, company, email: `${name!.split(" ")[0]!.toLowerCase()}@example.com` } })).status).toBe(201);
    }
    expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(3);
    expect((await json<List>(t.fetch("/api/m/contacts?q=hopp"))).items.map((i) => i.name)).toEqual(["Grace Hopper"]);
    expect((await json<List>(t.fetch("/api/m/contacts?sort=name&pageSize=2"))).items.map((i) => i.name)).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect((await json<List>(t.fetch("/api/m/contacts?sort=name&pageSize=2&page=2"))).items.map((i) => i.name)).toEqual(["Grace Hopper"]);
    // A hostile sort key falls back to the default instead of reaching SQL.
    expect((await t.fetch("/api/m/contacts?sort=name;DROP TABLE contacts")).status).toBe(200);
    expect((await t.fetch("/api/m/contacts?q=%25")).status).toBe(200);
    expect((await json<List>(t.fetch("/api/m/contacts?q=%25"))).total).toBe(0);
  });

  it("encrypts email and notes at rest and finds email by exact match", async () => {
    const t = await createTestTenant(env, SELF);
    const created = await json<{ id: string }>(t.fetch("/api/m/contacts", { body: { name: "Ada", email: "Ada@Example.com", notes: "likes maths" } }));
    const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(t.id));
    const raw = JSON.stringify((await stub.exec(t.id, { sql: "SELECT * FROM contacts" })).rows);
    expect(raw).not.toContain("ada@example.com");
    expect(raw).not.toContain("likes maths");
    expect((await json<List>(t.fetch("/api/m/contacts?q=ada@example.com"))).total).toBe(1);
    expect((await json<List>(t.fetch("/api/m/contacts?q=ada@example.co"))).total).toBe(0);
    expect(await json<{ notes: string; email: string }>(t.fetch(`/api/m/contacts/${created.id}`))).toMatchObject({ notes: "likes maths", email: "ada@example.com" });
  });

  it("validates input", async () => {
    const t = await createTestTenant(env, SELF);
    const res = await t.fetch("/api/m/contacts", { body: { name: "", email: "nope" } });
    expect(res.status).toBe(422);
    expect((await json<{ error: { fields: Record<string, string> } }>(res)).error.fields).toHaveProperty("name");
  });

  it("bulk actions work by ids and by filter (select all matching)", async () => {
    const t = await createTestTenant(env, SELF);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await json<{ id: string }>(t.fetch("/api/m/contacts", { body: { name: `Person ${i}`, company: i < 3 ? "Acme" : "Other" } }))).id);
    expect(await json(t.fetch("/api/m/contacts/bulk", { body: { action: "archive", ids: ids.slice(0, 2) } }))).toEqual({ affected: 2 });
    expect((await json<List>(t.fetch("/api/m/contacts?status=archived"))).total).toBe(2);
    expect(await json(t.fetch("/api/m/contacts/bulk", { body: { action: "delete", filter: { q: "Acme" } } }))).toEqual({ affected: 3 });
    expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(2);
    expect((await t.fetch("/api/m/contacts/bulk", { body: { action: "delete" } })).status).toBe(422);
  });

  it("members can edit but not delete", async () => {
    const m = await createTestTenant(env, SELF, { role: "member" });
    const c = await json<{ id: string }>(m.fetch("/api/m/contacts", { body: { name: "X" } }));
    expect((await m.fetch(`/api/m/contacts/${c.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await m.fetch("/api/m/contacts/bulk", { body: { action: "delete", ids: [c.id] } })).status).toBe(403);
  });

  it("imports CSV in the background and records an audit entry", async () => {
    const t = await createTestTenant(env, SELF);
    const res = await t.fetch("/api/m/contacts/import", { body: { csv: 'name,email,company\n"Lovelace, Ada",ada@example.com,Analytical\nGrace,not-an-email,Navy\nAlan,,' } });
    expect(res.status).toBe(201);
    expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(0);
    await tenantTick(env, modules);
    const list = await json<List>(t.fetch("/api/m/contacts?sort=name"));
    expect(list.items.map((i) => i.name)).toEqual(["Alan", "Lovelace, Ada"]);
    const audit = await json<{ items: { action: string }[] }>(t.fetch("/api/audit?action=contacts.import"));
    expect(audit.items).toHaveLength(1);
  });

  it("parses CSV lines", () => {
    expect(parseCsvLine('a,"b,c","d ""e"""')).toEqual(["a", "b,c", 'd "e"']);
  });
});
