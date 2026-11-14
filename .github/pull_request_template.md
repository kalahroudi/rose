## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Security checklist

- [ ] **Tenant isolation**: tenant data is only reached through `ctx.db` / `ctx.crypto()`; no new control-plane table holds tenant business data.
- [ ] **Authorisation**: every new route declares a `permission`, and the role mapping is the least that works.
- [ ] **Sensitive fields** (contact details, credentials, free text that may hold personal data) are encrypted with `ctx.crypto()`; nothing secret is logged.
- [ ] **Lists** are paginated server-side (`ctx.req.list()`), searchable, and never unbounded.
- [ ] **Mutations** write an audit entry (`ctx.audit`) and data-loss actions use the typed-name confirmation in the UI.
- [ ] **Tests**: the module has tests and `pnpm verify` is green (the isolation contract ran against it).
- [ ] **Help**: every new page/tab has help content (what it is, terms, why).
- [ ] **Docs** updated where behaviour changed.
