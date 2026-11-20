# Internals: core control

What `packages/core/src/control` guarantees, and why its SQL is written the way it is.
These modules are the control plane's data layer: tenants, domains, users and
memberships, sessions, sign-in codes, rate limits, jobs, platform settings and the
platform audit log. `apps/admin/worker/index.ts` reaches most of them through
`packages/core/src/platform.ts`; the tenant worker uses the session, job, invitation and
deletion pieces from `packages/core/src/tenant-app.ts`.

The control plane is an identity and routing database. Tenant business data never lives
here (invariant 2 in `AGENTS.md`). Jobs whose payload belongs to a tenant are sealed by
the caller before they are enqueued; this area stores the sealed string and passes it to
the handler without inspecting it.

Most caps and claims in this area come from one conditional statement, so a check and its
write cannot interleave. Cloudflare runs many isolates against one D1 database, and an
unguarded read followed by a separate write is a race. That is why the login-code caps,
the workspace cap, the rate-limit counter, the job claim, the last-owner and role guards,
and the deletion request and cancel use conditional `INSERT ... SELECT`, conditional
`INSERT ... ON CONFLICT DO UPDATE` and conditional `UPDATE ... WHERE` / `DELETE ... WHERE`
statements (with compare-and-set on the observed state where a preceding read authorises
the write). The `last_seen_at` refresh still reads and then writes without a guard; the
Known limits section lists what that leaves open.

## `audit.ts`

`writePlatformAudit` is the operator plane's audit trail. `AuditEntry` rows go to
`platform_audit` with an actor, action, optional target, optional JSON metadata and the
client IP. Tenant activity is recorded in the tenant's own storage through the tenant
audit API instead, so the control plane never becomes a shadow copy of tenant history.
`listPlatformAudit` searches actor, target and action with an escaped `LIKE`, filters
`action` by prefix, orders newest first and returns one page. Covered by "manages the
tenant lifecycle with audit trail" (`apps/admin/worker/test/admin.test.ts`), which also
checks the delete and cancel entries.

## `settings.ts`

`putSetting` writes an operator-plane setting, and when the value is flagged secret it
seals it with `sealPlatformSecret` before the row is written. `getSetting` opens it again
on read. The setting key is the AES-GCM associated data (`rose:platform:<key>` in
`packages/core/src/crypto.ts`), so a ciphertext copied into another setting's row fails
to open instead of decrypting.

`putSetting` upserts on `platform_settings.key`, so writing the same key twice replaces
the value and the `sealed` flag together. Covered by "reports setup health and encrypts
stored secrets" (`apps/admin/worker/test/admin.test.ts`), which reads the raw column and
asserts the plaintext is absent.

## `users.ts`

### Users and email

`normalizeEmail` trims, lowercases and validates with zod, then returns the canonical
address. Every lookup and every uniqueness decision uses that canonical form, so case or
whitespace variants cannot create a second identity with a fresh rate-limit or workspace
budget. `ensureUser` inserts with `ON CONFLICT (email) DO NOTHING` and reads the row
back, so concurrent first sign-ins converge on one user id.

### Memberships and roles

`ROLES` is `owner`, `admin`, `member`. `changeMemberRole` and `removeMember` enforce two
rules that are not expressible as a database constraint:

- only an owner may grant or revoke the owner role, or remove an owner;
- a workspace keeps at least one owner, so demoting or removing the last owner is a
  conflict, not a silent lockout.

Both functions read the target's role first to authorise the actor (and the member routes
in `tenant-app.ts` pass the role they used for their `freshForOwnerChange` check as
`expectedRole`), then guard every write—demotions, promotions and removals—with
`AND role = ?` alongside the last-owner predicate
(`role != 'owner' OR (SELECT COUNT(*) FROM ... WHERE role = 'owner') > 1`) on demotions
and removals. That prevents both a concurrent last-owner lockout and a stale-role bypass
such as an admin removing or demoting a member who was just promoted to owner. When the
guarded statement changes zero rows, the function reads the row again: if it is gone it
throws `notFound()`, if an owner was being demoted or removed and is still an owner it
throws the last-owner `conflict`, and otherwise it throws `conflict` asking the caller to
reload.

`removeMember` deletes the membership, that user's sessions in that tenant and that
user's passkeys in that tenant in one batch, guarding the session and passkey deletes with
`NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?)` so a
refused removal leaves the staying member's sessions and passkeys intact while a committed
removal ends access on the next request rather than at the next sign-in. Covered by
`packages/core/test/control-users.test.ts` (including concurrent cross-removal,
cross-demotion, double-removal, admin-removal-vs-promotion and promotion-vs-removal races)
and "only owners can invite owners or change owner access; last owner is protected"
(`packages/core/test/auth.test.ts`).

