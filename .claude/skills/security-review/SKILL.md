---
name: security-review
description: Rose-specific security self-review to run before reporting any change as finished, and whenever the user asks to review, audit or double-check a change for tenant isolation, authorisation, data leaks or security in this repository.
---

# Rose security review

Run this on your own diff (`git diff` plus untracked files) before you say a task is
done. Answer every item with evidence (file:line or test name), not from memory. Report
the result to the user, including items that do not apply and anything you could not
verify.

## A. Tenant isolation

1. Does any new code obtain a tenant identity from anywhere other than the bound context
   (`ctx.tenant`, or `c.get("tenant")` inside the core)? Look for ids read from params,
   query, body or headers and then used to select *which tenant*.
2. Is all new tenant data stored through `ctx.db`? Did anything tenant-owned get added to
   the control-plane schema, a global variable, a module-level cache or a job payload?
   (Module-level `Map`s are shared across tenants in one isolate: key them by
   `ctx.tenant.id` or do not use them.)
3. Does every new route that returns data have a test where a second tenant gets nothing?
   CRUD is covered by the isolation contract only if it goes through the `isolationProbe`
   paths; exports, searches, stats and jobs need their own.
4. Do background jobs take the tenant only from the job's scope (they do if you used
   `ctx.enqueue` and the job's `ctx`)? Nothing in the payload may select a tenant.

## B. Authorisation

5. Every route has the *right* `permission`, not just any. Destructive routes are not
   available to `member` unless intended.
6. Role changes, invitations and API-key creation can not grant more than the actor has.
7. Missing or foreign records return 404, not 403 or 500.

## C. Input and output

8. Every body goes through a zod schema with length limits. Every list is bounded.
9. SQL: all values bound; sort via `orderBy`; no string concatenation.
10. Responses contain no secrets, hashes, wrapped keys or other tenants' identifiers.
    Errors are `AppError`s with human text; nothing internal is echoed.
11. UI renders untrusted text through React only; external links use `ExternalLink`.

## D. Secrets and cryptography

12. Sensitive columns are encrypted with a stable `"table.column"` label; blind indexes
    only on high-entropy values.
13. Nothing secret in `console.*`, `ctx.audit` metadata, job payloads, URLs or
    localStorage. No secrets or real keys in the repo, tests or docs.
14. Random values come from `newId()`, `randomToken()` or WebCrypto.

## E. Guardrails intact

15. `pnpm verify` is green. Paste the summary line.
16. No test was deleted, skipped, focused or weakened. No guard rule or CSP directive was
    loosened. List every `guard-allow` you added and who agreed to it (expected: none).
17. Protected files changed? List each with the reason and state clearly that a human
    must review and run `pnpm guard:approve`.
18. New dependencies? Name them and why they are necessary (expected: none).

## F. Operator plane (only if `apps/admin` changed)

19. The admin worker still has no tenant storage binding and reads only control-plane
    data. Owner-only actions call `ownerOnly`. New actions write `platform_audit`.

## Output format

```
Security review
A. Isolation      ✓ / ✗  evidence
B. Authorisation  ✓ / ✗  evidence
C. Input/output   ✓ / ✗  evidence
D. Secrets        ✓ / ✗  evidence
E. Guardrails     ✓ / ✗  pnpm verify: <summary>; guard-allow: <n>; protected files: <list>
F. Operator plane ✓ / n/a
Not verified: <anything you could not check, and why>
```
