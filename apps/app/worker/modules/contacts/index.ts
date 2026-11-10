// SPDX-License-Identifier: Apache-2.0
//
// Example module: Contacts. Copy this folder to start a new module (see docs/adding-a-module.md).
// It demonstrates every pattern a module needs:
//   - a table in each tenant's private database        - paginated, searchable, sortable lists
//   - encrypted sensitive fields + blind-index search  - bulk actions with server-side "select all"
//   - permissions by role and an audit trail           - a background job (CSV import)
import { defineModule, invalid, likePattern, newId, notFound, now, offsetOf, orderBy, type ModuleContext, type ModuleJobContext, type SqlValue } from "@rose/core";
import { z } from "zod";

const STATUSES = ["lead", "active", "archived"] as const;
type Status = (typeof STATUSES)[number];

interface Row {
  id: string;
  name: string;
  company: string;
  email_enc: string | null;
  notes_enc: string | null;
  status: Status;
  created_at: number;
  updated_at: number;
}

const input = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120),
  company: z.string().trim().max(120).default(""),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().max(254).email("Enter a valid email address.")]).default(""),
  notes: z.string().max(4000).default(""),
  status: z.enum(STATUSES).default("lead"),
});

// Sensitive fields are encrypted with the tenant's key. `field` binds the ciphertext to
// this exact column, so it can not be swapped into another one.
const EMAIL = "contacts.email";
const NOTES = "contacts.notes";

async function seal(ctx: ModuleJobContext, v: { email: string; notes: string }) {
  const c = await ctx.crypto();
  return {
    email_enc: v.email ? await c.encrypt(v.email, EMAIL) : null,
    email_idx: v.email ? await c.blindIndex(v.email, EMAIL) : null,
    notes_enc: v.notes ? await c.encrypt(v.notes, NOTES) : null,
  };
}

async function present(ctx: ModuleContext, r: Row, withNotes: boolean) {
  const c = await ctx.crypto();
  return {
    id: r.id, name: r.name, company: r.company, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    email: r.email_enc ? await c.decrypt(r.email_enc, EMAIL) : "",
    ...(withNotes ? { notes: r.notes_enc ? await c.decrypt(r.notes_enc, NOTES) : "" } : {}),
  };
}