### Invitations

An invitation is a pending membership for an email address, not a token. `createInvitation`
stores the address, role, inviter and a seven-day expiry; it refuses an address that is
already a member, and only an owner may invite another owner. There is no invitation
link that could be forwarded or leak, because `redeemInvitation` grants the membership
when that address proves control of the mailbox by signing in on the workspace. The
upsert on `(tenant_id, email)` means re-inviting an address replaces the role and expiry
instead of creating a second row.

`getPendingInvitation` filters on `expires_at > now`, so an expired invitation behaves
like no invitation. `redeemInvitation` inserts the membership with `ON CONFLICT DO
NOTHING` and deletes the invitation in one batch, and returns the granted role.
Covered by "invited address joins by proving the email; nobody else can",
"an address without an invitation is refused and leaves no join entry" and "an
invitation in one workspace does not admit (or audit) the person in another"
(`packages/core/test/auth.test.ts`, `packages/core/test/join-audit.test.ts`).

### Operators

`PLATFORM_SCOPE` is exported but unused; the code uses the literal `"platform"`. Operator
sessions, passkeys and challenges use that literal like a tenant id, so the same session
code serves both realms without
sharing rows. `addOperator` creates the user if needed and inserts with `ON CONFLICT DO
NOTHING`; a second add is a conflict, not a silent role change. `removeOperator` reads
the operator's role first, guards the conditional `DELETE` on `operators` with
`AND role = ?` and the last-owner predicate, and guards the platform session and passkey
deletes in the same batch with `NOT EXISTS (SELECT 1 FROM operators WHERE user_id = ?)`.
On zero changed rows it reads the row again to distinguish `notFound()`, a concurrent
role change (`conflict`), and the last-owner `conflict`, so concurrent removal of the
last two platform owners always leaves one owner with intact sessions and passkeys and a
double removal returns `notFound()` to the loser. Covered by
`packages/core/test/control-users.test.ts` and "only owners manage operators and
connections; the last owner can not be removed" (`apps/admin/worker/test/admin.test.ts`).

## `tenants.ts`

### Slugs and creation

`RESERVED_SLUGS` holds names that would collide with platform hosts or look official
(`www`, `admin`, `api`, `support`, `security`, and so on). `validateSlug` lowercases,
requires 3 to 40 lowercase letters, digits or single hyphens, rejects a leading or
trailing hyphen and rejects `--`, then rejects a reserved name. `slugAvailable` returns
false for an invalid slug as well as a taken one, so a caller cannot use it to probe the
reserved list. Covered by "rejects reserved, malformed and taken addresses"
(`packages/core/test/auth.test.ts`).

`createTenant` is the uncapped primitive used by test fixtures and
`packages/core/src/testing`; the application creates workspaces through
`createTenantForOwner`. That function makes the tenant insert and the owner membership
insert one batch, and the tenant insert only
happens while the user owns fewer than `cap` workspaces (owner memberships on tenants
that are not `deleting`). A caller that loses the race gets `null` and nothing is
written; a `UNIQUE` failure on the slug becomes a conflict. The workspace cap is
therefore enforced by the statement, not by a preceding count. Covered by "concurrent
creates with separate tickets cannot exceed the cap" and "rejection writes no tenant,
membership, audit row and does not consume the ticket"
(`packages/core/test/workspace-cap.adversarial.test.ts`).

`countOwnedWorkspaces` counts owner memberships on tenants whose status is not
`deleting`. Suspended and `pending_deletion` workspaces still count, so suspending a
workspace or scheduling its deletion does not free a slot; only a workspace whose purge
has begun stops counting. Covered by "does not count workspaces being deleted, but counts
pending-deletion and suspended ones" (`packages/core/test/auth.test.ts`).

### Listing and bulk status

`listTenants` filters by name or slug and by status, sorts through `orderBy` with an
allow-list and returns members and domains counts as correlated subqueries.
`setTenantStatus` accepts explicit ids or the same filter used for a server-side
select-all. Both branches add `status NOT IN ('pending_deletion', 'deleting')`, so a
bulk suspend or resume can never revive a tenant that is being deleted. Only
`cancelTenantDeletion` can undo a pending deletion.

### Deletion lifecycle

The lifecycle has four states and one legal path forward:

```
active / suspended --requestTenantDeletion--> pending_deletion --beginTenantPurge--> deleting --> (rows removed)
        ^                                            |
        +-------- cancelTenantDeletion --------------+
```

