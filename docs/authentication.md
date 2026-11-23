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
3. `POST /api/auth/code/link {email, key}` redeems the sign-in key mailed next to the
   code and starts a session. It never reads or writes the typed-guess counter.

Properties (`control/otp.ts`):

- The 6-digit code is stored as `HMAC(key derived from the master key, scope ‖ email ‖
  code)` and the sign-in key as `HMAC(key derived from the master key, scope ‖ email ‖
  key)`: a database dump can not be brute-forced offline, and a code or key for one
  tenant is useless on another.
- Valid 10 minutes, single use (consumed atomically), only the newest code issued to the same requester (client address) counts, so one person's request never invalidates a code another person received. A code is also accepted if it is the newest live code for the address (for a user whose client address changed); each verify spends at most one guess on each of those two candidates. The requester is the client IPv4 address or the IPv6 /64 prefix (IPv4-mapped IPv6 counts as IPv4), so one host rotating addresses inside its prefix is one requester.
- Typed code: 10 guesses per account (email, scope) per hour. The counter sums own and foreign attempts across all codes created in the last 70 minutes (60-minute window plus the 10-minute code lifetime); after the 10th guess every guess is answered as a bad code, even a correct one. This bounds online guessing at ≤ 1e-5 per account per hour on the typed path. Residual risk: one client can spend the 10 guesses and so block an address's 6-digit code for up to 70 minutes; the emailed sign-in key still signs the real user in.
- Sign-in key: every code also carries a 100-bit key (20 Crockford base32 characters) printed as `XXXXX-XXXXX-XXXXX-XXXXX` and linked from the mail. It is redeemed by `POST /code/link` and never touches the typed-guess counter, so no number of attacker requesters can stop the real user signing in (key ≥ 64 bits, not rate-limited per account: NIST 800-63B §3.1.3, ASVS 6.6.3). Using the code or the key consumes both.
- 2-minute send gap: no code is issued for the same (email, scope) within 120 seconds of the previous unused code. A refused issue stays silent (no mail), exactly like an ineligible address.
- 5 wrong guesses by the requester a code was issued to kill it. Guesses by any other requester (the newest-code fallback) spend a separate, shared budget of 3 per code, so a stranger can never use up the owner's 5; total guesses per code are bounded at 8.
- Verification is rate limited per requester (`verify-ip:<requester>`, `verify:<scope>:<email>:<requester>`), never per address alone, so one client's wrong guesses can not lock the address's real user out.
- At most 5 codes per address, scope and requester per 15 minutes, and 20 per address and scope across all requesters (anti mail-bomb backstop; the 2-minute gap is the effective bound).
- An attempt is spent *before* comparison, so parallel guesses can not exceed the budget.

In development and tests (`ENVIRONMENT=development`) the response also contains
`devCode` and `devKey` and the mail is printed to the terminal. In production, the
`console` email provider refuses to run.

## Passkeys

After the first code sign-in the UI offers to add a passkey. Implementation:
`auth/passkeys.ts` using `@simplewebauthn/server`.

- **One passkey = one host.** The relying-party id is the exact hostname, and the stored
  credential records scope and RP id. A passkey for `acme.example.com` is never offered
  by the browser on `globex.example.com`, and the server would reject it anyway.
- Discoverable credentials with user verification required; challenges are single-use
  rows that expire after 5 minutes.
- A passkey counts only while its host is still served: the workspace's own address or
  one of its active custom domains (for the operator console, the address you are on).
  After a host move, for example when a custom domain is removed, you are signed out of
  the tenant app and passkeys registered on the old host no longer work. Sign in with an
  email code and add a new passkey. The account page lists the old ones as "Old address,
  can't be used", and a code session can remove them. Until you add a new passkey, your
  mailbox is the only proof of who you are, as for someone who never had a passkey.
- A passkey on a host that is still live keeps counting, so a code session on another
  address of the same workspace can not add or remove passkeys for you.
