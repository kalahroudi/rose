# Internals: core auth

What `packages/core/src/auth/routes.ts` and `packages/core/src/auth/passkeys.ts` guarantee,
and why they are built the way they are. For the user-facing picture (what a person sees
when they sign in) read [Authentication](../authentication.md) first; this page is the
rationale behind the code.

Both files are on the public surface. `packages/core/src/tenant-app.ts` mounts
`createAuthRoutes` under `/api/auth` and also uses parts of them directly. The root-host
signup flow (`/api/root/code/request`, `/api/root/code/verify`) calls only `requestCode`
and `checkCode`; it issues a signup handoff ticket rather than a session. `startSession`
and `currentSession` serve the handoff (`/auth/handoff`), the `/api/bootstrap` route and
the other session routes.
`packages/core/src/platform.ts` re-exports `createAuthRoutes`, `currentSession`,
`AuthRealm` and `listPasskeys` for the operator console. Anything documented here is a
contract those callers rely on.

## `AuthRealm` (routes.ts)

A realm is "where you are signing in": one tenant, or the operator console. The tenant
realm comes from the request host (`realmFor` in `tenant-app.ts`); the operator realm is
the fixed `"platform"` scope of the console worker (`SCOPE` in
`apps/admin/worker/index.ts`). Neither is taken from request data. The realm carries:

- `scope` and `cookie`. The scope keys every session, passkey, challenge and sign-in code;
  the cookie names the session cookie (tenant: `rose_session`, which becomes
  `__Host-rose_session` on HTTPS; operator: its own admin cookie). A session read for one
  scope can not see another scope's rows (proven by "session tokens are scoped, and
  expire" in `packages/core/test/auth.test.ts`).
- `eligible(email)`, which decides whether an address may receive a sign-in code here. It
  must be side-effect free, because it also runs for addresses that will get nothing.
- `admit(user)`, which runs only after identity is proven, and confirms or grants access
  (for a tenant, this is where a pending invitation is redeemed). Returning false refuses
  sign-in.