- `DELETE_GRACE_MS` is 48 hours. `delete_after` is the epoch-ms deadline; `prior_status`
  records what to restore if the deletion is cancelled.
- `requestTenantDeletion` runs the transition and the purge-job insert in one `db.batch`:
  a conditional `UPDATE tenants ... WHERE id = ? AND status IN ('active', 'suspended')`
  moves the tenant to `pending_deletion` and records `prior_status` and `delete_after`; an
  immediately following `INSERT INTO jobs (...) SELECT ... WHERE changes() = 1` inserts the
  platform-scoped `tenant.purge` job only for the request whose `UPDATE` actually matched;
  the same batch deletes the tenant's sessions and tenant-scoped jobs (guarded on
  `status = 'pending_deletion' AND delete_after = ?`, leaving the `"platform"`-scoped
  purge job intact) and reads back `status, delete_after`. When the `UPDATE` matched
  (`created: true`), it returns `{ deleteAfter, created: true, jobId }`; when another
  request already moved the tenant to `pending_deletion`, it returns `{ deleteAfter,
  created: false }` with the stored deadline from the batch read-back (refusing missing or
  `deleting` tenants with 404). Callers call `notifyJob` and write the
  `tenant.delete.requested` audit row only when `created` is true, so concurrent delete
  requests converge on one purge job, one audit entry, one queue notification and the same
  stored deadline.
- The tenant stops serving authenticated requests immediately: the session query joins
  the tenant and requires `status = 'active'`. Host-level routing can lag by the host
  cache TTL on other isolates, which is why the tenant-app owner-deletion route also
  calls `invalidateHostCache()`; the operator deletion route relies on the TTL alone.
  Covered by "existing sessions and API keys stop working as soon as deletion is
  requested" and "over HTTP: a suspension is visible on every request within TTL + margin,
  and authenticated access is refused immediately"
  (`packages/core/test/deletion.adversarial.test.ts`,
  `packages/core/test/session-idle.adversarial.test.ts`).
- `cancelTenantDeletion` performs no pre-check and runs a single atomic `db.batch`. Before
  the status transition, guarded deletes (`AND EXISTS (SELECT 1 FROM tenants WHERE id = ?
  AND status = 'pending_deletion')`) clear sessions, login codes, handoffs and WebAuthn
  challenges for the scope as well as the queued `tenant.purge` job (`DELETE FROM jobs WHERE
  type = 'tenant.purge' AND status = 'queued' AND json_extract(payload, '$.tenantId') = ?`),
  so a losing cancel leaves rows untouched once the tenant is no longer `pending_deletion`.
  The batch then reads `delete_after` and finishes with the conditional `UPDATE tenants ...
  WHERE id = ? AND status = 'pending_deletion' RETURNING status` (restoring `prior_status`
  via `CASE` and clearing `delete_after` and `prior_status`), returning
  `{ status, deleteAfter } | null`. Because both `requestTenantDeletion` and
  `cancelTenantDeletion` pair the status update and purge-job mutation in a single
  transaction, racing deletes and cancels cannot strand a `pending_deletion` tenant without
  a queued purge job or leave a stray queued purge job on an active/suspended tenant.
  Covered by the concurrent race tests in `packages/core/test/deletion.adversarial.test.ts`
  and `apps/admin/worker/test/deletion.adversarial.test.ts`.
- `beginTenantPurge` is the only writer of `status = 'deleting'`. Its single statement
  requires `pending_deletion`, a non-null deadline and `delete_after <= now`, so an
  early, forged or repeated purge attempt writes nothing. The tenant worker's
  `tenant.purge` handler calls it, then destroys tenant storage, then calls
  `deleteTenantRecords`. Covered by the "purge never runs before delete_after" suite in
  `packages/core/test/deletion.adversarial.test.ts`.
- `deleteTenantRecords` removes the tenant's control-plane rows in one batch: sessions,
  jobs, passkeys, login codes, handoffs, challenges, invitations, memberships, domains,
  and finally the tenant row itself with `status = 'deleting'` as a guard. It runs after
  the tenant database is gone; it never touches tenant data.

### Dashboard aggregates

`tenantCounts` groups by status and adds a `total`. `tenantSignupSeries` counts tenants
per UTC day for the last `days` days (default 14), oldest first, zero-filled, which keeps
the chart continuous when a day has no sign-ups.

## `domains.ts`

