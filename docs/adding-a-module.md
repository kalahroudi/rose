# Adding a module

A module is one feature of your product: its tables, API routes, permissions, background
jobs and (in the web app) its pages. The shipped **Contacts** module
(`apps/app/worker/modules/contacts/`) is the reference; copy it.

What you get without writing any security code: authentication, tenant resolution, a
database handle that can only reach the current tenant, role checks on every route,
field encryption with the tenant's key, CSRF protection, security headers, the audit
log, and the tenant-isolation test suite.

## 1. Create the module

`apps/app/worker/modules/orders/index.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import { defineModule, newId, notFound, now, offsetOf, orderBy, likePattern, type SqlValue } from "@rose/core";
import { z } from "zod";

const input = z.object({
  item: z.string().trim().min(1, "Enter an item.").max(200),
  shippingAddress: z.string().max(500).default(""),
});

export const orders = defineModule({
  id: "orders", // URL prefix /api/m/orders and permission prefix "orders:"

  // Permission → roles. Every route must name one of these.
  permissions: {
    "orders:read": ["owner", "admin", "member"],
    "orders:write": ["owner", "admin", "member"],
    "orders:delete": ["owner", "admin"],
  },

  // Tables in EACH tenant's private database. Ids must start with "orders_".
  // Append new entries to change the schema; never edit one that has shipped.
  migrations: [
    {
      id: "orders_001_init",
      sql: `CREATE TABLE orders (
              id TEXT PRIMARY KEY,
              item TEXT NOT NULL,
              address_enc TEXT,
              created_at INTEGER NOT NULL);
            CREATE INDEX orders_created ON orders (created_at);`,
    },
  ],

  routes: [
    {
      method: "GET", path: "/", permission: "orders:read",
      handler: async (ctx) => {
        const q = ctx.req.list(); // validated page, pageSize (≤100), q, sort
        const w = q.q ? { sql: "WHERE item LIKE ? ESCAPE '\\'", args: [likePattern(q.q)] as SqlValue[] } : { sql: "", args: [] as SqlValue[] };
        const order = orderBy(q.sort, { item: "item", created: "created_at" }, "created_at DESC");
        const [rows, count] = await ctx.db.batch([
          { sql: `SELECT id, item, created_at FROM orders ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, params: [...w.args, q.pageSize, offsetOf(q)] },
          { sql: `SELECT COUNT(*) AS n FROM orders ${w.sql}`, params: w.args },
        ]);
        return { items: rows!.rows, total: count!.rows[0]!.n as number, page: q.page, pageSize: q.pageSize };
      },
    },
    {
      method: "POST", path: "/", permission: "orders:write",
      handler: async (ctx) => {
        const body = await ctx.req.body(input); // validated JSON, size-capped
        const id = newId("ord");
        const c = await ctx.crypto();
        await ctx.db.run("INSERT INTO orders (id, item, address_enc, created_at) VALUES (?, ?, ?, ?)", [
          id, body.item, body.shippingAddress ? await c.encrypt(body.shippingAddress, "orders.address") : null, now(),
        ]);
        await ctx.audit("create", id); // recorded as "orders.create"
        return { id, item: body.item };
      },
    },
    {
      method: "GET", path: "/:id", permission: "orders:read",
      handler: async (ctx) => {
        const row = await ctx.db.first<{ id: string; item: string; address_enc: string | null }>("SELECT * FROM orders WHERE id = ?", [ctx.req.param("id")]);
        if (!row) throw notFound();
        return { id: row.id, item: row.item, shippingAddress: row.address_enc ? await (await ctx.crypto()).decrypt(row.address_enc, "orders.address") : "" };
      },
    },
    {
      method: "DELETE", path: "/:id", permission: "orders:delete",
      handler: async (ctx) => {
        if ((await ctx.db.run("DELETE FROM orders WHERE id = ?", [ctx.req.param("id")])) === 0) throw notFound();
        await ctx.audit("delete", ctx.req.param("id"));
      },
    },
  ],

  // Required. Tells the shared isolation suite how to create and find a record.
  isolationProbe: {
    create: (marker) => ({ path: "/", body: { item: marker } }), // marker must end up in a listed field
    listPath: "/",
    itemPath: (created) => `/${String(created.id)}`,
  },
});
```

## 2. Register it

`apps/app/worker/modules/index.ts`

```ts
import { contacts } from "./contacts";
import { orders } from "./orders";

