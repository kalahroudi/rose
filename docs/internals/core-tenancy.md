# Core tenancy (`packages/core/src/tenancy`)

What the tenancy layer promises, and why it is built the way it is. This page holds the
knowledge that sits as comments in the four files of the folder, rewritten as prose.
Source files are named with their symbol, never a line number.

Scope: `context.ts` (tenant context, database handle, data-key access, purge), `resolve.ts`
(host to tenant), `store.ts` (per-tenant audit log and API keys), `tenant-do.ts` (the
Durable Object that is one tenant's database).

Related pages: [tenancy and isolation](../tenancy-and-isolation.md) (threat model),
[architecture](../architecture.md) (where data lives), [encryption](../encryption.md) (key
hierarchy).

## The shape of the boundary

There are two kinds of data, and nothing in between. Identity and routing live in the
control plane (D1). Everything a tenant owns lives inside that tenant's own SQLite
database, held by one Durable Object instance. Built-in tenant records, the audit log and
the API keys, live in that database too, so they share its isolation and disappear when it
does.

The `TenantContext` type (`context.ts`) is the proof that a request was bound to exactly
one tenant. It carries a phantom `unique symbol` member, so no application code can build
one by hand. Only `bindTenant` mints it, and the platform calls that after resolving the
tenant from the request host. `bindTenant` freezes the object, so the id, slug and name
cannot change after binding.

`TenantDb` (`context.ts`) is the only SQL handle a module receives. Two rules come with it
and are worth keeping in mind when reading any query in the codebase.

- Query text must be a constant in the code, and every value is bound as a parameter.
  Nothing a request supplies is ever pasted into SQL.
- The handle is created from a `TenantContext`, and it addresses the tenant's Durable
  Object by `idFromName(tenant.id)`. There is no way to point it at a second tenant: a
  module has one handle, for its own tenant.

`all` returns rows, `first` returns the first row or `null`, `run` returns the number of
inserted, updated or deleted rows, and `batch` runs several statements in one transaction
that commits whole or not at all.

## Per-tenant data keys

`tenantCrypto` (`context.ts`) returns the tenant's `TenantCrypto`, built from the tenant's
data-encryption key. The unwrapped key is cached in isolate memory, keyed by tenant id,
for five minutes (`KEY_TTL`) and the cache holds at most 500 tenants (`MAX_KEYS`); when it
is full the oldest inserted entry is dropped. The cache exists because unwrapping the key
costs a round trip to the Durable Object on every request otherwise.

`purgeTenantStorage` destroys a tenant's storage and drops its cached key in the same
step. Its only caller is the tenant purge job. Dropping the cache entry matters: a
purged tenant must not leave a usable key behind in an isolate that already unwrapped it.

## Host to tenant (`resolve.ts`)

`resolveHost` is the single place tenant identity is decided. It takes the host that
Cloudflare routed and nothing else, never a header, query string, body or token that a
client supplied. The outcome is one of three kinds: `root` (the base domain itself, which
serves signup and the workspace finder rather than a workspace), `tenant` (the row for that
host), or `unknown` (there is no workspace behind this host).

What an unknown host gets back depends on the route. `GET /api/bootstrap` answers 200 with
`host: "unknown"` so the SPA can show the right page. The tenant API routes answer 404 for a
root, unknown or `deleting` host, so "not there" and "not yours" look the same. A tenant in
`pending_deletion`, `suspended` or any other non-`active` status reaches the workspace
routes and is refused with 403 and a message that says why.

The matching rules, in order:

1. The host equals the base domain (case-insensitive): `root`.
2. The host ends with `.<base>`: the part before the base is the slug, and it must be
   exactly one label. `a.b.<base>` is never a tenant, so the lookup is skipped and the
   result is `unknown`.
3. Any other host: look it up in `tenant_domains`, and only accept a row whose domain
   status is `active`.

`hostnameOf` lower-cases the host and drops the port. It relies on `URL.hostname`, which
already omits the port, so the port can never influence routing.

### The host cache

`resolveHost` caches results per isolate for `HOST_CACHE_TTL_MS`, which is 5 seconds, in a
map capped at 2000 entries. The TTL is deliberately short, because a change of name,
status or domain is only seen by another isolate when its entry expires.

The cache stores the full tenant row, status included. That is safe only because status
from this cache is **not trusted** for authenticated requests: the session lookup joins
the live tenant row and requires `status = 'active'`, and the API-key path re-reads the
tenant status from D1. The cache answers "which tenant owns this host", and that answer
rarely changes. It does not decide whether that tenant may still be used.

`invalidateHostCache` drops one host, or the whole map when called with no argument. The
purge path calls it with no argument after a tenant is deleted.

Tests that pin this behaviour: `session-idle.test.ts` › "is short, and an entry expires
after HOST_CACHE_TTL_MS", and `session-idle.adversarial.test.ts` › "negative entries
(unknown host) also expire after HOST_CACHE_TTL_MS", "custom-domain removal is reflected
after the TTL", "invalidateHostCache(host) drops only that host", and the two over-HTTP
cases that show suspension and deletion land within TTL plus margin.

## The tenant database (`tenant-do.ts`)

One `TenantDurableObject` instance is one tenant, and one tenant is one private SQLite
database. This is the isolation boundary of the whole system. There is no shared table
where a forgotten `WHERE tenant_id = ?` could leak another tenant's rows, because those
rows are not in this database at all.

### Migrations

The app supplies the migration list through `migrations()`: `CORE_TENANT_MIGRATIONS`
first, then each module's. `CORE_TENANT_MIGRATIONS` holds the tables that every tenant
database has regardless of installed modules, which today is `audit_log` and `api_keys`.

`migrate` runs inside `blockConcurrencyWhile` from the constructor, so no request can touch
the database before the schema is ready. It records applied ids in `_rose_migrations` and
applies each missing migration in its own synchronous transaction, so a failure leaves the
earlier ones applied. A `TenantMigration.id` must be unique, stable, and applied in array
order; a shipped migration is never edited. This mirrors the control-plane rule: add a new
numbered migration instead.

### The pinned tenant id

`assertTenant` runs at the start of every public method (`exec`, `batch`, `dataKey`,
`purge`). On first use it writes the tenant id to storage under `tenant_id`; later calls
compare against that pinned value and throw `Tenant mismatch: refusing cross-tenant access`
when they differ. This catches a platform bug that addresses tenant A's object with tenant
B's id, and turns it into an error instead of a cross-tenant read. An empty id is refused
outright.

### Counting changed rows

`run` asks SQLite for the true change count with `SELECT changes()`, but only when
`rowsWritten > 0`. The reason is that `rowsWritten` also counts index writes, so it
overstates how many rows a statement changed. When nothing was written the answer is zero
without a second query.

### The data key

`dataKey` returns the tenant's data-encryption key, creating it on first use with
`generateDek` and storing it wrapped by the worker's master key (`ROSE_MASTER_KEY`) under
`wrapped_dek`. The key only ever leaves the object inside the same worker, and it is never
stored unwrapped.

Creation is wrapped in `blockConcurrencyWhile`, which serialises it. Two first-time callers
must never mint two different keys, or one of them would encrypt data forever unreadable by
the other.

On every later read, `unwrapDek` also reports whether the key was wrapped under the
previous master key (`ROSE_MASTER_KEY_PREVIOUS`). If so it is re-wrapped under the current
one, which is how master-key rotation happens without downtime.

`purge` deletes all of the object's storage, including the wrapped data key. It is
irreversible, and that is the point: with the wrapped key gone, no leftover ciphertext can
be read.

Test that pins the pin: `isolation.test.ts` › "a tenant database refuses a caller
presenting a different tenant id". Purge behaviour is covered through the job tests in
`deletion.adversarial.test.ts`, which prove that a cancelled, suspended or early tenant is
never purged.

## Built-in tenant records (`store.ts`)

### The audit log

`writeTenantAudit` appends one row to the tenant's own `audit_log`. `listTenantAudit`
pages over it, newest first, filtered by a free-text query and an optional `action`
prefix.

`meta` is JSON-encoded, and only when a value was given: passing `undefined` stores `NULL`
rather than the string `"undefined"`. Callers pass structured context such as an id, a role
or a name. Secret values never belong in `meta`; `AGENTS.md` makes that a rule.

The built-in entries use `meta` unevenly, and that is the real shape: `member.join`,
`member.role` and `invitation.create` pass `{ role }`; `apikey.create` passes
`{ name, role }`; `member.remove`, `invitation.revoke` and `apikey.revoke` pass no `meta`
at all, so it is stored as `NULL`. The target is a user id for member changes, an
invitation id for `invitation.revoke`, an API-key id for API-key create and revoke, and
the invitee's email for `invitation.create`.

`actor` is the person's label for user actions (their email) and a `job:` prefix plus the
queuing actor's label for background work. `target` is usually an id, but an invitation
entry puts the invitee's email there. Neither column is encrypted and the audit page is
readable by owners and admins (`audit:read`), so the rule that keeps personal free text out
of audit metadata is a rule about what callers pass, not something the table enforces.

Both list functions build their `WHERE` clause from fixed fragments and bound values, but
they do not share a filter set. `listTenantAudit` filters by `q` (matched as a "contains"
pattern against `actor`, `target` and `action`) and by an optional `action` prefix
("starts with" pattern); both use `ESCAPE '\'`, and the rows come back in a fixed `at DESC`
order. `listApiKeys` filters only by `q`, matched against `name` with `ESCAPE '\'`, and
orders by a fixed `created_at DESC`. Each is a `batch` of the page query and its matching
count, so the two see the same data, and no client-supplied sort key reaches either SQL.

### API keys

The format is `rose_<keyId>_<secret>`, where the id is `key_` plus 24 hex characters and
the secret is a URL-safe random token. Only `SHA-256(secret)` is stored. A fast hash is
appropriate here because the secret has 256 bits of entropy, so an attacker cannot search
the space; a password-style slow hash would only add latency on every API call.

Keys act with a fixed role, and `createApiKey` accepts only `admin` or `member`. There is no
key that acts as `owner`, which keeps the actions reserved for a fresh human sign-in
(deleting the workspace, changing owner access) out of reach of automation. The HTTP layer
also refuses to mint an `admin` key for a caller whose own role is `member`.

`verifyApiKey` checks in this order: the shape of the presented string, a lookup by key id,
a constant-time comparison of the stored hash with the hash of the presented secret, the
optional `expires_at`, then an optional `last_used_at` refresh. The lookup by id means a
wrong-key denial is cheap. The comparison uses `timingSafeEqual`, which compares HMACs so
neither content nor length leaks through timing.

The `last_used_at` write is throttled to once a minute per key. Without that, every API
call would cost a write to the tenant database.

`revokeApiKey` deletes the row and raises `notFound()` when nothing was deleted, so a key
that is already gone looks the same as one that never existed.

Tests: `isolation.test.ts` › "an API key works only on the tenant that issued it",
"suspension cuts off sessions and API keys immediately"; `deletion.adversarial.test.ts` ›
"an API key is refused even if a fresh owner cookie is also sent". The constant-time
comparison itself is covered by `crypto.test.ts` › "timingSafeEqual".