`validateHostname` trims, lowercases and drops a trailing dot, then requires a full
lowercase DNS name of 4 to 253 characters. It refuses any host equal to the platform
base domain or under it. A custom domain may never shadow the platform's own namespace,
because hosts under the base domain are assigned automatically and would collide with
tenant routing. It normalises instead of accepting a variant, so `App.Customer.com` and
`app.customer.com.` cannot become two rows. Covered by "custom domains can not shadow the
platform namespace or another tenant" (`apps/admin/worker/test/admin.test.ts`).

`addDomain` inserts as `pending` and maps a `UNIQUE` failure to a conflict, so a hostname
belongs to one tenant. `setDomainState` uses `COALESCE` for `provider_id`, which lets the
verification job record a provider id once and leave it alone on later status updates.
`listDomains`, `getDomain` and `removeDomain` are plain control-plane reads and writes;
`domainCounts` groups by status for the console overview.

## `sessions.ts`

### Session tokens

A session is created for exactly one scope: a tenant id, or `"platform"`. `createSession`
generates a random token, stores only its SHA-256 in `id_hash` and returns the token to
the caller, so a database leak does not yield usable sessions. The raw token is the
cookie value and exists only on the client. Covered by "stores only keyed hashes of codes
and hashes of session tokens" (`packages/core/test/auth.test.ts`).

`readSession` resolves a token for a scope the caller supplies, and that scope comes from
the request host, never from the client. A tenant-scoped read joins `memberships` on
`(user_id, scope)` and `tenants` on `(id, scope)` with `status = 'active'`; a platform
read joins `operators`. A token issued for tenant A is simply not found on tenant B, and
removing a member or suspending a tenant takes effect on the very next request. Covered
by "session tokens are scoped, and expire" (`packages/core/test/auth.test.ts`) and "the
idle rule does not leak across tenants: B's cookie replayed on A's host stays refused"
(`packages/core/test/session-idle.adversarial.test.ts`).

### Expiry

There are two limits:

- `SESSION_TTL` is 7 days, the absolute lifetime written into `expires_at`.
- `SESSION_IDLE_TIMEOUT` is 12 hours. A session unused for that long is refused even
  inside its absolute lifetime, because both reads require
  `expires_at > now AND last_seen_at > now - SESSION_IDLE_TIMEOUT`.

`readSession` refreshes `last_seen_at` check-then-write when the row is more than
`TOUCH_INTERVAL` (5 minutes) old. The check and the write are separate statements, so
parallel requests each write. That interval is far below the idle timeout, so an active
person is never signed out by
the idle rule, and a busy client does not write to the database on every request. An
idle refusal does not touch the row, so it cannot revive itself. `listSessions` applies
the same two conditions and returns at most 50 rows; `revokeSessionById` filters by
public id, user id and scope, so one person cannot end another person's session and a
cross-tenant id answers 404. Covered by the "idle timeout through the tenant request
path" suite, including "last_seen_at is written at most every TOUCH_INTERVAL" and
"a session used every 11h59m for 7 days stays alive until absolute expiry, then dies"
(`packages/core/test/session-idle.adversarial.test.ts`).

### Handoffs

A handoff is a single-use, short-lived token that carries a verified identity across
hosts: a signup on the root host handing a session to the tenant host, or a session
transfer with purpose `"session"`. `createHandoff` stores the SHA-256 of the token, the
purpose, user id, scope and an expiry (60 seconds by default).

`consumeHandoff` deletes the row with `DELETE ... WHERE token_hash = ? AND purpose = ?
AND scope = ? AND expires_at > now RETURNING user_id`. Reading and deleting in one
statement is what makes it single use; a purpose or scope mismatch returns no row, so a
ticket cannot be replayed on another host or for another flow. `peekHandoff` reads the
same predicate without deleting, so a caller can refuse a request before the ticket is
spent; the tenant worker uses it to check the workspace cap before consuming the signup
ticket, which keeps a refusal from burning the person's verification. Covered by
"handoffs are single use and bound to purpose and tenant" and "a handoff for tenant A
does not sign you in to tenant B" (`packages/core/test/auth.test.ts`), and by "a session
handoff into a pending tenant mints no session"
(`packages/core/test/deletion.adversarial.test.ts`).

### Housekeeping and freshness

`sweepExpired` deletes expired or idle sessions, expired handoffs, expired challenges,
expired invitations and expired `rate_limits` rows
(`DELETE FROM rate_limits WHERE window_start <= ?` with `t - RATE_LIMIT_WINDOW_MS`), and
deletes login codes an hour past expiry. It is safe to run at any time and both workers
call it from their hourly tick. The extra hour on login codes is deliberate: a code
expires after 10 minutes but still counts toward the 70-minute guess window in `otp.ts`,
so deleting it at expiry could drop guesses from that window. One hour is well past the
window.