- Adding a passkey emails you and the workspace's owners and admins (other platform
  owners, in the operator console), and writes `auth.passkey.add` to the audit log.
- The vitest suite tests only the realm and freshness rules for passkeys. The full
  ceremony is exercised by `pnpm pentest` (PK-01 to PK-03) with a software authenticator:
  replay of a used challenge, forged and cross-site assertions, cross-tenant challenges
  and the challenge-to-user binding on registration. Challenge expiry has no test.

## Sessions

`control/sessions.ts`

- The token is 256 random bits. Only its SHA-256 is stored.
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/` with the `__Host-` prefix, so it is
  bound to the exact host and can not be set or read by a sibling subdomain. (Plain-HTTP
  localhost can not use the prefix; it is dropped in development only.)
- Absolute lifetime 7 days, and an idle timeout of 12 hours: a session not used for 12 hours is
  refused and swept (activity is recorded at most every 5 minutes, so active people are never
  signed out by it). Every lookup also requires a live membership (or operator
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
   Returns a URL on the tenant host. Creating is capped per person: once someone owns
   `MAX_WORKSPACES_PER_USER` workspaces (default 5; workspaces already being deleted do
   not count) `create` answers 403 without spending the ticket. Entering an existing
   workspace by `slug` is never limited.
4. `GET https://<slug>.<base>/auth/handoff?token=…` exchanges a **handoff** for a session
   cookie on that host and redirects to `/`. The `POST /api/root/enter` response also sets
   a short-lived handoff cookie scoped to `/auth/handoff`; the browser presents it back with
   this request, and the handoff is consumed only when the cookie's value matches the one
   bound to the token. A `Sec-Fetch-Site: cross-site` request is refused even with the right
   cookie, so a cross-site page can not ride the handoff.

A handoff is needed because cookies are host-only by design. It is a random token stored
hashed, valid 60 seconds, single use, and bound to purpose, tenant and the browser cookie.

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
| 20 requests / 60 s fixed window per key (`code:<scope>:<email>:<requester>`, `code-ip:<requester>`, `pk-ip:<requester>`, `slug-ip:<requester>`, `key-fail:<requester>`) — up to 2 × 20 - 1 = 39 requests can pass across a window boundary; per-code OTP caps in `control/otp.ts` are unaffected | Workers rate limiter binding `RL_AUTH` (cheap per-server first filter) + D1 `rate_limits` (strongly consistent global counter, fixed 60 s window) | per server, then global |
| 5 codes / 15 min per address, scope and requester; 20 / 15 min per address and scope overall | D1 | global |
| 5 guesses per code by its own requester, plus 3 shared by all other requesters | D1 | global |
| 10 typed guesses per address and scope across all codes created in the last 70 min | D1 | global |
| Sign-in key (100-bit, not rate-limited per account) | D1 | global |
| 20 verifications / 60 s fixed window per key (`verify-ip:<requester>`, `verify:<scope>:<email>:<requester>`) — same fixed 60 s window (up to 2 × 20 - 1 = 39 across a window boundary; per-code OTP caps in `control/otp.ts` are unaffected) | Workers rate limiter binding `RL_AUTH` (cheap per-server first filter) + D1 `rate_limits` (strongly consistent global counter, fixed 60 s window) | per server, then global |

Every rate-limit key (`code`, `code-ip`, `verify`, `verify-ip`, `pk-ip`, `slug-ip`, `key-fail`) is keyed on the requester (`requesterKey`: IPv4 address or IPv6 /64 prefix, with IPv4-mapped IPv6 treated as IPv4), not the raw IP. If `RL_AUTH` is missing in production, auth endpoints fail closed.

## Operators: passkey replaces emailed codes

In the operator console, once an operator registers a passkey on the console's address, emailed codes stop working
for them (no code is sent, and a code issued earlier is refused). Controlling the mailbox
is then not enough to control the platform. Register a passkey, and a second one on another
device, before relying on this. If an operator loses every passkey, recovery is manual: delete that user's rows in
`passkeys` (scope `platform`) from the control-plane database.
