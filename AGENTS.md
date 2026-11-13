# Rose — instructions for AI coding agents

Rose is a security-first, multi-tenant SaaS starter kit on Cloudflare Workers. People
drop it in front of (or build on top of) a product, and you will be asked to customise
it. **Tenant isolation is the product.** A feature that works but can leak one tenant's
data to another is a failed task. Read this file fully before changing anything.

## Non-negotiable invariants

Each has a reason. If a task seems to require breaking one, stop and ask the user.

1. **The request host decides the tenant. Nothing else.** Never read a tenant id from a
   header, query string, body, cookie value or token. *Why: anything the client sends
   can be forged; the host is routed by Cloudflare.*
2. **Tenant data lives only in that tenant's private database, reached only through
   `ctx.db`.** Never add tenant business data to the control plane (D1), and never open a
   tenant database yourself (`TENANT_DO`, `idFromName`). *Why: physical separation is
   what makes a forgotten filter harmless.*
3. **Module code never touches `env` or bindings**, never imports `cloudflare:*`, never
   imports `@rose/core/platform` or core internals. Use `ModuleContext` only. *Why: those
   are the only ways around the tenant binding.*
4. **Every route declares a `permission`.** There are no public module routes. Return
   404 (`notFound()`) for missing records so "not there" and "not yours" look the same.
5. **Bind every SQL value with `?`.** Sort columns go through `orderBy()` with an
   allow-list. Every list has `LIMIT` (page size ≤ 100, use `ctx.req.list()`).
6. **Encrypt sensitive fields with `ctx.crypto()`** (personal contact details,
   credentials, free text that may contain personal data), using a stable
   `"table.column"` label. Never log or audit secret values. Never store credentials in
   the browser.
7. **The operator console (`apps/admin`) has no path to tenant data.** Never give it a
   Durable Object binding or a tenant key. Tenant-data work requested by an operator runs
   as a job in the tenant worker.
8. **Do not weaken guardrails to get green.** No skipping/narrowing tests, no loosening
   the CSP, no deleting guard rules, no `--no-verify`. A `// guard-allow:` exception
   needs the user's explicit agreement and a real reason.
9. **Shipped migrations are immutable**: add a new numbered migration instead of editing an existing one.
10. **Mutations are audited and destructive actions are confirmed.** Call `ctx.audit()`
    for every change. In the UI, data-loss actions use the typed-name confirmation.

## Map

```
packages/core/        SECURITY CORE (protected). Tenancy, auth, crypto, HTTP hardening, module system, jobs.
  src/index.ts          public API for apps and modules          → import from "@rose/core"
  src/platform.ts       cross-tenant operator API (admin only)   → "@rose/core/platform"
  src/testing/          createTestTenant, describeTenantIsolation → "@rose/core/testing"
  migrations/           control-plane (D1) schema. Immutable once shipped.
packages/ui/          Shared React shell + components for both SPAs (docs/ui.md).
apps/app/             TENANT app: what customers use.
  worker/index.ts       wires the module manifest into the core. Rarely changes.
  worker/modules/       ← YOUR PRODUCT GOES HERE. One folder per module. `contacts` is the reference.
  worker/modules/index.ts   server module manifest
  worker/test/isolation.test.ts   isolation contract for every module (protected)
  web/                  SPA. web/modules/<id>/ holds each module's pages and help; web/modules/index.tsx is the manifest.
apps/admin/           OPERATOR console: tenants, domains, operators, setup. No tenant data.
examples/upstream-service/   How an existing service verifies Rose's tenant token.
scripts/              dev, setup, deploy, brand, guard.
docs/                 Start with architecture.md and tenancy-and-isolation.md.
```

## Commands

| Command | Use |
|---|---|
| `pnpm dev` | Run everything locally (console :5173, app :5174, `<slug>.localhost:5174`) |
| `pnpm verify` | **Definition of "works"**: guard + typecheck + all tests |
| `pnpm guard` | Static guardrails only; also runs automatically after each edit |
| `pnpm test` / `pnpm typecheck` | Individual steps |
| `pnpm --filter @rose/app test` | Just the tenant app's tests |

Do not run `pnpm deploy`, `pnpm setup --production`, `wrangler secret`, or `git push`
unless the user asked for exactly that.

## Recipe: add a feature (a module)

Full walkthrough with code: `docs/adding-a-module.md`. Skill: `.claude/skills/add-module`.

1. Copy the shape of `apps/app/worker/modules/contacts/index.ts` into
   `apps/app/worker/modules/<id>/index.ts`: `defineModule({ id, permissions, migrations,
   routes, jobs?, isolationProbe })`.
2. Register it in `apps/app/worker/modules/index.ts`.
3. Add `apps/app/worker/modules/<id>/<id>.test.ts` using `createTestTenant`. Cover
   validation, permissions by role, and any behaviour beyond plain CRUD. (Cross-tenant
   checks run automatically from the isolation contract; add your own for unusual routes
   such as exports.)
4. Add the page under `apps/app/web/modules/<id>/` following `docs/ui.md` (same page
   template, list with server pagination/search, drawer forms, typed-name confirmation
   for data loss, **help content for every page and tab**), and register it in
   `apps/app/web/modules/index.tsx`.
5. Run `pnpm verify`. Fix causes, not symptoms.

For functionality that already exists as a separate service, use the `/svc` gateway
instead: `docs/multi-tenanting-a-service.md`.

## When you think you need to change the core

First check whether the public API already covers it (`packages/core/src/index.ts`,
`ModuleContext`). If it truly does not: make the smallest change, add or extend a test in
`packages/core/test/` that proves the security property still holds, and run `pnpm verify`.

## Definition of done

- [ ] `pnpm verify` is green.
- [ ] New routes have permissions, validation (zod), audit entries; lists are paginated.
- [ ] Sensitive fields are encrypted; nothing secret in logs, audit metadata or job payloads.
- [ ] Tests exist next to the module and exercise roles and failure cases.
- [ ] Every new page/tab has help (what it is, terms, why) and matches the shared page template.
- [ ] Docs updated if behaviour changed. No new `guard-allow` without the user's agreement.
- [ ] You told the user plainly about anything not done, not verified, or approximated.

## Style

TypeScript strict, ESM, no new dependencies without asking (each one is supply-chain
risk). Match the surrounding code. SPDX header on every source file:
`// SPDX-License-Identifier: Apache-2.0`. The maintainer opens pull requests themselves:
commit when asked, never open a PR.
