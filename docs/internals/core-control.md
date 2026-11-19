# Internals: core control

What `packages/core/src/control` guarantees, and why its SQL is written the way it is.
These modules are the control plane's data layer: tenants, domains, users and
memberships, sessions, sign-in codes, jobs, platform settings and the platform audit
log. `apps/admin/worker/index.ts` reaches most of them through
`packages/core/src/platform.ts`; the tenant worker uses the session, job, invitation and
deletion pieces from `packages/core/src/tenant-app.ts`.

The control plane is an identity and routing database. Tenant business data never lives
here (invariant 2 in `AGENTS.md`). Jobs whose payload belongs to a tenant are sealed by
the caller before they are enqueued; this area stores the sealed string and passes it to
the handler without inspecting it.

Most caps and claims in this area come from one conditional statement, so a check and its
write cannot interleave. Cloudflare runs many isolates against one D1 database, and a
check followed by a separate write is a race. That is why the login-code caps, the
workspace cap and the job claim are conditional `INSERT ... SELECT` and conditional
`UPDATE ... WHERE` statements rather than read-then-write code. Some paths still read and
then write in separate statements: the deletion request and cancel, and the last-owner
checks. The Known limits section lists the races they leave open.

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

`removeMember` deletes the membership, that user's sessions in that tenant and that
user's passkeys in that tenant in one batch. Removing someone therefore ends their
access on the next request rather than at their next sign-in. Covered by "only owners
can invite owners or change owner access; last owner is protected"
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

`PLATFORM_SCOPE` is the literal scope `"platform"`; operator sessions, passkeys and
challenges use it like a tenant id, so the same session code serves both realms without
sharing rows. `addOperator` creates the user if needed and inserts with `ON CONFLICT DO
NOTHING`; a second add is a conflict, not a silent role change. `removeOperator` refuses
to remove the last platform owner and, in one batch, deletes the operator row, the
platform session rows and the platform passkey rows for that user. Covered by "only
owners manage operators and connections; the last owner can not be removed"
(`apps/admin/worker/test/admin.test.ts`).

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
- `requestTenantDeletion` refuses a missing tenant or one already `deleting`. For requests
  that arrive one after the other, a second request while `pending_deletion` returns the
  original deadline and writes nothing, so a retry cannot extend or shorten the grace
  period. Two requests that arrive at the same time are not covered; see Known limits. The
  first request moves the tenant to `pending_deletion`, stores the previous status, deletes
  every session for the scope and deletes the tenant's queued jobs (their `scope` is the
  tenant id). Work a tenant queued
  must not outlive it; the purge job itself has scope `"platform"`, so it survives.
- The tenant stops serving authenticated requests immediately: the session query joins
  the tenant and requires `status = 'active'`. Host-level routing can lag by the host
  cache TTL on other isolates, which is why the caller also calls `invalidateHostCache()`.
  Covered by "existing sessions and API keys stop working as soon as deletion is
  requested" and "over HTTP: a suspension is visible on every request within TTL + margin,
  and authenticated access is refused immediately"
  (`packages/core/test/deletion.adversarial.test.ts`,
  `packages/core/test/session-idle.adversarial.test.ts`).
- `cancelTenantDeletion` restores `prior_status` (or `active` when it is null), clears the
  deadline and the stored status, and only then deletes anything issued during the grace
  period: sessions, login codes, handoffs and WebAuthn challenges for the scope, plus any
  queued `tenant.purge` job whose payload names this tenant. A conditional `UPDATE ... AND
  status = 'pending_deletion'` decides the winner, so a cancel that races the purge
  returns false instead of reviving a tenant that is already being destroyed. Covered by
  "cancel restores the tenant with its data, and members can sign in again" and "cancel
  refuses a tenant whose purge already began".
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

`readSession` refreshes `last_seen_at` at most once per `TOUCH_INTERVAL` (5 minutes).
That interval is far below the idle timeout, so an active person is never signed out by
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

`sweepExpired` deletes expired or idle sessions, expired handoffs, expired challenges and
expired invitations, and deletes login codes an hour past expiry. It is safe to run at
any time and both workers call it from their hourly tick. The extra hour on login codes is
deliberate: a code expires after 10 minutes but still counts toward the 25-minute guess
window in `otp.ts`, so deleting it at expiry could drop guesses from that window. One
hour is well past the window.

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