`FRESH_SIGN_IN_MS` is 10 minutes. `SessionInfo.createdAt` is the sign-in time (the
session row's `created_at`), not the last activity, which is exactly what makes it usable
as a freshness measure. `assertFreshSession` throws `reauth_required` unless `createdAt`
is within that window, and, when `opts.passkey` is set, unless the session was created by
a passkey. It also refuses a `createdAt` in the future (`age < 0`), so a
clock skew cannot manufacture freshness. The check guards irreversible actions such as a
tenant deletion and passkey changes; the error message names the passkey requirement
when that is the failing rule. Covered by "a session just over 10 minutes old is
refused, regardless of method" (`packages/core/test/deletion.adversarial.test.ts`) and
"a stale session can not enrol or remove passkeys"
(`apps/admin/worker/test/admin.test.ts`).

## `otp.ts`

### What is stored

A sign-in code is six random digits, valid for `CODE_TTL` (10 minutes). The row stores an
HMAC of the code, keyed with a derived key and bound to `scope\0email\0code`, so the
stored value cannot be brute-forced offline from a database dump and a code issued for
one tenant cannot be replayed against another. The caller receives the code itself to
deliver it. Covered by "stores only keyed hashes of codes and hashes of session tokens"
(`packages/core/test/auth.test.ts`).

Every code also carries a sign-in key: 100 random bits, encoded as 20 Crockford base32
characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I/L/O/U). Rejection sampling keeps the
distribution uniform. The row stores an HMAC of the key (`link_hash`), bound to
`scope\0email\0key` under the label `login-link/v1`, so a key for one tenant or address
is useless on another. The key shares the row's `consumed_at` and `expires_at`, so using
either the code or the key kills both. The mail carries the key as
`XXXXX-XXXXX-XXXXX-XXXXX` and as a `#k=` fragment link; the client normalises a typed key
by stripping dashes and spaces, upper-casing and mapping `I`/`L` to `1` and `O` to `0`,
which is what Crockford's alphabet is for.

The requester is stored as a keyed hash (`requesterHash`) rather than the client address,
so the control plane holds no raw client addresses. The hash key is derived separately
from the code key, which keeps the two values from being interchangeable. Pre-migration
rows have a `NULL` requester: they are foreign to everyone, count toward the per-address
cap, and count toward no requester's limit. Covered by "the requester column never stores
the raw client address" and "a pre-migration row with NULL requester still verifies (from
any address)" (`packages/core/test/otp-requester.adversarial.test.ts`).

### Request caps

`issueLoginCode` checks and inserts in one statement. The `INSERT ... SELECT` has three
`WHERE` subqueries: at most `MAX_CODES_PER_EMAIL` (20) rows for the address in the last
15 minutes, at most `MAX_CODES_PER_REQUESTER` (5) rows for the same requester and address
in that window, and no code at all for the address in the last `SEND_GAP_MS` (2 minutes).
If the insert changes no rows the caller gets `tooMany`. In development that surfaces as
a 429; in production `requestCode` runs the issue inside `waitUntil` after answering, so
a request past the cap is refused silently and the person still sees the same
`{ ok: true }` as everyone else. Doing the count and the insert together means parallel
requests cannot all pass the cap check. The per-address cap is a mail-bomb backstop and
sits well above what one requester can reach, so one client cannot spend the whole
address budget. Covered by "parallel requests from many requesters do not overshoot the
per-email cap" and "parallel requests from one requester do not overshoot the
per-requester limit" (`packages/core/test/otp-requester.adversarial.test.ts`).

The 2-minute gap is checked twice: a preceding read returns `undefined` so `requestCode`
stays silent (no mail, same `{ ok: true }` as an ineligible address), and the same
predicate appears in the `INSERT ... SELECT` guard so two parallel requests cannot both
send a mail in the same 2-minute window. The gap is what actually bounds mail volume;
the 20-per-address cap is now a defence-in-depth backstop that normal issuance can no
longer reach (one code per 2 minutes is about 8 per 15 minutes).

### Verify: candidates and budgets

`verifyLoginCode` considers at most two rows:

1. the requester's newest code for `(scope, email)`;
2. the newest code for `(scope, email)` overall.

The second exists so a person can use the code that was emailed last after their address
changed. A code belongs to its requester, so another requester's request never supersedes
it, and the two candidate rows are usually different.

A row is live when it is unconsumed, unexpired and its relevant budget is unspent. The
code's own requester spends `attempts` (limit `MAX_ATTEMPTS`, 5). Anyone else spends
`foreign_attempts` (limit `MAX_FOREIGN_ATTEMPTS`, 3). The foreign budget is shared by all
strangers, so a stranger can never exhaust the owner's guesses, and total guesses on one
code stay bounded at 8. The newest overall row is treated as foreign when it is not the
requester's own row, including when its requester is `NULL`.

