# Security policy

## Reporting a vulnerability

Please report privately through **GitHub Security Advisories**:
<https://github.com/kalahroudi/rose/security/advisories/new>

Do not open a public issue for a suspected vulnerability. Include what you found, how to
reproduce it (a failing test against `packages/core/test/` is ideal) and the impact you
expect. You will get an acknowledgement, and credit in the advisory if you want it.

## Scope

In scope: anything that breaks one of the invariants below in the code in this
repository, with default configuration.

Out of scope: vulnerabilities in Cloudflare's platform; deployments that changed the
protected security core; issues that require a compromised Cloudflare account, worker
secret or developer machine; denial of service by volume; the example upstream service
(it is documentation).

## The invariants Rose commits to

1. A tenant's data can not be read or changed by another tenant, an anonymous caller, or
   through the operator console.
2. The tenant is determined only by the request host.
3. A session, API key, sign-in code, passkey or handoff issued for one tenant (or for the
   operator console) is not accepted anywhere else.
4. Session tokens, API key secrets and sign-in codes are not recoverable from the
   database.
5. Fields encrypted by a module can only be decrypted with that tenant's key, in the
   column they were written to.
6. Deleting a tenant destroys its data and its encryption key.
7. The operator worker holds no binding to tenant storage and no tenant key.

How each is enforced and tested: [docs/tenancy-and-isolation.md](docs/tenancy-and-isolation.md).
Known limits are listed in [docs/architecture.md](docs/architecture.md#known-limits) and
[docs/agents.md](docs/agents.md#honest-limits).

## Supported versions

The `main` branch. There are no maintained release branches yet.

## If you run Rose in production

Watch this repository's advisories, keep dependencies current (Dependabot is configured),
and treat any change to `guard.lock.json` in your fork as a security review event.