The requester is stored as a keyed hash (`requesterHash`) rather than the client address,
so the control plane holds no raw client addresses. The hash key is derived separately
from the code key, which keeps the two values from being interchangeable. Pre-migration
rows have a `NULL` requester: they are foreign to everyone, count toward the per-address
cap, and count toward no requester's limit. Covered by "the requester column never stores
the raw client address" and "a pre-migration row with NULL requester still verifies (from
any address)" (`packages/core/test/otp-requester.adversarial.test.ts`).

### Request caps

`issueLoginCode` checks and inserts in one statement. The `INSERT ... SELECT` has two
`WHERE` subqueries: at most `MAX_CODES_PER_EMAIL` (20) rows for the address in the last
15 minutes, and at most `MAX_CODES_PER_REQUESTER` (5) rows for the same requester and
address in that window. If the insert changes no rows the caller gets `tooMany`. In
development that surfaces as a 429; in production `requestCode` runs the issue inside
`waitUntil` after answering, so a request past the cap is refused silently and the person
still sees the same `{ ok: true }` as everyone else. Doing the count and the insert
together means parallel requests cannot all pass the cap check. The per-address cap is a
mail-bomb limit and sits well above what one requester can reach, so one client cannot
spend the whole address budget. Covered by "parallel requests from many requesters do not
overshoot the per-email cap" and "parallel requests from one requester do not overshoot
the per-requester limit" (`packages/core/test/otp-requester.adversarial.test.ts`).

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
suites, including "at 100 the correct code is refused and nothing is spent or consumed",
"at 98 with two candidates a wrong guess spends on both (no free comparisons) and reaches
the cap", "owner and stranger both sending the right code in parallel: exactly one
succeeds" and "after the owner's newest code is consumed, its older code is dead".

### The per-address guess cap

`MAX_GUESSES_PER_EMAIL` is 100 guesses, counted as
`SUM(attempts + foreign_attempts)` over all codes of one `(scope, email)` created within
`GUESS_WINDOW`, which is `WINDOW + CODE_TTL` (25 minutes).

The window is the proof, not an estimate. A guess made at any moment can only land on a
code created at most `CODE_TTL` (10 minutes) before it, because an older code has
expired. Counting codes from 25 minutes back therefore covers every code that a guess in
any 15-minute span could touch, which bounds guesses in any 15-minute span at 100.
Counting only codes created in the last 15 minutes would miss the spends made late in the
life of a code created between 15 and 25 minutes ago, which still fall inside the span.
Covered by "guesses on a code created exactly 25 minutes ago do not count; 1 ms younger
still counts", "sliding span: 100 guesses late in one code's life block new codes 15 min
later, and free up after 25 min" and "in any 15-minute span no more than 100 guesses are
counted, even when rotating windows"
(`packages/core/test/otp-guess-cap.adversarial.test.ts`).

The cap is per `(scope, email)`, so exhausting one tenant's address does not affect the
same address on another tenant. Covered by "cap is per (scope, email): another scope or
another address is unaffected" (`packages/core/test/otp-guess-cap.adversarial.test.ts`).

## `jobs.ts`

### The row is the source of truth

A queue message carries only `{ jobId }`. The `jobs` row holds the type, scope, title,
payload, status, attempts, claim token, `run_after` and the outcome. Anything reading a
job reads the row; a message is just a wake-up call.

`JobEnv` is what a job function needs: the control-plane `DB` and, when deployed, the
`APP_JOBS` and `ADMIN_JOBS` queues. The queue bindings are optional so the worker still
runs locally and in tests, where the sweep does the work a queue would have woken.

`enqueueJob` inserts a `queued` row with `run_after = now + delayMs`, reads it back and
then calls `notify`. `notify` is best effort: it picks the queue by ownership
(`ADMIN_JOB_TYPES`, currently only `domain.verify`, goes to `ADMIN_JOBS`; everything else
runs in the tenant worker and goes to `APP_JOBS`), and a missing binding or a failed send
is logged and ignored. A lost or missing message is not fatal, because the job row stays
`queued` and the hourly sweep picks it up. The queue delay is capped at
`MAX_QUEUE_DELAY_S` (12 hours); a longer deadline stays on `run_after`, and the consumer
ignores a message that arrives more than a second early, so the sweep is what wakes the
job when it is actually due. Covered by "the safety-net sweep does not auto-activate a
domain" and "queue: domain.verify does not auto-activate, job untouched, message not
acked" (`apps/admin/worker/test/environment.adversarial.test.ts`).

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
  from before the claim) until `MAX_ATTEMPTS` (5), then the job is `failed`, its payload
  is cleared, and the error is cut to 500 characters. The `error` column holds the
  exception message and nothing taken from the payload. A final failure is not
  re-notified.