Each lookup takes the single newest row first (`ORDER BY created_at DESC, rowid DESC`)
and only then checks whether it is live. Consuming or exhausting the newest code
therefore hides older codes; there is no resurrection of an older code after the newer
one is used up. `rowid` breaks ties between codes issued in the same millisecond.

### Verify: the write path

The comparison and the spend are separate on purpose:

- Every candidate is compared with `timingSafeEqual`, with no early exit. Candidates are
  then ordered with a match first. This order matters at the guess cap: the last allowed
  guess must go to the matching candidate, never to a non-matching one.
- For each candidate in that order, one conditional `UPDATE` spends a single attempt from
  the right budget. The same statement also requires the row to be live and requires the
  address-wide guess total to be under `MAX_GUESSES_PER_EMAIL`, so a spend can never push
  past a cap. If the statement changes no row, the candidate is skipped and that guess
  spends nothing on it.
- The first matching candidate whose spend succeeded is consumed by
  `UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`. Success is one
  changed row, so two concurrent verifies cannot both accept the same code.

At the cap, a correct code answers `false` like any wrong code and spends nothing.
Covered by the `otp-guess-cap`, `otp-cap-edge`, `otp-verify` and `otp-verify.adversarial`
suites, including "at 10 the correct code is refused and nothing is spent or consumed",
"at 98 with two candidates a wrong guess spends on both (no free comparisons) and reaches
the cap", "owner and stranger both sending the right code in parallel: exactly one
succeeds" and "after the owner's newest code is consumed, its older code is dead".

### The per-address guess cap

`MAX_GUESSES_PER_EMAIL` is 10 guesses, counted as
`SUM(attempts + foreign_attempts)` over all codes of one `(scope, email)` created within
`GUESS_WINDOW`, which is 60 minutes plus `CODE_TTL` (70 minutes total). The window is the
proof, not an estimate: a guess can only land on a code created at most `CODE_TTL`
(10 minutes) before it, so counting codes from 70 minutes back covers every code a guess
in any 60-minute span could touch. That bounds the typed path at 10 guesses per account
per hour, or ≤ 1e-5 per account per hour against a 6-digit code.

The cap is per `(scope, email)`, so exhausting one tenant's address does not affect the
same address on another tenant. Covered by "cap is per (scope, email): another scope or
another address is unaffected" (`packages/core/test/otp-guess-cap.adversarial.test.ts`).

### The sign-in key

`verifyLoginKey` redeems the key with one atomic
`UPDATE ... SET consumed_at = ? WHERE email = ? AND scope = ? AND link_hash = ?
AND consumed_at IS NULL AND expires_at > ?`. It reads and writes only `consumed_at`: it
never touches `attempts`, `foreign_attempts` or the per-address guess cap. That is the
whole point — after an attacker burns all 10 typed guesses, the person who received the
mail still signs in with the key from any requester. The key is at least 64 bits of
entropy and is not rate-limited per account, so no number of attacker IPs can exhaust it
(NIST 800-63B §3.1.3, ASVS 6.6.3). The route applies the same per-requester
`verify-ip`/`verify` rate limits as `/code/verify`, and every failure returns the same
401 `BAD_CODE` as an unknown, expired or consumed key, so the endpoint reveals nothing
about whether the address exists or is locked.

## `rate-limit.ts`

`rate-limit.ts` implements the strongly consistent global rate-limit counter called by
`rateLimit` in `http/base.ts`. It exports `RATE_LIMIT_MAX` (20), `RATE_LIMIT_WINDOW_MS`
(60,000 ms) and `consumeRateLimit(db, masterKey, key, opts?)`, where `opts` takes only an
optional `limit` (defaulting to `RATE_LIMIT_MAX`; values `<= 0` refuse immediately without
writing a row) and the window length is always `RATE_LIMIT_WINDOW_MS`. The backing table
`rate_limits (key_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT
NULL)` and its `rate_limits_window (window_start)` index live in
`packages/core/migrations/0006_rate_limits.sql`.

### Why D1 rather than a Durable Object

Both the tenant worker and the operator console (`apps/admin`) need durable rate limiting
on their auth endpoints, but `apps/admin` is forbidden from binding Durable Objects
(`admin-isolation` guard rule and invariant 7 in `AGENTS.md`). Both workers already bind
the control-plane D1 database (`DB`), so storing counter rows in D1 preserves
operator-console isolation and needs no changes to `wrangler.jsonc` or
`wrangler.production.jsonc` bindings. Because D1 serialises writes on its primary, a
single conditional write cannot be overshot by reconnecting clients or parallel bursts.

