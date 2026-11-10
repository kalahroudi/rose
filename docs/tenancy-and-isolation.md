# Tenancy and isolation

The promise: **nothing a tenant stores can be read or changed by another tenant, by an
anonymous caller, or by platform staff through the operator console.** This page lists
how each way of breaking that promise is closed, and the test that proves it.

## How a tenant is identified

| Host | Resolves to |
|---|---|
| `<base>` (e.g. `example.com`) | the *root* host: signup and workspace finder only |
| `<slug>.<base>` (exactly one label) | the tenant with that slug |
| any other host | the tenant that has it as an **active** custom domain |
| anything else, `a.b.<base>` | no tenant (404) |

Slugs are 3–40 characters of `a-z 0-9 -`, and a reserved list (`admin`, `api`, `www`,
`auth`, …) can never be claimed (`RESERVED_SLUGS` in `control/tenants.ts`). A custom
domain can never be inside `<base>` (`validateHostname`).

## Threat model

Tests live in `packages/core/test/` (the core, against a minimal test module),
`apps/app/worker/` (the shipped modules) and `apps/admin/worker/test/`.

| # | Threat | Control | Proven by |
|---|---|---|---|
| 1 | A query forgets its tenant filter | Each tenant has a physically separate SQLite database; module code only ever gets a handle to its own | `isolation.test.ts` › "stores each tenant in a physically separate database" |
| 2 | Tenant B lists or reads tenant A's records | Same as 1; unknown ids return 404, never 403 | `tenant isolation: module <id>` › "another tenant can not list it", "another tenant can not read, change or delete it by id" (runs for **every** registered module) |
| 3 | A's session cookie is replayed on B's host | Session lookup includes the scope resolved from the host; `__Host-` cookies are host-only | › "a session from one tenant is rejected on another tenant's host"; `auth.test.ts` › "session tokens are scoped, and expire" |
| 4 | Client names a tenant in a header/query/body | Tenant comes only from the routed host | `isolation.test.ts` › "ignores client-supplied tenant hints" |
| 5 | Wrong object addressed by a platform bug | Tenant DO pins its tenant id and refuses any other | › "a tenant database refuses a caller presenting a different tenant id" |
| 6 | Unknown / nested hosts reach a tenant | One-label rule; unknown hosts are 404 | › "treats unknown and nested hosts as no tenant" |
| 7 | Anonymous access to a module route | Every route requires a `permission`; there is no public module route type | › "anonymous callers get nothing", "every route requires authentication" |
| 8 | Cross-site request forgery | `Origin` must equal the request host for unsafe methods; `SameSite=Lax` cookies | › "cross-site writes are blocked"; `admin.test.ts` › "rejects unauthenticated and cross-site requests" |
| 9 | API key used on another tenant | Keys are stored and verified inside the issuing tenant's database | `isolation.test.ts` › "an API key works only on the tenant that issued it" |
| 10 | Suspended tenant or removed member keeps access | Session query joins live membership and active tenant; API-key path re-reads status | › "suspension cuts off sessions and API keys immediately", "removing a member ends their access on the next request" |
| 11 | Role escalation | Role→permission table checked per route; owner changes need an owner; last owner protected | › "enforces module permissions by role"; `auth.test.ts` › "only owners can invite owners or change owner access; last owner is protected" |
| 12 | Background job acts on the wrong tenant | Module jobs run for the tenant on the job row, set server-side when queued | `isolation.test.ts` › "runs module jobs for the tenant that queued them only" |
| 13 | Leaked ciphertext decrypted with another tenant's key or moved between columns | Per-tenant data key; tenant id and field name are authenticated (AAD) | `crypto.test.ts` › "binds ciphertext to the tenant and the field", "stores module secrets encrypted, readable only through the owning tenant" |
| 14 | Sign-in code for tenant A used on tenant B | Code hash is keyed and bound to scope + email | `auth.test.ts` › "a code issued for one tenant does not work on another" |
| 15 | Handoff token replayed or used on another tenant | Single use, 60 s, bound to purpose and tenant | › "handoffs are single use and bound to purpose and tenant", "a handoff for tenant A does not sign you in to tenant B" |
| 16 | Operator console reads tenant data | The admin worker has no `TENANT_DO` binding and no tenant key | `admin.test.ts` › "has no path to tenant data: no tenant database binding, no tenant key"; guard rule `admin-isolation` |
| 17 | Tenant session used as operator session | Operator sessions have scope `platform` and require an `operators` row | `admin.test.ts` › "a tenant session is not an operator session" |
| 18 | Custom domain hijacks another tenant or the platform namespace | Hostname is a primary key; hosts under `<base>` are rejected | `admin.test.ts` › "custom domains can not shadow the platform namespace or another tenant" |
| 19 | Deleted tenant's data lingers | Purge job destroys the DO storage and control-plane rows; typed-name confirmation | `isolation.test.ts` › "deleting a workspace needs the typed name, then destroys its data" |
| 20 | Upstream service receives spoofed identity or can set cookies | Header allow-list in, `Set-Cookie`/security headers stripped out, signed 60 s token | `crypto.test.ts` › "forwards a signed tenant token and strips credentials both ways" |
| 21 | User enumeration through sign-in | Identical response for members and strangers; work happens off the response path | `auth.test.ts` › "answers identically for members and strangers, and sends strangers nothing" |
| 22 | Unbounded list as exfiltration/DoS | `pageSize` capped at 100 by the shared schema; guard rule `list-limit` | `auth.test.ts` › "caps page size" |

## The isolation contract for modules

Every module must declare an `isolationProbe` (TypeScript makes it a required field).
`describeTenantIsolation(env, SELF, modules)` in `apps/app/worker/test/isolation.test.ts`
then runs threats 2, 3, 7 and 8 against it automatically. Adding a module to the manifest
is all it takes to be covered, and `pnpm guard` fails if the suite is removed, skipped
or narrowed.

## What is deliberately shared

- **A person is global.** One `users` row per email; `memberships` link it to tenants.
  A person in two workspaces has two independent sessions and two sets of passkeys.
- **Member email addresses and names** are in the control plane in clear text (they are
  needed for sign-in and searchable member lists). Operators can see who belongs to a
  tenant; they can not see what the tenant stores.
- **Job titles and status** for tenant jobs are in the control plane. Payloads of module
  jobs are too: do not put secrets in a job payload.

## What this does not protect against

- A bug or malicious change inside `packages/core` itself. That is why it is a protected
  path with a hash lock, CODEOWNERS and extra agent permissions ([agents.md](agents.md)).
- A module that deliberately copies data somewhere else (for example an outbound
  `fetch`). The guard flags `fetch` in modules; review remains the control.
- Compromise of the tenant worker's secrets or of the Cloudflare account.
