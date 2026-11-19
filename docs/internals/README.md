# Internals

Why the security core is built the way it is. One page per area, written from the
comments and invariants in the code so the reasoning survives without relying on inline
comments. Each page references files and symbols, not line numbers.

| Page | Area |
|---|---|
| [Core auth](core-auth.md) | `packages/core/src/auth`: realms, email codes, passkeys, sessions |
| [Core control](core-control.md) | `packages/core/src/control`: tenants, domains, users, sessions, codes, jobs |
| [Core HTTP](core-http.md) | `packages/core/src/http`: request context, CSRF, errors, bodies, rate limits, cookies, list queries, LIKE patterns, sort |
