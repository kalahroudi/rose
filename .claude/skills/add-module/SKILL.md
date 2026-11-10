---
name: add-module
description: Add a new feature (module) to the Rose tenant app end to end - tenant-private tables, API routes with permissions, encryption of sensitive fields, tests, UI page and help. Use whenever the user asks to add a feature, entity, resource, CRUD screen, endpoint or background job to the tenant app, or to "build X on the starter kit".
---

# Add a module

A module is one product feature. Follow these steps in order; do not skip the test or
help steps. The reference implementation is the Contacts module.

Read first:
- `AGENTS.md` (the invariants)
- `docs/adding-a-module.md` (complete walkthrough)
- `apps/app/worker/modules/contacts/index.ts` and `contacts.test.ts`
- `apps/app/web/modules/contacts/` and `docs/ui.md` for the page

## 1. Design (write it down briefly before coding)

- **id**: lowercase, e.g. `orders`. Becomes `/api/m/orders` and the `orders:` permission prefix.
- **Tables** in the tenant database. Decide per column: plaintext (needed for `LIKE`
  search or sorting) or encrypted (personal, secret, or free text). Encrypted columns
  that need exact lookup also get a `_idx` blind-index column.
- **Permissions**: usually `<id>:read`, `<id>:write`, `<id>:delete` mapped to roles
  (`owner`, `admin`, `member`). Give each role the least that works.
- **Routes**: list (paginated), create, read, update, delete; bulk and jobs only if needed.
- Anything slow or unbounded is a **job**, not a request.

## 2. Server: `apps/app/worker/modules/<id>/index.ts`

- `defineModule({ id, permissions, migrations, routes, jobs?, isolationProbe })`.
- Migration ids start with `<id>_`. Append-only.
- Lists: `ctx.req.list()` + `LIMIT ? OFFSET ?` + a `COUNT(*)` in the same `ctx.db.batch`.
  Sorting through `orderBy(q.sort, { key: "column" }, "created_at DESC")` assigned to a
  variable named `order`. Filters as `w = { sql, args }` built from constant fragments.
- Validate bodies with zod via `ctx.req.body(schema)`; give human messages.
- `notFound()` when a row is missing. `ctx.audit(action, id)` on every mutation.
- Encrypt with `(await ctx.crypto()).encrypt(value, "<table>.<column>")`.
- `isolationProbe.create(marker)` must store `marker` in a field the list returns.
- Never: `env`, `fetch`, `cloudflare:*`, string-built SQL, `Math.random()`.

## 3. Register: `apps/app/worker/modules/index.ts`

Add the import and append to `modules`.

## 4. Tests: `apps/app/worker/modules/<id>/<id>.test.ts`

With `createTestTenant(env, SELF, { role })`:
- happy path create/list/search/sort/paginate;
- validation failure returns 422 with `error.fields`;
- a `member` is refused what only admins may do (403);
- encrypted fields are not present in raw storage (see the contacts test);
- jobs: call `tenantTick(env, modules)` then assert the effect;
- any route beyond CRUD that returns data (export, search, stats) gets its own
  two-tenant test.

## 5. Web: `apps/app/web/modules/<id>/`

Follow `docs/ui.md` exactly: shared page template, tabs for sub-sections, `DataTable`
with server pagination/search/filter and URL state, actions in a right-side drawer that
closes on success with the cache invalidated (no reloads), typed-name confirmation for
data loss and plain confirm for other actions, copy buttons for ids. Add help content
(what this is, terminology, why it works this way) for the page and each tab. Register
in `apps/app/web/modules/index.tsx` and add the invalidation mapping.

## 6. Verify and report

Run `pnpm verify`. Then run the `security-review` skill. Report to the user: what was
added, how it was verified, and anything not done or not verified.
