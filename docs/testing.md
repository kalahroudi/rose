# Testing

```sh
pnpm verify      # guard + typecheck + every suite. Run before every commit and PR.
```

## Run CI locally

```sh
pnpm ci:local                 # both CI jobs, at HEAD, in a throwaway worktree
pnpm ci:local --job verify    # just the verify job
pnpm ci:local --here          # run in this tree, uncommitted changes allowed
```

`scripts/ci-local.mjs` runs every command in `.github/workflows/ci.yml`, in CI order,
and stops at the first failure. By default it checks out HEAD into a temporary git
worktree (`$TMPDIR/rose-ci-<sha>`), so only commits are tested, the way CI sees them.
It refuses to start when tracked files have uncommitted changes, unless you pass `--here`.

The pentest job starts the local stack itself, waits up to 90 seconds for it, and always
stops it. It refuses to run while something listens on ports 5173, 5174 or 8787, and never
kills a process it did not start. Output goes to the terminal, the dev-stack log to
`.rose/ci-local/dev.log`, and the per-step summary to `.rose/ci-local/last-run.json`.

`--keep` leaves the worktree in place for debugging. `--report` posts a `local-ci` commit
status with `gh` (it needs an authenticated `gh`); without the flag nothing is posted.
`scripts/ci-local.test.mjs` fails when `ci.yml` gains a `run:` command the local runner
does not run.

All worker tests run inside the real Workers runtime (workerd) through
`@cloudflare/vitest-plugin`, with a real local D1 database and real Durable Objects.
Nothing security-relevant is mocked.

| Suite | Location | Covers |
|---|---|---|
| Core isolation | `packages/core/test/isolation.test.ts` | Tenant resolution, physical separation, lifecycle (suspend, remove member, delete), roles, API keys, jobs |
| Core auth | `packages/core/test/auth.test.ts` | Email codes, invitations, sessions, handoffs, signup, HTTP hardening |
| Core crypto | `packages/core/test/crypto.test.ts` | Field encryption, envelope keys, rotation, the upstream gateway |
| **Isolation contract** | `apps/app/worker/test/isolation.test.ts` | The same seven isolation checks against **every registered module** |
| Module tests | `apps/app/worker/modules/<id>/*.test.ts` | Each module's behaviour |
| Operator console | `apps/admin/worker/test/admin.test.ts` | Bootstrap, operator auth, tenant lifecycle, domains, setup, secrets at rest |
| Guard and scripts | `scripts/*.test.mjs` (`pnpm test:scripts`) | Every guard rule fires and the repo passes; config editing |
| Example upstream | `examples/upstream-service/worker.test.mjs` | Token verification |

## Coverage

```sh
pnpm test:coverage   # the same worker suites, instrumented with istanbul
```

Each package writes its own report to `<package>/coverage/` (`index.html` to browse,
`lcov.info` for editors and tools, `coverage-summary.json`) and prints a summary.
CI runs the tests this way and keeps the reports as the `coverage` artifact.
istanbul is the only provider that works in the Workers runtime (v8 coverage does not).

- A package measures only its own source: `packages/core/src`, or `worker/` in each app.
  Core code exercised by the app and admin tests is not counted towards core.
- The SPAs (`web/`, `packages/ui`) and `scripts/` are not measured.
- There are no thresholds. Coverage is a map of untested code, not a gate.

## Writing a module test

```ts
import { env, SELF } from "cloudflare:test";
import { createTestTenant } from "@rose/core/testing";

const t = await createTestTenant(env, SELF, { role: "member" });   // tenant + signed-in user
const res = await t.fetch("/api/m/orders", { body: { item: "x" } }); // POST with JSON, cookie and Origin set
await t.fetch("/api/m/orders", { cookie: null });                   // anonymous
await t.fetch("/api/m/orders", { headers: { Authorization: `Bearer ${key}` }, cookie: null });
```

- Each `createTestTenant` call makes a completely separate tenant; make two to test
  anything cross-tenant.
- Storage is shared between tests **within one file**, so use fresh tenants rather than
  assuming an empty database. Email codes are rate limited: sign in once per file.
- To run queued jobs, call `await tenantTick(env, modules)`.
- To look at stored bytes (for example to assert a field is encrypted), read the tenant
  database directly in the test:
  `env.TENANT_DO.get(env.TENANT_DO.idFromName(t.id)).exec(t.id, { sql: "SELECT …" })`.
  This is allowed in test files only.

## The isolation contract

`describeTenantIsolation(env, SELF, modules)` uses each module's `isolationProbe` to
create a record as tenant A, then asserts:

1. A can list and read it (so the probe is meaningful);
2. B's list does not contain it;
3. B gets 404 reading it, and can not PATCH, PUT or DELETE it; A still has it;
4. A's cookie on B's host is rejected (401);
5. an anonymous caller gets 401 and no data;
6. every route of the module returns 401 without credentials;
7. a cross-site POST is blocked (403).

`pnpm guard` fails if this file is missing, skipped, focused, or no longer passes the
full manifest; it is also a protected file.

## What is not covered

- The React UI has no automated tests in this version.
- The full WebAuthn ceremony (needs a browser authenticator).
- Live Cloudflare APIs: custom hostnames, dispatch namespaces, real email delivery.
- The production setup/deploy scripts beyond `--dry-run`.
- Load and concurrency behaviour.