### Key hashing and realm isolation

`consumeRateLimit` never stores raw keys in D1. It hashes `key` as HMAC-SHA256 hex
(`hmacHex`) with a key derived from `masterKey` using the label `"rate-limit/v1"`
(`deriveHmacKey(masterKey, "rate-limit/v1")`), so no raw client IP addresses or email
addresses are stored in `rate_limits`. Because the tenant worker and the operator console
each have their own `ROSE_MASTER_KEY`, the same key string hashes to distinct `key_hash`
values per worker, isolating their rate-limit budgets automatically inside the shared
table.

### Atomic counter, window expiry and clock skew

Enforcement is one atomic SQLite conditional upsert (`INSERT INTO rate_limits ... ON
CONFLICT (key_hash) DO UPDATE SET ... WHERE excluded.window_start -
rate_limits.window_start >= ? OR rate_limits.count < ? RETURNING count`):

- **First hit**: inserts `(key_hash, now, 1)` and returns `count = 1` (allowed).
- **Active window (`now - window_start < RATE_LIMIT_WINDOW_MS`)**: increments `count` and
  leaves `window_start` unchanged while `count < limit`. Once `count` reaches `limit`, the
  `WHERE` predicate fails, no row is updated, `RETURNING count` yields no row and
  `consumeRateLimit` refuses the request.
- **Window expiry**: at the exact boundary `now - window_start >= RATE_LIMIT_WINDOW_MS`,
  the conflict branch resets `window_start` to `now` and `count` to `1`, opening a new
  window in the same atomic write. Stale rows are also purged on the hourly cron by
  `sweepExpired`.
- **Clock skew**: if the clock moves backwards (`now < window_start`),
  `now - window_start` is negative and therefore never satisfies
  `>= RATE_LIMIT_WINDOW_MS`. Backward clock skew cannot prematurely reset an active window
  or extend the budget; requests keep counting against the existing row until `now` passes
  `window_start + RATE_LIMIT_WINDOW_MS`.

Covered by `packages/core/test/rate-limit.test.ts`.

## `jobs.ts`

### The row is the source of truth

A queue message carries only `{ jobId }`. The `jobs` row holds the type, scope, title,
payload, status, attempts, claim token, `run_after` and the outcome. Anything reading a
job reads the row; a message is just a wake-up call.

`JobEnv` is what a job function needs: the control-plane `DB` and, when deployed, the
`APP_JOBS` and `ADMIN_JOBS` queues. The queue bindings are optional so the worker still
runs locally and in tests, where the sweep does the work a queue would have woken.

`enqueueJob` inserts a `queued` row with `run_after = now + delayMs`, reads it back and
then calls `notifyJob`. `notifyJob` is best effort: it picks the queue by ownership
(`ADMIN_JOB_TYPES`, currently only `domain.verify`, goes to `ADMIN_JOBS`; everything else
runs in the tenant worker and goes to `APP_JOBS`), and a missing binding or a failed send
is logged and ignored. A lost or missing message is not fatal, because the job row stays
`queued` and the hourly sweep picks it up. The queue delay is capped at
`MAX_QUEUE_DELAY_S` (12 hours); a longer deadline stays on `run_after`, and the consumer
ignores a message that arrives more than a second early, so the sweep is what wakes the
job when it is actually due. Covered by "queuing a job wakes the right worker, and the
message runs it exactly once" (`packages/core/test/isolation.test.ts`), which asserts a
message for a job that is not due yet does nothing. The 12-hour cap and the one-second
early boundary are not covered by a test.

### Delivery, claims and ownership

Delivery is at least once: a queue message, a redelivery and the sweep can all race for
the same row. Two things have to hold for that to be safe.

A handler body has to be safe to run again, and that is the module author's job. The
framework cannot check it: `tenantJobHandlers` wraps `tenant.purge` and every module job in
`idempotent()`, which only sets a flag on the wrapper. "every registered tenant handler
declares itself idempotent" (`packages/core/test/jobs-stale-reclaim.test.ts`) pins the
wrapper and `tenant.purge`. It runs a stub module job that returns at once, so it proves
the flag is set, not that a module's own work can be repeated.