/** Shared by the list and by "select all matching" bulk actions, so both see the same rows. */
async function where(ctx: ModuleContext, f: { q?: string; status?: string }): Promise<{ sql: string; args: SqlValue[] }> {
  const parts: string[] = [];
  const args: SqlValue[] = [];
  if (f.q) {
    if (f.q.includes("@")) {
      // Email is encrypted, so it is searched by exact match through its blind index.
      parts.push("email_idx = ?");
      args.push(await (await ctx.crypto()).blindIndex(f.q, EMAIL));
    } else {
      parts.push("(name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')");
      args.push(likePattern(f.q), likePattern(f.q));
    }
  }
  if (f.status && (STATUSES as readonly string[]).includes(f.status)) {
    parts.push("status = ?");
    args.push(f.status);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

/** Minimal CSV line parser: handles quoted fields and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (out.push(cur.trim()), (cur = ""));
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export const contacts = defineModule({
  id: "contacts",

  permissions: {
    "contacts:read": ["owner", "admin", "member"],
    "contacts:write": ["owner", "admin", "member"],
    "contacts:delete": ["owner", "admin"],
  },

  migrations: [
    {
      id: "contacts_001_init",
      sql: `CREATE TABLE contacts (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              company TEXT NOT NULL DEFAULT '',
              email_enc TEXT,
              email_idx TEXT,
              notes_enc TEXT,
              status TEXT NOT NULL DEFAULT 'lead',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL);
            CREATE INDEX contacts_status ON contacts (status, created_at);
            CREATE INDEX contacts_email_idx ON contacts (email_idx);`,
    },
  ],

  jobs: {
    // Imports are a job so a large paste never blocks the request or the UI.
    import: async (ctx, payload) => {
      const lines = String(payload.csv ?? "").split(/\r?\n/).filter((l) => l.trim());
      let imported = 0;
      let skipped = 0;
      for (const line of lines) {
        const [name = "", email = "", company = ""] = parseCsvLine(line);
        const parsed = input.safeParse({ name, email, company });
        if (!parsed.success || name.toLowerCase() === "name") {
          skipped++;
          continue;
        }
        const s = await seal(ctx, { email: parsed.data.email, notes: "" });
        const t = now();
        await ctx.db.run("INSERT INTO contacts (id, name, company, email_enc, email_idx, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'lead', ?, ?)", [
          newId("ct"), parsed.data.name, parsed.data.company, s.email_enc, s.email_idx, t, t,
        ]);
        imported++;
      }
      await ctx.audit("import", null, { imported, skipped });
      return { imported, skipped };
    },
  },

  routes: [
    {
      method: "GET", path: "/", permission: "contacts:read",
      handler: async (ctx) => {
        const q = ctx.req.list();
        const w = await where(ctx, { q: q.q, status: ctx.req.query("status") });
        const order = orderBy(q.sort, { name: "name", company: "company", created: "created_at", status: "status" }, "created_at DESC");
        const [rows, count] = await ctx.db.batch([
          { sql: `SELECT * FROM contacts ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, params: [...w.args, q.pageSize, offsetOf(q)] },
          { sql: `SELECT COUNT(*) AS n FROM contacts ${w.sql}`, params: w.args },
        ]);
        const items = await Promise.all((rows!.rows as unknown as Row[]).map((r) => present(ctx, r, false)));
        return { items, total: count!.rows[0]!.n as number, page: q.page, pageSize: q.pageSize };
      },
    },
    {
      method: "GET", path: "/stats", permission: "contacts:read",
      handler: async (ctx) => {
        const rows = await ctx.db.all<{ status: Status; n: number }>("SELECT status, COUNT(*) AS n FROM contacts GROUP BY status");
        const out: Record<string, number> = { lead: 0, active: 0, archived: 0, total: 0 };
        for (const r of rows) {
          out[r.status] = r.n;
          out.total! += r.n;
        }
        return out;
      },
    },
    {
      method: "POST", path: "/", permission: "contacts:write",
      handler: async (ctx) => {
        const body = await ctx.req.body(input);
        const id = newId("ct");
        const s = await seal(ctx, body);
        const t = now();
        await ctx.db.run(
          "INSERT INTO contacts (id, name, company, email_enc, email_idx, notes_enc, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, body.name, body.company, s.email_enc, s.email_idx, s.notes_enc, body.status, t, t],
        );
        await ctx.audit("create", id, { name: body.name });
        return { id, name: body.name, company: body.company, email: body.email, status: body.status, createdAt: t, updatedAt: t };
      },
    },
    {
      method: "POST", path: "/bulk", permission: "contacts:delete",
      handler: async (ctx) => {
        const body = await ctx.req.body(
          z.object({
            action: z.enum(["delete", "archive", "activate"]),
            ids: z.array(z.string().max(40)).max(100).optional(),
            // "Select all matching": the server re-applies the filter; ids are never loaded into the browser.
            filter: z.object({ q: z.string().max(100).default(""), status: z.string().max(20).default("") }).optional(),
          }),
        );
        let w: { sql: string; args: SqlValue[] };
        if (body.ids?.length) w = { sql: `WHERE id IN (${body.ids.map(() => "?").join(",")})`, args: body.ids };
        else if (body.filter) w = await where(ctx, body.filter);
        else throw invalid("Select at least one contact.");
        const affected =
          body.action === "delete"
            ? await ctx.db.run(`DELETE FROM contacts ${w.sql}`, w.args)
            : await ctx.db.run(`UPDATE contacts SET status = ?, updated_at = ? ${w.sql}`, [body.action === "archive" ? "archived" : "active", now(), ...w.args]);
        await ctx.audit(`bulk.${body.action}`, null, { affected });
        return { affected };
      },
    },
    {
      method: "POST", path: "/import", permission: "contacts:write",
      handler: async (ctx) => {
        const { csv } = await ctx.req.body(z.object({ csv: z.string().min(1, "Paste at least one line.").max(90_000) }));
        return { jobId: await ctx.enqueue("import", "Import contacts", { csv }) };
      },
    },
    {
      method: "GET", path: "/:id", permission: "contacts:read",
      handler: async (ctx) => {
        const row = await ctx.db.first<Row>("SELECT * FROM contacts WHERE id = ?", [ctx.req.param("id")]);
        if (!row) throw notFound();
        return present(ctx, row, true);
      },
    },
    {
      method: "PATCH", path: "/:id", permission: "contacts:write",
      handler: async (ctx) => {
        const id = ctx.req.param("id");
        if (!(await ctx.db.first("SELECT id FROM contacts WHERE id = ?", [id]))) throw notFound();
        const body = await ctx.req.body(input);
        const s = await seal(ctx, body);
        await ctx.db.run("UPDATE contacts SET name = ?, company = ?, email_enc = ?, email_idx = ?, notes_enc = ?, status = ?, updated_at = ? WHERE id = ?", [
          body.name, body.company, s.email_enc, s.email_idx, s.notes_enc, body.status, now(), id,
        ]);
        await ctx.audit("update", id);
        return { id, ...body };
      },
    },
    {
      method: "DELETE", path: "/:id", permission: "contacts:delete",
      handler: async (ctx) => {
        if ((await ctx.db.run("DELETE FROM contacts WHERE id = ?", [ctx.req.param("id")])) === 0) throw notFound();
        await ctx.audit("delete", ctx.req.param("id"));
      },
    },
  ],

  isolationProbe: {
    create: (marker) => ({ path: "/", body: { name: marker, email: "probe@example.com", notes: "probe" } }),
    listPath: "/",
    itemPath: (created) => `/${String(created.id)}`,
  },
});