`runJobMessages` always acknowledges, including for a malformed body, a missing row, a
job that is already done, or a handler that threw. Retries are scheduled by this code
and recorded on the row, not requested by leaving the message unacked, so a poison
message cannot loop through the queue. A message that arrives early (within one second of
`run_after`) is skipped and left to its re-notification or the sweep.

`runDueJobs` is the safety net: it selects up to `limit` (10) jobs of the registered
types that are due and either `queued` or stuck `running`, oldest deadline first, and
runs each through the same claim.

### Listing and retry

`listJobs` returns jobs for one scope, or every scope when the scope is `null`. The
tenant route passes its own tenant id; the operator console passes `null`, which is why
that sentence in the code says "operators only". The status filter is an allow-list. The
response also carries `active`, the count of queued and running jobs for the scope, so
the UI can show pending work without a second query.

`retryJob` resets only a `failed` job: `status = 'queued'`, `attempts = 0`, no error, a
fresh `run_after`, returning the type so the right queue can be notified. Retrying a job
that is not failed is 404, and the reset attempt count is exactly why the claim token is
used for ownership.

## Known limits

- **Last-owner checks are not atomic.** `changeMemberRole`, `removeMember` and
  `removeOperator` count owners and then write. No database constraint enforces either
  rule. Two concurrent demotions of the last two owners can both pass the count and leave
  the workspace (or the platform) with no owner. The race needs two simultaneous owner
  actions and is not reachable by one person through the UI, but the inline comment "a
  workspace always keeps at least one owner" is stronger than the code guarantees.
- **A cancel can strip a delete request's purge job.** `cancelTenantDeletion` restores the
  tenant status in one statement and deletes the queued `tenant.purge` job in a second.
  Neither step reads the other's result. A delete request that lands between them sets the
  tenant back to `pending_deletion` and enqueues a job. The cancel's cleanup deletes that
  job if it runs afterwards. The tenant is then pending with no job. A later delete
  request on a pending tenant returns the stored deadline and adds no job. No sweep creates
  one either, so the tenant stays pending until someone cancels the deletion and requests
  it again. Tracked as Noty bug 17887EA7.
- **Two delete requests at once make two purge jobs.** Both delete routes read the tenant
  status to decide whether to enqueue, then call `requestTenantDeletion`. Two concurrent
  requests can both read `active` before either writes. One guarded `UPDATE` sets
  `pending_deletion`; the other changes no row but still returns its own `deleteAfter`,
  computed as `now + DELETE_GRACE_MS`, so that response carries a deadline that does not
  match the stored one. Each request then enqueues a `tenant.purge` job and writes a
  `tenant.delete.requested` audit row. The duplicate does no harm: `beginTenantPurge` moves
  the tenant to `deleting` once, and a purge that runs twice only deletes storage and rows
  that are already gone. Tracked as Noty bug E55E9FFF.
- **Host routing lags on other isolates.** A pending or suspended tenant is refused
  immediately by `readSession`, but another isolate may route its host from a cached
  lookup until the host cache TTL expires. The deletion and suspension callers invalidate
  the cache in their own isolate; the TTL covers the rest.
- **`createTenant` is uncapped.** It exists for fixtures and tests. Only
  `createTenantForOwner` enforces the workspace cap, and the operator console has no
  tenant-creation route, which is covered by "the console has no route to create a tenant
  or invite its owner; sign-up is the only path"
  (`apps/admin/worker/test/admin.test.ts`).

## Corrections to inline comments

- `changeMemberRole`'s "a workspace always keeps at least one owner" and
  `removeOperator`'s "The platform needs at least one owner" describe an intention that
  the check-then-write implementation does not hold under concurrency; see Known limits.
- `requestTenantDeletion`'s "the tenant stops serving" is true for authenticated access
  at once and for host resolution only after the cache TTL on other isolates; see Known
  limits.
- `apps/admin/worker/index.ts` line 214, "Already pending: report the existing state; no
  second job, no second audit row", holds only for a request that arrives after the tenant
  is already pending. Two requests that read the tenant at the same moment both see
  `active`, so both enqueue and both audit; see Known limits.
- No other comment in this area was found stale. The claim that `beginTenantPurge` is the
  only path into `deleting` was checked against every write to that column.