`runOne` claims with an atomic compare-and-set on the row's current `status` and
`updated_at`, setting `status = 'running'`, incrementing `attempts` and writing a fresh
`claim` token. A loser changes no rows and returns without running the handler. Every
outcome write is guarded by `id = ? AND status = 'running' AND claim = ?`, so a run that
lost ownership cannot overwrite the newer run's result. The token, not the attempt
count, is the identity of a run: `attempts` can be reset by an operator retry, so it
cannot distinguish runs. Covered by the `jobs-stale-reclaim` suites, including "a stale
run that also succeeds does not overwrite the reclaimer's result", "a stale run cannot
overwrite a newer run after an operator retry reset the attempt counter" and "an
uncontended run still records every outcome (the guard is not over-strict)".

`STALE_RUNNING` is 5 minutes. The sweep also selects rows stuck in `running` whose
`updated_at` is older than that. A slow worker can therefore overlap its reclaimer. The
claim token stops the older run from writing its outcome. The overlap is safe only if the
handler body survives a second concurrent run, and the module author gives that guarantee
when the job is written. The framework does not enforce it.

### Outcomes and retries

A handler returns `{ done: true, result? }` or
`{ done: false, retryInMs, note? }`.

- Success writes `status = 'succeeded'`, clears the payload to `{}` so the sealed string
  does not linger, and stores the result.
- A retry writes `status = 'queued'`, sets `run_after = now + retryInMs`, records the
  note as the error and re-notifies. The handler chooses the wait.
- A thrown error is retried with backoff `2 ** attempts * 15 s` (using the attempt count
  from before the claim) until `MAX_ATTEMPTS` (5), then the job is `failed` and its payload
  is cleared. An `AppError` stores its message, cut to 500 characters. Anything else stores
  a fixed sentence and the detail is only logged. A final failure is not re-notified.

`runJobMessages` always acknowledges, including for a malformed body, a missing row, a
job that is already done, or a handler that threw. Retries are scheduled by this code
and recorded on the row, not requested by leaving the message unacked, so a poison
message cannot loop through the queue. A message that arrives more than one second early
is skipped but still acknowledged; nothing re-notifies it, and the sweep is what wakes
the job when it is due.

`runDueJobs` is the safety net: it selects up to `limit` (10) jobs of the registered
types that are due and either `queued` or stuck `running`, oldest deadline first, and
runs each through the same claim.

### Listing and retry

`listJobs` returns jobs for one scope, or every scope when the scope is `null`. The
tenant route passes its own tenant id. The operator console passes `"platform"`, so
Activity and the overview count only platform work. The status filter is an allow-list.
The response also carries `active`, the count of queued and running jobs for the scope,
so the UI can show pending work without a second query.

`retryJob` resets only a `failed` job in the given scope: `status = 'queued'`,
`attempts = 0`, no error, a fresh `run_after`, returning the type so the right queue
can be notified. A job that is not failed, or not in that scope, is 404 and unchanged.
The operator console passes `"platform"`. The reset attempt count is exactly why the
claim token is used for ownership.

## Known limits

- **The `last_seen_at` refresh is check-then-write.** `readSession` reads the row, then
  writes a fresh `last_seen_at` in a separate statement when the row is older than
  `TOUCH_INTERVAL`. Parallel requests that read the same old value each pass the check and
  each write, so "at most once" holds only for a single request at a time.
- **Host routing lags on other isolates.** A pending or suspended tenant is refused
  immediately by `readSession`, but another isolate may route its host from a cached
  lookup until the host cache TTL expires. Only the tenant-app owner deletion, the
  workspace rename and the `tenant.purge` job (after `deleteTenantRecords`) call
  `invalidateHostCache()`, each in its own isolate; operator suspension and the operator
  deletion request rely on the TTL alone.
- **`createTenant` is uncapped.** It exists for fixtures and tests. Only
  `createTenantForOwner` enforces the workspace cap, and the operator console has no
  tenant-creation route, which is covered by "the console has no route to create a tenant
  or invite its owner; sign-up is the only path"
  (`apps/admin/worker/test/admin.test.ts`).
- **The D1 rate limiter uses a fixed 60 s window.** A key's window starts on its first
  request (`window_start`) and resets once `now - window_start >= RATE_LIMIT_WINDOW_MS`,
  so up to `2 × 20 - 1 = 39` requests (19 at the end of one window after the request that
  opened it, plus 20 at the start of the next) can pass across a window boundary. The
  per-code OTP caps in `control/otp.ts` are unaffected.

## Corrections to inline comments

- `requestTenantDeletion`'s "the tenant stops serving" is true for authenticated access
  at once and for host resolution only after the cache TTL on other isolates; see Known
  limits.
- No other comment in this area was found stale. The claim that `beginTenantPurge` is the
  only path into `deleting` was checked against every write to that column.
