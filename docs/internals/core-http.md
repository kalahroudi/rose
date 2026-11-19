# Core HTTP (`packages/core/src/http`)

What `base.ts` and `pagination.ts` guarantee, and why. `base.ts` holds the middleware
and request helpers that every worker request passes through. `pagination.ts` holds the
list query, search and sort helpers that every list endpoint and module shares.

Both files are part of the public surface. `packages/core/src/index.ts` re-exports all of
`pagination.ts`, and `packages/core/src/platform.ts` re-exports the `base.ts` symbols for
the operator console. In `tenant-app.ts`, `requestContext` runs on `*` and `csrfGuard`
runs on `/api/*` and `/svc/*`. `apps/admin/worker/index.ts` mounts the same pair on `*`
and `/api/*`. Module code reaches the pagination helpers through `@rose/core`, and
`ctx.req.list()` parses the query string with `listQuerySchema`.

Related pages: [authentication](../authentication.md#csrf) for the CSRF rule as a
user-facing control, [tenancy and isolation](../tenancy-and-isolation.md) for the threat
model, [adding a module](../adding-a-module.md) for how list endpoints use these helpers.

## Request context and response headers (`requestContext`)

`requestContext` creates `requestId` with `newId("req")` before the rest of the chain
runs, then writes the response headers after `next()` returns. Writing them after the
chain means a route response and an error response from `errorHandler` both leave with
the same headers.

Headers it sets on every response that reaches it:

- `X-Request-Id`, from `requestId`. `errorHandler` puts the same value in its JSON body
  and its log line, and the UI exposes it on `ApiError.requestId` beside the error.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy` that disables
  camera, microphone, geolocation and payment.
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (`API_CSP`), but
  only when the response has no CSP of its own. No worker route sets its own today.
  Static HTML is served by the assets binding, outside the worker, with its CSP in a
  `_headers` file.
- `Cache-Control: no-store`, but only when the response has none. The tenant app and the
  operator console register a later middleware that sets `private, no-cache` on a
  successful GET `/api/*` response, so those responses do not get the default. Both values
  keep shared caches out, and neither is public.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, in
  production only (`ENVIRONMENT === "production"`).

The fail-closed misconfiguration answer does not pass through this middleware.
`guardFetch` (`env.ts`) and the `assertEnvironment` middleware registered ahead of
`requestContext` return a plain 500 with only `Cache-Control: no-store`. That path exists
to answer before routing when `ENVIRONMENT` is neither accepted value, and its body says
nothing about the cause.

Tests: "sets security headers and never caches API responses publicly"
(`packages/core/test/auth.test.ts`) checks `nosniff`, `DENY`, the API CSP,
`private, no-cache` and the 304 for a matching ETag. "fetch refuses every route with a
generic 500 that leaks nothing, sets no cookie, is not cacheable"
(`packages/core/test/environment.adversarial.test.ts`) checks the misconfiguration
answer. No test asserts `X-Request-Id`, the referrer, cross-origin or permissions
headers, or HSTS.

## CSRF (`csrfGuard`)

An unsafe request must come from the same host. This is the defence for
cookie-authenticated requests, because browsers attach cookies to cross-site requests. It
also rejects an unauthenticated cross-site write before routing. The rule runs in this
order:

1. GET, HEAD and OPTIONS pass. They are the safe methods.
2. A request whose `Authorization` header starts with `Bearer ` passes. Browsers never
   attach a bearer token on their own. The tenant auth middleware ignores cookies whenever
   an `Authorization` header is present, so the bearer path is the request's only
   identity, and a cookie-authenticated request can not borrow the exemption. That
   guarantee holds only in the tenant app. The console's `currentSession` reads the
   session cookie even when a `Bearer` header is present, so a cookie the browser attaches
   is still accepted. The exemption is safe there only because a browser can not send that
   header on a cross-site request without a CORS preflight, and the console sends no CORS
   allow headers, so the browser refuses the request.
3. When `Origin` is present, the guard parses it and the request URL and compares
   `URL.host`. The port is part of the comparison; the scheme is not. An origin that does
   not parse fails the check.
4. When `Origin` is absent, `Sec-Fetch-Site` must be exactly `same-origin`. A missing
   header, `same-site`, `cross-site` or `none` fails.
5. Every failure throws `forbidden("Cross-site request blocked.")`, which is a 403.

Two consequences of the exact predicates matter when a caller is added. A header such as
`bearer x`, a bare `Bearer` or `Basic …` is not exempt from the origin check; only the
capitalised `Bearer ` prefix is. And because only the host is compared, an `http://`
origin and an `https://` request on the same host pass this guard. Cookies are `Secure`
outside development, so a browser will not send them over plain HTTP, and the transport
check is not duplicated here.

The tenant app's coverage comes from the isolation contract
(`packages/core/src/testing/index.ts`), which runs "cross-site writes are blocked" for
every module (`apps/app/worker/test/isolation.test.ts`). The console coverage is
"rejects unauthenticated and cross-site requests" (`apps/admin/worker/test/admin.test.ts`),
"unauthenticated and cross-site callers are rejected before routing and nothing is
created" (`apps/admin/worker/test/no-tenant-creation.test.ts`, including `Origin: null`),
and the deletion test that sends `Origin: https://evil.example`
(`apps/admin/worker/test/deletion.adversarial.test.ts`). No test sends an unsafe request
with no `Origin` and no `Sec-Fetch-Site`, so the fallback branch is unexercised.

## Errors (`errorHandler`)

`errorHandler` is registered as Hono's `onError` in both workers. An `AppError` keeps its
status, code, message and optional `fields`, and the body is
`{ error: { code, message, fields, requestId } }`. Any other value becomes a 500 with
code `internal` and a fixed message. The real error's stack (or its message) goes to
`console.error` as one JSON line with level `error`, the request id and the request path.
It is never echoed to the client. When the request id is unset, both the body and the log
line use `unknown`.

Tests: "does not leak internals on errors" (`packages/core/test/auth.test.ts`) asserts
that a bad request body produces no stack, SQLite text or stack frame in the response.
The log line itself and the `fields` envelope are not asserted.

## JSON bodies (`readJson`, `parse`)

`readJson` enforces four things before a route sees a value:

- `Content-Type` must start with `application/json`, compared after lower-casing. Any
  other type is a 400.
- A declared `Content-Length` above 400,000 bytes is refused with 413 before the body is
  read. `MAX_BODY` is 100,000 characters, and the header gate is four times that.
- A decoded body longer than 100,000 characters is refused with 413.
- A body that is not valid JSON is a 400.

The declared-length gate exists so an oversized upload is refused without spending time
reading it. `parse` then runs the zod schema. Unknown object keys are dropped, because a
zod object strips keys it does not declare by default, so the route never sees them. A
failed parse becomes `invalid("Some fields need attention.", fields)`, a 422. `fields`
maps each dotted issue path, or `_` for a root issue, to the first message for that path.

The text cap counts UTF-16 code units, because it reads `text.length`. The declared-length
gate counts bytes. One UTF-16 code unit encodes to at most three UTF-8 bytes, so the
largest body that can pass the text cap is about 300,000 bytes. The four-times gate sits
above that, so it never refuses a body the text check would accept; it only stops a huge
upload early.

Tests: "does not leak internals on errors" (`packages/core/test/auth.test.ts`) sends an
empty body and expects 400. `apps/admin/worker/test/no-tenant-creation.test.ts` sends
invalid JSON and a 2,000,000-byte body and expects a client error without creating
anything. A wrong `Content-Type`, the exact 413 thresholds and the dropped-key behaviour
have no dedicated test.

## Client address and requesters (`clientIp`, `requesterKey`)

`clientIp` returns `CF-Connecting-IP` or `null`. It is the only address source. Audit rows
and rate-limit keys use it. Cloudflare sets the header; the browser does not.

`requesterKey` turns that address into the key the sign-in limits spend:

- A missing or blank address is `unknown`. The zone suffix (`%eth0`) is removed and the
  text is lower-cased first.
- A value with no colon is returned as a key without IPv4 validation.
- An IPv6 address with an embedded IPv4 tail (`::ffff:198.51.100.7`) becomes the IPv4
  address it carries. An octet above 255 leaves the raw value as the key.
- Any other IPv6 address is folded to its first four groups followed by `::/64`, for
  example `2001:db8:1:2::/64`. Hexadecimal groups accept one to four digits. A `::` may
  compress at least one group, and a bare address must have exactly eight groups.
- Anything the parser can not read is returned as the trimmed, lower-cased text.

The /64 bucket is deliberate. One host can rotate addresses inside its prefix, so a key
per full address would let that host reset its budget. IPv4-mapped addresses map to the
IPv4 they carry, so one client is one key whether it connects over IPv4 or through a
mapped IPv6 address.

Tests: "rejects malformed addresses instead of normalising them to another key",
"buckets IPv6 to /64 and maps IPv4-mapped to IPv4", and "four addresses in one /64 count
as one requester" (all `packages/core/test/auth.test.ts`).

## Rate limits (`rateLimit`)

`rateLimit(c, key)` calls `RL_AUTH.limit({ key })` and throws `tooMany()` (429) when the
binding reports failure. If the binding is missing it fails closed outside development
with `misconfigured(...)`; in development it returns without limiting, which lets local
sign-in work without the Cloudflare binding. The helper does not own the counting window
or the budget. The binding does, and callers choose the key string.

Tests: "production still fails closed without RL_AUTH"
(`packages/core/test/otp-requester.adversarial.test.ts`), "missing RL_AUTH fails closed on
code request and verify, with no devCode" (`packages/core/test/environment.adversarial.test.ts`),
and "dev returns a devCode, tolerates missing RL_AUTH, and allows an HTTP session" in the
same file.

## Session cookies (`cookieSpec`, `setSessionCookie`, `readSessionCookie`, `clearSessionCookie`)

A session cookie is named `__Host-<base>` on HTTPS and `<base>` on plain HTTP in
development. The `__Host-` prefix binds the cookie to the exact host: the browser requires
`Secure`, requires `Path=/`, and refuses a `Domain` attribute. A tenant on one subdomain
therefore can not read or overwrite another tenant's session cookie, and a cookie set for
a parent domain can not carry this name.

`cookieSpec` derives the name and the `secure` flag from the request URL and the
environment. A plain-HTTP request outside development throws
`misconfigured("Sessions require HTTPS.")`. In development the prefix is dropped, so
`rose_session` works on localhost. All three helpers call `cookieSpec` on every request,
so set, read and clear use the same name for the same request. Set also adds `httpOnly`,
`sameSite: "Lax"`, `path: "/"` and the session expiry. Clear uses the same path and secure
flag.

Tests: "signs a member in and sets a host-bound cookie" (`packages/core/test/auth.test.ts`)
checks the `__Host-rose_session` name on the Set-Cookie header, and `join-audit.test.ts`
checks the same for a member who joins from an invitation. "dev returns a devCode,
tolerates missing RL_AUTH, and allows an HTTP session"
(`packages/core/test/environment.adversarial.test.ts`) reads the unprefixed `rose_session`
over HTTP in development. "logout revokes the session server-side" covers clearing.

## List queries (`listQuerySchema`, `MAX_PAGE_SIZE`, `offsetOf`)

`listQuerySchema` is the only source of page, page size, search term and sort for a list
endpoint. `page` defaults to 1 and is capped at 100,000. `pageSize` defaults to 25 and is
capped at `MAX_PAGE_SIZE`, which is 100. `q` runs through `searchTermSchema`, and `sort`
is a trimmed string of at most 40 characters. `ctx.req.list()` parses the query string
with this schema, so a module can not ask for a larger page. `offsetOf` is
`(page - 1) * pageSize`.

The cap is a hard ceiling for every list. An unbounded list is a denial-of-service and an
exfiltration amplifier, and the UI contract is server-side pagination. The guard rule
`list-limit` rejects a list query without `LIMIT` and a literal `LIMIT` above 100.

Tests: "caps page size" (`packages/core/test/auth.test.ts`) expects 422 for
`pageSize=100000`. The isolation contract runs every module's list through the platform.

## Search terms (`searchTermSchema`, `MAX_SEARCH_LENGTH`)

`searchTermSchema` is the validated form of any search text, not only `q` in a list query.
Use it for search text that arrives outside `ctx.req.list()`, such as the filter of a
"select all matching" bulk action. The schema trims, removes C0 control characters and
DEL, caps the result at `MAX_SEARCH_LENGTH` (40 characters), and defaults to the empty
string.

Dropping control characters is a security rule, not tidying. SQLite ends a bound string at
a NUL byte, so `%\0%` would become `%` and match every row. The lint suppression on the
regex is the approved exception that lets the code match the characters the filter must
remove.

The cap is 40 characters, below the platform's 50-byte LIKE limit, because escaping `%`,
`_` or `\` adds bytes and the final pattern also carries its wildcards.

Tests: "a NUL byte in a search term can not turn it into match-everything"
(`packages/core/test/auth.test.ts`) sends `q=zzz%00` and gets zero rows. "long and
hostile search terms never reach SQLite as an over-long LIKE pattern" checks the length
that reaches SQLite.

## LIKE patterns (`likePattern`, `likePrefix`, `fitBytes`)

Both helpers escape `\`, `%` and `_` with a backslash, then cut the escaped text to a byte
budget, so the final pattern is at most 50 bytes. `likePattern` wraps the result in `%…%`
for "contains" and uses a 48-byte budget. `likePrefix` appends one `%` for "starts with"
and uses a 49-byte budget. `fitBytes` measures with `TextEncoder`, so the budget is
bytes, not characters. Callers must pair the result with `LIKE ? ESCAPE '\'`; every
current caller in `tenancy/store.ts`, `control/*` and the contacts module does.

Trimming can leave a trailing backslash, which would escape the closing wildcard and
change what the pattern means. `fitBytes` removes it. The trim removes one UTF-16 code
unit at a time, so a large search term can be cut inside a surrogate pair. That leaves a
lone surrogate in the pattern, which `TextEncoder` encodes as the replacement character.

Tests: "long and hostile search terms never reach SQLite as an over-long LIKE pattern"
(`packages/core/test/auth.test.ts`) checks the 50-byte ceiling for both helpers and that
`likePattern` never ends in a dangling escape.

## Sort (`orderBy`)

`orderBy(sort, allowed, fallback)` is the only way a sort key may become SQL. SQL
identifiers can not be bound as parameters, so the caller passes a map from public key to
column expression. `orderBy` returns `<column> ASC` or `<column> DESC` only when `sort`,
minus a leading `-`, is an own property of that map, and returns `fallback` otherwise. A
leading `-` means DESC. The own-property test matters: a plain lookup would resolve
`__proto__` or `constructor` through the prototype chain and hand a non-column to the
query. The allow-list also keeps a caller from sorting on a column the query does not
expose.

Tests: "inherited object properties are not valid sort columns"
(`packages/core/test/auth.test.ts`) checks `__proto__`, `constructor`, `toString`,
`-hasOwnProperty` and `constructor.prototype` over the helper and over the HTTP route.

## Known limits

- The response-header tests do not cover `X-Request-Id`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy` or
  `Strict-Transport-Security`.
- The CSRF fallback branch, an unsafe request with no `Origin` and no `Sec-Fetch-Site`,
  has no test. The malformed-origin branch does, through `Origin: null`.
- `errorHandler`'s log line is not asserted; the test only checks that the response body
  leaks nothing.
- The exact `readJson` thresholds are not asserted. The 2,000,000-byte test accepts any
  client error from 400 to 422.
- `fitBytes` can split a surrogate pair when it trims, as described above. No test covers
  a search term that ends this way.
- `listQuerySchema` accepts `page` up to 100,000, so `offsetOf` can ask SQLite to skip
  about ten million rows at the maximum page size of 100. The code fix is tracked as Noty
  bug FDC4A6BB.

## Corrections to the comments

These statements in the source comments are imprecise. The code is the reference; this
page states what it does.

- `requestContext` says "security headers on every worker response". The fail-closed
  misconfiguration answer is produced before the middleware and carries only
  `Cache-Control: no-store`. The CSP and `Cache-Control` are also conditional: they are
  set only when the response does not already carry them.
- `csrfGuard` says a request must come from "this exact origin". The code compares
  `URL.host`, so the port counts and the scheme does not.
- `csrfGuard` says "cookies are ignored whenever a bearer token is present". That holds
  only in the tenant app. The console's `currentSession` reads the session cookie even
  when a `Bearer` header is present, and is safe only because a browser can not send that
  header cross-site without a CORS preflight the console refuses.
- `requesterKey` says IPv4 is unchanged and unparseable input is returned as-is. The
  input is trimmed, lower-cased and zone-stripped first, and a colon-free value is
  returned without IPv4 validation.
- `rateLimit` says it fails closed "in production". The test is `isDev`, so any value
  other than exactly `development` fails closed. The entry guard rejects odd
  `ENVIRONMENT` values before a request reaches this helper.
- `readJson` says the size "is capped" without saying that two caps apply, one in bytes
  from the declared length and one in UTF-16 code units from the decoded text.