export const modules: ModuleDefinition[] = [contacts, orders];
```

That is the whole server integration. The tenant Durable Object picks up the migration
the next time each tenant is used, routes appear under `/api/m/orders`, permissions join
the role table, and the isolation suite covers the module.

## 3. Test it

Add `apps/app/worker/modules/orders/orders.test.ts` (the guard requires a test next to
every module). `createTestTenant` from `@rose/core/testing` gives you a tenant with a
signed-in user:

```ts
import { env, SELF } from "cloudflare:test";
import { createTestTenant } from "@rose/core/testing";
import { expect, it } from "vitest";

it("creates and lists orders", async () => {
  const t = await createTestTenant(env, SELF);           // { role: "member" } for a non-admin
  expect((await t.fetch("/api/m/orders", { body: { item: "Widget" } })).status).toBe(201);
  const list = await (await t.fetch("/api/m/orders")).json();
  expect(list.total).toBe(1);
});
```

Run `pnpm verify`. You do not write isolation tests: `describeTenantIsolation` already
ran them for `orders`.

## 4. Add the page

Follow [ui.md](ui.md) for the page template, list, drawer forms, confirmations and the
required help content, and register the page in the web module manifest.

## The handler context

| `ctx.` | What it is |
|---|---|
| `tenant` | `{ id, slug, name }` of the current tenant (read-only) |
| `actor` | Who is calling: `{ type: "user" \| "api_key", id, label, role }` |
| `db` | This tenant's database: `all`, `first`, `run` (returns rows changed), `batch` (atomic) |
| `crypto()` | `encrypt`, `decrypt`, `blindIndex` with this tenant's key ([encryption.md](encryption.md)) |
| `audit(action, target?, meta?)` | Append to this tenant's audit log. Never put secrets in `meta` |
| `enqueue(job, title, payload?)` | Queue one of the module's `jobs`; returns the job id |
| `req.param / query / list / body` | Path parameter, query value, validated list query, validated JSON body |

There is intentionally no `env`, no request object and no way to name another tenant.
A handler's return value is sent as JSON (201 for POST, 200 otherwise). Throw the helpers
from `@rose/core` for errors: `notFound()`, `invalid(message, fields)`, `forbidden()`,
`conflict()`, `badRequest()`. Anything else becomes an opaque 500 with a request id.

## Rules the guard enforces (and why)

| Do | Because |
|---|---|
| Bind every value with `?` | Interpolated SQL is injection. Allowed interpolations: `${w.sql}` (constant fragments + bound args), `${order}` (from `orderBy()`), `ids.map(() => "?").join(",")` |
| Use `orderBy(sort, allowlist, fallback)` for sorting | Column names can not be bound, so they must come from an allow-list |
| `LIMIT` every list (≤ 100) | No unbounded responses |
| Return 404 for missing rows | The same answer for "not there" and "not yours" |
| Encrypt personal or secret fields | A database dump should not expose them |
| No `env`, no `fetch`, no `cloudflare:*` imports in modules | They are the ways around tenant binding |
| Use `newId()` / `randomToken()` | `Math.random()` is guessable |

## Background jobs

For anything slow (imports, exports, syncs) add a job so the request returns at once:

```ts
jobs: {
  export: async (ctx, payload) => { /* ctx: tenant, db, crypto, audit */ return { rows: 42 }; },
},
// in a route:
return { jobId: await ctx.enqueue("export", "Export orders", { format: "csv" }) };
```

The job runs within about a minute in production (cron) and about 3 seconds under
`pnpm dev`, for the tenant that queued it, with retries. It appears in the app's
notification centre. Payloads are stored in the control plane in clear text and are
limited by the 100 KB request cap: do not put secrets in them.

## Changing a schema later

Append a migration (`orders_002_add_status`) with `ALTER TABLE …`. Do not edit
`orders_001_init`: tenants that already ran it would never see the change.