- `audit(event)`, which writes the login and passkey events to the realm's own audit log
  (tenant audit in the tenant's database, platform audit for the console).
- `enforcePasskey` (optional). When set, a user who has a passkey in this realm can no
  longer sign in with an emailed code. See "Passkey disables emailed codes" below.

`startSession` and `currentSession` are exported because the handoff route and the
`/api/bootstrap` route need the same cookie and scope handling as the auth routes.

## Email codes: `requestCode` and `checkCode` (routes.ts)

- **No account oracle.** `requestCode` answers the same `{ok: true}` whether or not the
  address is eligible, and in production it returns before the send runs. The send is
  handed to `waitUntil`, so the response body and the response timing can not be used to
  discover who has an account. Only when `eligible()` is true is a code issued and mailed.
  Covered by
  "answers identically for members and strangers, and sends strangers nothing"
  (`packages/core/test/auth.test.ts`) and by "a blocked operator looks the same as a
  stranger (no passkey oracle)" (`apps/admin/worker/test/operator-passkey-edge.test.ts`).
- **Development shortcut.** In development and tests (`isDev`) the request is awaited and
  the code comes back as `devCode`, so a person can sign in locally without a mailbox.
  This branch never runs in production.
- **Rate-limit keys are per requester only.** `requestCode` spends `code-ip:<requester>`
  and `code:<scope>:<email>:<requester>`; `checkCode` spends `verify-ip:<requester>` and
  `verify:<scope>:<email>:<requester>`. The requester is the client IPv4 address or the
  IPv6 /64 prefix (`requesterKey`). There is no address-only key, on purpose: one client's
  flood or run of wrong guesses must not spend the budget that the address's real user
  needs to sign in.
- **One error string.** `checkCode` throws `BAD_CODE` ("That code is not valid or has
  expired.") for every failure, so a caller can not tell a wrong code from an expired one
  from a locked one. The per-code guess budgets, the expiry and the lockout all live in
  `control/otp.ts`; see [Authentication](../authentication.md#email-codes) and the
  `otp-*.test.ts` files for their numbers.
- **Order of checks on verify.** The route validates the body, calls `checkCode`, then
  re-checks `codeDisabled`, then `ensureUser`, then `realm.admit`, and only then starts a
  session. A refusal at `checkCode`, `codeDisabled` or `admit` is the same uniform 401
  `BAD_CODE` with no cookie. The earlier steps answer differently: body validation answers
  400 (not JSON or missing `Content-Type`), 413 (body over the size cap) or 422 (a field
  that fails the schema), and the rate limits in `checkCode` answer 429.
- The request and verify bodies are bounded before parsing (`email` at most 254
  characters, `code` must be exactly six digits after trimming), so oversized input never
  reaches the code store.

## Passkey disables emailed codes: `codeDisabled`, `enforcePasskey` (routes.ts)

When a realm sets `enforcePasskey`, an address whose user has at least one passkey in that
realm gets no code, and a code issued before the passkey existed is refused at verify.
`codeDisabled` checks this by user id and realm scope, so a passkey in another realm does
not count.

The reason is control separation: for the operator console, controlling the mailbox must
not be enough to control the platform. The check is applied in the route, not only in
`eligible()`, because a valid code may already be in flight when the passkey is added.

Tests: `apps/admin/worker/test/operator-passkey.test.ts` ("refuses codes once a passkey is
registered, even a valid one") and `operator-passkey-edge.test.ts` (another scope does not
lock codes, removing the passkey restores codes, address case and whitespace variants do
not bypass the block, and a blocked operator is indistinguishable from a stranger).

## `assertFreshForPasskeys` (routes.ts)

Changing a person's passkeys needs a recent sign-in, and once they have at least one
passkey, it must be a passkey sign-in. A first enrolment needs only the fresh sign-in,
otherwise a person could never add their first passkey.

`listPasskeys` for the session's user and realm decides which rule applies, and
`assertFreshSession` (in `control/sessions.ts`) enforces it: at most 10 minutes since the
session was created, and, when a passkey exists, a session whose method is `passkey`. The
same check guards passkey registration options, passkey registration verify, and passkey
deletion. Covered by "a stale session can not enrol or remove passkeys"
(`apps/admin/worker/test/admin.test.ts`).

## Passkey routes (routes.ts)

- `POST /passkey/login/options` and `/passkey/login/verify` are unauthenticated; the
  challenge row is the only state. Login options are rate limited per client IP.
- `POST /passkey/register/options`, `/passkey/register/verify` and
  `DELETE /passkeys/:id` require a session plus a fresh, passkey-backed sign-in when a
  passkey exists.
- `GET /passkeys` requires only a session, so a person can always see what is registered.
- Adding and removing a passkey write `auth.passkey.add` and `auth.passkey.remove` to the
  realm audit log. The credential id and public key are never written to the audit.
- **Login verify admits the user through the realm.** After `finishLogin` proves the
  credential, the route looks up the user and calls `realm.admit`. A valid passkey for a
  user who is no longer a member (or an operator who was removed) starts no session, and
  gets the generic "That passkey could not be verified." error rather than a distinct
  message.

## Session routes (routes.ts)

`/sessions`, `/sessions/:id` and `/profile` require a session in the realm scope and act
only on the session's own user. `/logout` needs no session. If the request carries a
cookie, `/logout` revokes that cookie's token, then clears the cookie and answers 200
either way.

- The list marks the row whose public id matches the current session as `current`, which
  is how the UI labels "this device".
- Revoking by id is scoped to the user and the realm, so a session id from one tenant can
  not end a session in another.
- `PATCH /profile` only sets the display name, trimmed and at most 80 characters.
- Logout revokes the session on the server before clearing the cookie. The cookie is not
  the credential; the row behind it is. Covered by "logout revokes the session
  server-side" (`packages/core/test/auth.test.ts`).

## Passkey credentials: `passkeys.ts`

- **One passkey, one scope, one RP ID.** A credential is registered for exactly one realm
  scope and one RP ID, which is the exact hostname taken from the request URL in the
  route's `site()` helper (not from a header or a body field). The browser refuses to
  offer it on any other host, and the server re-checks the RP ID on the one lookup that
  proves a pending login: `finishLogin` selects the credential by credential id, realm
  scope and RP ID, and also passes `expectedRPID`, so a forged or replayed response for
  another host fails. The other lookups filter by user id and realm scope only:
  `listPasskeys`, `deletePasskey`, the `excludeCredentials` query in `beginRegistration`
  and the `codeDisabled` check. They act on a row that is already the caller's or the
  address's in this scope, and the ceremony that created it was RP-ID checked at
  registration. A tenant that moves to a custom domain keeps the old host's rows: the
  browser no longer offers them (wrong RP ID) and `finishLogin` no longer matches them,
  so they can not sign anyone in on the new host, and because `assertFreshForPasskeys`
  counts passkeys by user id and scope only, the stale rows still demand a passkey
  sign-in that the new host can not provide. Passkeys therefore can not be added or
  removed there ([Authentication](../authentication.md#passkeys), and the known bug in
  [Known limits](#known-limits)). Covered by the design of `finishLogin`, which filters
  on all three values.
- **Discoverable credentials with required user verification.** Registration asks for a
  resident key and user verification, and both registration and login verification pass
  `requireUserVerification: true`. The passkey, not a password plus a second step, is the
  whole proof.
- **Attestation is `none`.** Rose does not care which authenticator produced the key, so
  it asks for no attestation and stores no vendor data.
- **Challenges are single use and short lived.** A challenge is a row in
  `webauthn_challenges`, keyed by id, kind (`register` or `login`), scope and, for
  registration, user id, with a 5-minute expiry (`CHALLENGE_TTL`). `takeChallenge` reads
  and deletes the row in one statement, so two concurrent verifies can not both use the
  same challenge. Expiry is checked in the same statement (`expires_at > now`), so an
  expired challenge is refused; the row stays in the table until `sweepExpired`
  (`control/sessions.ts`) deletes it.
- **Registration challenges are bound to the user.** `finishRegistration` refuses when the
  challenge row's user id differs from the signed-in user, so a challenge started by one
  account can not finish enrolment on another.
- **The two verifiers answer differently on a bad challenge.** For a missing, expired or
  other-user challenge, `finishRegistration` answers "Passkey setup expired. Try again.";
  it answers "That passkey could not be verified." only when the ceremony fails.
  `finishLogin` answers that generic error for every failure: a missing or expired
  challenge, an unknown credential and a failed ceremony.
  `verifyRegistrationResponse` and `verifyAuthenticationResponse` exceptions are caught
  and turned into that same error, so a malformed client response can not surface a
  stack trace or a library message.
- **The counter and `last_used_at` move forward on every login.** After a successful
  login the stored signature counter is replaced with the authenticator's `newCounter`.
  That is what lets a cloned authenticator be detected later.
- **Lookups are scoped.** The login lookup selects the credential by credential id, realm
  scope and RP ID; the list and delete statements filter by user id and realm scope, so
  one person can not see or delete another person's row. Deleting a row that is not the
  caller's answers 404 (`notFound()`), the same answer as a row that does not exist.
- **Listing is bounded.** `listPasskeys` returns at most 50 rows (a person has a handful of
  devices), so the settings page never loads an unbounded list.
- **Transport hints are stored as JSON.** The transports are kept so the UI and future
  `allowCredentials` hints can use them. They are the browser-reported
  `response.response.transports` that `verifyRegistrationResponse` copies into
  `credential.transports`. The signature does not cover that list, so it is client input
  and is kept only as a hint. Do not trust it for any access decision; scope and RP ID
  checks rest on the verified ceremony and the stored columns, never on transports.
- **The credential name is bounded.** The display name is trimmed, cut to 60 characters
  and defaults to "Passkey", so a client can not store an unbounded string.
- **No secret is stored.** Only the public key (base64url) is kept; the private key never
  leaves the authenticator.

## Known limits

- The vitest suite covers only the realm and freshness rules. `pnpm pentest` (PK-01 to
  PK-03, in `scripts/pentest/passkeys.mjs`) drives the ceremony with a software
  authenticator and covers challenge replay, the `finishLogin` / `finishRegistration`
  rejections, cross-tenant challenges and the challenge-to-user binding on registration.
  Challenge expiry is the one rule with no test. See
  [Authentication](../authentication.md#passkeys).
- **Known bug: a host change locks passkeys.** After a tenant moves to a new host, the
  old host's passkey no longer signs in there (its row keeps the old RP ID), but
  `assertFreshForPasskeys` counts it because it looks up passkeys by user id and scope
  only, so every passkey change on the new host is refused for lack of a passkey
  sign-in. The workarounds are to delete the old passkey while still on the old host, or
  to have an operator delete the row. Tracked separately.
- An operator who loses every passkey is recovered by hand: delete that user's rows in
  `passkeys` for scope `platform`. There is deliberately no self-service recovery, since
  it would put mailbox control back in the loop.
