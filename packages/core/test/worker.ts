// SPDX-License-Identifier: Apache-2.0
// Minimal tenant worker used to test @rose/core in the real Workers runtime.
import { z } from "zod";
import { createTenantWorker, defineModule, newId, notFound, TenantDurableObject, tenantMigrations } from "../src";

export const notes = defineModule({
  id: "notes",
  permissions: { "notes:read": ["owner", "admin", "member"], "notes:write": ["owner", "admin"] },
  migrations: [{ id: "notes_001", sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, secret TEXT)" }],
  jobs: {
    stamp: async (ctx, payload) => {
      await ctx.db.run("INSERT INTO notes (id, title) VALUES (?, ?)", [newId("n"), `job:${String(payload.title)}`]);
    },
  },
  routes: [
    { method: "GET", path: "/", permission: "notes:read", handler: async (ctx) => ({ items: await ctx.db.all("SELECT id, title FROM notes LIMIT 50") }) },
    {
      method: "POST", path: "/", permission: "notes:write",
      handler: async (ctx) => {
        const body = await ctx.req.body(z.object({ title: z.string().min(1).max(100), secret: z.string().max(100).optional() }));
        const id = newId("n");
        const c = await ctx.crypto();
        await ctx.db.run("INSERT INTO notes (id, title, secret) VALUES (?, ?, ?)", [id, body.title, body.secret ? await c.encrypt(body.secret, "notes.secret") : null]);
        await ctx.audit("create", id);
        return { id, title: body.title };
      },
    },
    {
      method: "GET", path: "/:id", permission: "notes:read",
      handler: async (ctx) => {
        const row = await ctx.db.first<{ id: string; title: string; secret: string | null }>("SELECT * FROM notes WHERE id = ?", [ctx.req.param("id")]);
        if (!row) throw notFound();
        return { id: row.id, title: row.title, secret: row.secret ? await (await ctx.crypto()).decrypt(row.secret, "notes.secret") : null, raw: row.secret };
      },
    },
    {
      method: "DELETE", path: "/:id", permission: "notes:write",
      handler: async (ctx) => {
        if ((await ctx.db.run("DELETE FROM notes WHERE id = ?", [ctx.req.param("id")])) === 0) throw notFound();
      },
    },
    { method: "POST", path: "/stamp", permission: "notes:write", handler: async (ctx) => ({ jobId: await ctx.enqueue("stamp", "Stamp a note", { title: "hello" }) }) },
  ],
  isolationProbe: {
    create: (marker) => ({ path: "/", body: { title: marker } }),
    listPath: "/",
    itemPath: (created) => `/${String(created.id)}`,
  },
});

export const modules = [notes];

export class TenantDO extends TenantDurableObject {
  protected migrations() {
    return tenantMigrations(modules);
  }
}

export default createTenantWorker({ modules });
