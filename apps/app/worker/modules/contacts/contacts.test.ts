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

  it("never stores the import CSV in clear text in the control database and clears it when done", async () => {
    const t = await createTestTenant(env, SELF);
    const res = await t.fetch("/api/m/contacts/import", { body: { csv: "name,email,company\nLeaky,leaky@example.com,Acme" } });
    const { jobId } = await json<{ jobId: string }>(res);
    const queued = await env.DB.prepare("SELECT payload FROM jobs WHERE id = ?").bind(jobId).first<{ payload: string }>();
    expect(queued!.payload).not.toContain("leaky@example.com");
    expect(queued!.payload).not.toContain("Leaky");
    await tenantTick(env, modules);
    const done = await env.DB.prepare("SELECT status, payload FROM jobs WHERE id = ?").bind(jobId).first<{ status: string; payload: string }>();
    expect(done).toEqual({ status: "succeeded", payload: "{}" });
    expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(1);
  });

  describe("import job payload sealing", () => {
    const rowOf = (id: string) => env.DB.prepare("SELECT status, attempts, payload, result, error FROM jobs WHERE id = ?").bind(id).first<{ status: string; attempts: number; payload: string; result: string | null; error: string | null }>();
    const queueImport = async (t: Awaited<ReturnType<typeof createTestTenant>>, csv: string) => (await json<{ jobId: string }>(t.fetch("/api/m/contacts/import", { body: { csv } }))).jobId;

    it("seals the payload as { enc } only, with fresh ciphertext per job, and keeps nothing readable in any jobs column", async () => {
      const t = await createTestTenant(env, SELF);
      const csv = "name,email,company\nZelda Sealed,zelda.sealed@example.com,Hyrule";
      const a = await queueImport(t, csv);
      const b = await queueImport(t, csv);
      const pa = JSON.parse((await rowOf(a))!.payload) as Record<string, unknown>;
      const pb = JSON.parse((await rowOf(b))!.payload) as Record<string, unknown>;
      expect(Object.keys(pa)).toEqual(["enc"]);
      expect(typeof pa.enc).toBe("string");
      expect(pa.enc).not.toBe(pb.enc);
      await tenantTick(env, modules);
      for (const needle of ["zelda.sealed", "Zelda", "Hyrule", "csv"]) {
        const hit = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE payload LIKE ? OR result LIKE ? OR error LIKE ? OR title LIKE ?").bind(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`).first<{ n: number }>();
        expect(hit!.n).toBe(0);
      }
      expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(2);
    });

    it("a tampered payload fails safely without leaking contents, imports nothing, and is cleared on the final failure", async () => {
      const t = await createTestTenant(env, SELF);
      const id = await queueImport(t, "name,email\nTamper,tamper@example.com");
      const enc = (JSON.parse((await rowOf(id))!.payload) as { enc: string }).enc;
      const flipped = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
      await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify({ enc: flipped }), id).run();
      await tenantTick(env, modules);
      const retry = (await rowOf(id))!;
      expect(retry.status).toBe("queued");
      expect(retry.payload).toBe(JSON.stringify({ enc: flipped })); // kept (still sealed) for the retry
      expect(retry.error ?? "").not.toContain("tamper@example.com");
      await env.DB.prepare("UPDATE jobs SET attempts = 4, run_after = 0 WHERE id = ?").bind(id).run();
      await tenantTick(env, modules);
      const final = (await rowOf(id))!;
      expect(final.status).toBe("failed");
      expect(final.payload).toBe("{}");
      expect(final.error ?? "").not.toContain("tamper@example.com");
      expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(0);
    });

    it("a sealed payload moved to another tenant's job can not be opened or imported there", async () => {
      const a = await createTestTenant(env, SELF);
      const b = await createTestTenant(env, SELF);
      const idA = await queueImport(a, "name,email\nVictim,victim@example.com");
      const idB = await queueImport(b, "name,email\nOwn,own@example.com");
      const sealedA = (await rowOf(idA))!.payload;
      await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(sealedA, idB).run();
      await env.DB.prepare("UPDATE jobs SET attempts = 4 WHERE id = ?").bind(idB).run();
      await tenantTick(env, modules);
      expect((await rowOf(idB))!.status).toBe("failed");
      const names = (await json<List>(b.fetch("/api/m/contacts"))).items.map((i) => i.name);
      expect(names).not.toContain("Victim");
      expect(names).not.toContain("Own");
    });

    it("a legacy or forged plain-JSON payload is not trusted as the module's input", async () => {
      const t = await createTestTenant(env, SELF);
      const id = await queueImport(t, "name,email\nReal,real@example.com");
      await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify({ csv: "name,email\nForged,forged@example.com" }), id).run();
      await tenantTick(env, modules);
      const names = (await json<List>(t.fetch("/api/m/contacts"))).items.map((i) => i.name);
      expect(names).not.toContain("Forged");
      expect(names).not.toContain("Real");
    });

    it("a payload with a non-string enc is rejected without importing", async () => {
      const t = await createTestTenant(env, SELF);
      const id = await queueImport(t, "name,email\nX,x@example.com");
      await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify({ enc: { csv: "name\nObj" } }), id).run();
      await tenantTick(env, modules);
      expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(0);
    });

    it("a succeeded job is not re-run by a second tick (no duplicate imports)", async () => {
      const t = await createTestTenant(env, SELF);
      const id = await queueImport(t, "name,email\nOnce,once@example.com");
      await tenantTick(env, modules);
      await tenantTick(env, modules);
      expect((await rowOf(id))!.payload).toBe("{}");
      expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(1);
    });
  });

  it("parses CSV lines", () => {
    expect(parseCsvLine('a,"b,c","d ""e"""')).toEqual(["a", "b,c", 'd "e"']);
  });
});

describe("contacts bulk filter safety", () => {
  it("a NUL byte or over-long filter can not widen a bulk delete", async () => {
    const t = await createTestTenant(env, SELF);
    for (const name of ["One", "Two"]) await t.fetch("/api/m/contacts", { body: { name } });
    expect(await json(t.fetch("/api/m/contacts/bulk", { body: { action: "delete", filter: { q: "zzz\u0000" } } }))).toEqual({ affected: 0 });
    expect((await t.fetch("/api/m/contacts/bulk", { body: { action: "delete", filter: { q: "x".repeat(60) } } })).status).toBe(422);
    expect((await json<List>(t.fetch("/api/m/contacts"))).total).toBe(2);
  });
});
