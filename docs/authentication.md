# Authentication

Rose has no passwords. People prove who they are with a **passkey** (WebAuthn) or a
**one-time code sent by email**, and the server keeps the session.

## Realms

A *realm* is where you are signing in: one tenant, or the operator console. It is
derived from the request host, never from request data. The same code
(`packages/core/src/auth/routes.ts`) serves both, parameterised by an `AuthRealm`:

| | Tenant realm | Operator realm |
|---|---|---|
| Scope | the tenant id | `platform` |
| Who may get a code | members, and addresses with a pending invitation | operators (and the bootstrap address while there are no operators) |
| Cookie (HTTPS) | `__Host-rose_session` | `__Host-rose_admin` |

## Email codes

1. `POST /api/auth/code/request {email}` always answers `{ok: true}`. Only if the
   address is eligible is a 6-digit code created and mailed, and that work runs after
   the response (`waitUntil`), so neither the body nor the timing reveals membership.
2. `POST /api/auth/code/verify {email, code}` checks the code and starts a session.

Properties (`control/otp.ts`):

- Stored as `HMAC(key derived from the master key, scope ‖ email ‖ code)`: a database
  dump can not be brute-forced offline, and a code for one tenant is useless on another.
- Valid 10 minutes, single use (consumed atomically), only the newest code counts.
- 5 wrong guesses kill a code; at most 5 codes per address per scope per 15 minutes.
- An attempt is spent *before* comparison, so parallel guesses can not exceed the budget.

In development and tests (`ENVIRONMENT` ≠ `production`) the response also contains
`devCode` and the mail is printed to the terminal. In production, the `console` email
provider refuses to run.

## Passkeys

After the first code sign-in the UI offers to add a passkey. Implementation:
`auth/passkeys.ts` using `@simplewebauthn/server`.

- **One passkey = one host.** The relying-party id is the exact hostname, and the stored
  credential records scope and RP id. A passkey for `acme.example.com` is never offered
  by the browser on `globex.example.com`, and the server would reject it anyway.
- Discoverable credentials with user verification required; challenges are single-use
  rows that expire after 5 minutes.
- If a tenant moves to a custom domain, passkeys registered on the old host do not carry
  over. People sign in with an email code and add a passkey on the new host.
- Passkey verification in this repository is covered for challenge handling and
  rejection paths; the full browser ceremony is not automated in the test suite.

## Sessions

`control/sessions.ts`

- The token is 256 random bits. Only its SHA-256 is stored.
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/` with the `__Host-` prefix, so it is
  bound to the exact host and can not be set or read by a sibling subdomain. (Plain-HTTP
  localhost can not use the prefix; it is dropped in development only.)
- Absolute lifetime 7 days. Every lookup also requires a live membership (or operator
  row) and an active tenant, so access ends immediately when either is removed.
- People can see and revoke their sessions (`GET/DELETE /api/auth/sessions`).
  Signing out deletes the session server-side.

## Self-service signup (root host)

On `https://<base>`:

1. `POST /api/root/code/request` → code to any address (this is signup).
2. `POST /api/root/code/verify` → a 15-minute, single-use *ticket* plus the list of
   workspaces that address already belongs to.
3. `POST /api/root/enter` with the ticket and either `slug` (enter an existing
   workspace) or `create: {name, slug}` (new workspace; caller becomes `owner`).
   Returns a URL on the tenant host.
4. `GET https://<slug>.<base>/auth/handoff?token=…` exchanges a **handoff** for a session
   cookie on that host and redirects to `/`.

A handoff is needed because cookies are host-only by design. It is a random token stored
hashed, valid 60 seconds, single use, and bound to purpose and tenant.

## Invitations

An invitation is a pending membership for an email address (7 days). There is no
invitation link to forward or leak: the invited address signs in on the workspace with
an email code, which proves ownership, and the invitation becomes a membership.

Joining is written to the workspace's own audit log (`member.join`, with the role). When
a workspace has more than one owner, the other owners are emailed whenever someone joins
(and, for a new owner, even when there is just one other owner). Owner access can only come from
self-serve sign-up or from an existing owner's invitation: the operator console has no way
to add an owner to a tenant, so platform staff cannot give themselves access to a
customer's workspace.

## Operators

- The first operator is whoever controls the mailbox in `BOOTSTRAP_OPERATOR_EMAIL`, and
  only while the `operators` table is empty. After that the variable has no effect.
- Owners add further operators by email in the console.
- Recommended in production: put Cloudflare Access in front of the admin hostname as a
  second, independent lock ([deployment.md](deployment.md)).

## API keys (tenant realm)

`Authorization: Bearer rose_<keyId>_<secret>`. Created by a signed-in admin, shown once,
stored as SHA-256 inside the tenant's own database, optional expiry, role `member` or
`admin` (never `owner`). When a bearer token is present, cookies are ignored for that
request, so a bad token is never "rescued" by a valid cookie.

## CSRF

`http/base.ts › csrfGuard`: for any method other than GET/HEAD/OPTIONS the `Origin`
header must match the request host (or, if absent, `Sec-Fetch-Site: same-origin`).
Bearer-token requests are exempt because browsers never attach those on their own.
JSON bodies require `Content-Type: application/json`.

## Rate limits

| Limit | Where | Scope |
|---|---|---|
| 20 requests / 60 s per key (`code:<scope>:<email>`, per IP, per passkey/slug/API-key IP) | Workers rate limiter binding `RL_AUTH` | per Cloudflare location |
| 5 codes / 15 min per address and scope | D1 | global |
| 5 guesses per code | D1 | global |

If `RL_AUTH` is missing in production, auth endpoints fail closed.
