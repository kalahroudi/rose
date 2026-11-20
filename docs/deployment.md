# Deployment

> **Status:** the production path below is implemented and its `--dry-run` is tested, but
> it has not been run against a live Cloudflare account as part of this repository's
> test suite. Run it with `--dry-run` first and read the plan.

## Prerequisites

- A Cloudflare account with the Workers Paid plan (Durable Objects with SQLite, D1,
  cron triggers, rate limiting).
- A domain on that account (the *base domain*). Tenants live at `<slug>.<base>`.
- `npx wrangler login` done on your machine (or `CLOUDFLARE_API_TOKEN` in CI).
- Email: [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) is the
  default (`send_email` binding `EMAIL`, no API key; sending to any address needs Workers
  Paid). [Resend](https://resend.com) is also supported; add another provider in
  `packages/core/src/email.ts`. Whatever the provider, mail to reserved domains
  (`.example`, `.test`, `.invalid`, `.localhost`, `example.com/.net/.org`) is dropped before
  it reaches the provider, so tests and the pentest never use your sending quota.

## One command

```sh
pnpm setup --production --dry-run     # see exactly what will happen
pnpm setup --production               # guided
```

Unattended (CI): pass every answer as a flag or environment variable.

```sh
pnpm setup --production --yes \
  --domain acme.app --admin-host admin.acme.app --operator-email you@acme.app \
  --app-name "Acme" --email-provider cloudflare --email-from "Acme <login@acme.app>"
# Resend instead: RESEND_API_KEY=… and --email-provider resend
```

What it does, in order:

1. Checks `wrangler whoami`. With `--email-provider cloudflare` it enables Email Sending
   for the From address's domain (`wrangler email sending enable`, which publishes the
   DKIM/SPF/DMARC records on that zone).
2. Creates the D1 database `rose-control` (or reuses it) and writes its id into
   `wrangler.production.jsonc` in each app (git-ignored copies of `wrangler.jsonc`).
3. Writes non-secret vars and routes into both `wrangler.production.jsonc` files
   (`APP_BASE_DOMAIN`, `APP_NAME`, `EMAIL_*`, `BOOTSTRAP_OPERATOR_EMAIL`; app routes
   `<base>/*` and `*.<base>/*`; admin route `<admin-host>/*`, which wins over the
   wildcard because it is more specific).
4. Applies control-plane migrations (`wrangler d1 migrations apply --remote`).
5. Builds and deploys both workers.
6. Generates secrets and pipes them straight to `wrangler secret put`: a separate
   `ROSE_MASTER_KEY` for each worker, `UPSTREAM_SIGNING_SECRET`, and (Resend only) your
   `RESEND_API_KEY`. They are never printed or written to disk. Existing master keys are
   **kept** on re-runs (replacing one would orphan encrypted data). Between step 5 and
   this step the workers fail closed (HTTP 503).

It is safe to re-run. The committed `wrangler.jsonc` files keep placeholders only
(`pnpm guard` fails if a real database id, domain or operator email appears there); your
real values live in the git-ignored `wrangler.production.jsonc` files, so back those up
privately. Wrangler commands for production take `-c wrangler.production.jsonc`.

## What you do by hand

| Task | Why it is manual |
|---|---|
| **DNS**: proxied records for `@`, `*` and the admin host (e.g. `AAAA 100::`) | The script has no DNS permissions by design; it prints the exact records |
| **Back up the tenant worker's `ROSE_MASTER_KEY`** | Cloudflare never shows a secret again. To hold a copy, set it yourself *before* running setup: `openssl rand -base64 32`, store it in your secret manager, then `wrangler secret put ROSE_MASTER_KEY` in `apps/app`. Setup keeps an existing key |
| Verify your sending domain with the email provider | Done in the provider's dashboard |
| Cloudflare Access on the admin hostname (recommended) | See below |
| Cloudflare zone WAF rate-limiting rule on `/api/*/code/*`, `/api/auth/passkey/*` and `/api/root/slug` (recommended) | See below |
| Cloudflare for SaaS (only for customer-owned domains) | See [multi-tenanting-a-service.md](multi-tenanting-a-service.md#custom-domains-cloudflare-for-saas) |

## First sign-in

1. Open `https://<admin-host>` and sign in with the operator email: a code arrives by mail.
2. Add a passkey when prompted.
3. **Operators → add a second owner.** With one owner, losing that mailbox locks you out.
4. **Setup** shows the live health of the deployment; every item explains what is wrong
   and why it matters.

## Defence in depth for the console

The console is protected by its own authentication, but it is the most privileged
surface you run. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the admin hostname (allow only your staff's identity provider group). An
attacker then needs to defeat two independent systems.

## Defence in depth for auth endpoints (zone WAF)

Inside the workers, auth endpoints are guarded by two layers: Cloudflare's `RL_AUTH`
rate-limit binding as a cheap per-server first filter, followed by a strongly consistent
global counter in D1 (`rate_limits`). Add a Cloudflare zone WAF rate-limiting rule in
front of those paths as defence in depth:

- **Paths**: `/api/*/code/*`, `/api/auth/passkey/*` and `/api/root/slug` (covers tenant,
  root and operator email-code request/verify, passkey routes and root slug lookup).
- **Key**: client IP.
- **Action**: block with HTTP `429`.

Failed API-key attempts on tenant `/api/*` and `/svc/*` are also rate-limited inside the
worker (only failed attempts spend budget, so valid API traffic is not throttled).

A zone WAF rule drops abusive bursts at the edge before a Worker is invoked or D1 is
written to, protecting Worker invocations and D1 write quota while `RL_AUTH` and the
durable D1 counter enforce the application's 20 requests / 60 s limit inside the workers.

## Subsequent deploys

```sh
pnpm deploy
```

Runs `pnpm verify` (guard, types, all tests), builds, applies migrations and deploys
both workers. It stops at the first failure and refuses to run while
`wrangler.production.jsonc` is missing or still has placeholder values. In CI, run the same command with `CLOUDFLARE_API_TOKEN`.

Tenant database migrations need no step: each tenant's Durable Object applies new module
migrations the next time it starts after a deploy.

## Configuration reference

| Name | Worker | Kind | Meaning |
|---|---|---|---|
| `ROSE_MASTER_KEY` | both (different values) | secret | base64 of 32 random bytes; root of key derivation |
| `ROSE_MASTER_KEY_PREVIOUS` | both | secret, optional | Old key during rotation ([encryption.md](encryption.md)) |
| `ENVIRONMENT` | both | var | Exactly `production` in deployed workers (`development` locally). Any other value, including missing or `staging`, makes the worker refuse to serve (HTTP 500; jobs and cron fail) instead of enabling on-screen sign-in codes |
| `APP_BASE_DOMAIN` | both | var | Tenants live at `<slug>.<this>` |
| `APP_NAME` | both | var | Product name in UI, emails, passkey prompts |
| `EMAIL_PROVIDER`, `EMAIL_FROM` | both | var | Mail delivery: `cloudflare` (default), `resend`, or `console` (development only) |
| `EMAIL` | both | `send_email` binding | Cloudflare Email Service sender, used when `EMAIL_PROVIDER` is `cloudflare` |
| `RESEND_API_KEY` | both | secret, optional | Only when `EMAIL_PROVIDER` is `resend` |
| `BOOTSTRAP_OPERATOR_EMAIL` | admin | var | May become the first operator while there are none |
| `APP_URL_TEMPLATE` | admin | var | How the console links to tenant apps, `https://{host}` |
| `MAX_WORKSPACES_PER_USER` | app | var, optional | Most workspaces one person may create at signup. Any positive integer; empty, `0`, negative or non-numeric values mean the default, 5 |
| `UPSTREAM_MODE`, `UPSTREAM_ORIGIN` | app | var | `off` \| `origin` \| `dispatch` |
| `UPSTREAM_SIGNING_SECRET` | app | secret | Signs the tenant token sent upstream |
| `RL_AUTH` | both | rate-limit binding | Cheap per-server first filter ahead of the durable D1 rate-limit counter; required in production |
| `DB` | both | D1 binding | Control plane |
| `TENANT_DO` | app only | Durable Object | Per-tenant databases |

## Production checklist

- [ ] `pnpm verify` is green on the commit you deploy; CI is required on `main`.
- [ ] `ENVIRONMENT` is `production` in both workers (Setup shows it).
- [ ] Real base domain; DNS records proxied; HTTPS works on apex, a tenant and the console.
- [ ] Email provider configured and the sending domain verified (SPF/DKIM).
- [ ] At least two platform owners, each with a passkey.
- [ ] Cloudflare Access in front of the console.
- [ ] Cloudflare zone WAF rate-limiting rule on `/api/*/code/*`, `/api/auth/passkey/*` and `/api/root/slug` (keyed by client IP, returning 429; failed API-key attempts on tenant `/api/*` and `/svc/*` are also rate-limited inside the worker).
- [ ] The tenant worker's master key is backed up in a secret manager.
- [ ] Branch protection on `main` that requires CODEOWNERS review. Nothing else makes the security core review real ([docs/agents.md](agents.md#5-the-security-core)).
- [ ] You have read the limits in [architecture.md](architecture.md#known-limits).

## Operations

- **Queues** (`rose-app-jobs`, `rose-admin-jobs`, created by `pnpm setup`) start
  background jobs as soon as they are queued.
- **Cron** runs hourly in both workers: cleanup of expired sessions, codes, handoffs,
  challenges, invitations and rate-limit windows, and a safety-net sweep for jobs whose message was lost.
- **Logs**: Workers observability is enabled. Errors are JSON lines with a `requestId`,
  which is also returned to the client in `X-Request-Id` and in error bodies.
- **Suspending a tenant** (console) blocks its sessions and API keys on the next request.
- **Deleting a tenant** closes it at once (sessions cut, nothing served) and keeps its data
  for 48 hours; a platform owner can cancel in the console until then. After that a background
  job destroys the tenant database and its encryption key, irreversibly. Deleting (and
  cancelling) needs a platform owner who signed in with a passkey in the last 10 minutes; a
  tenant owner needs a sign-in from the last 10 minutes (with a passkey, if they have one).
- **Backups**: D1 has point-in-time recovery (Time Travel). Durable Object storage has
  its own point-in-time recovery API; Rose does not wrap it yet.
- **Rotating secrets**: [encryption.md](encryption.md#rotating-the-master-key). Rotating
  `UPSTREAM_SIGNING_SECRET` needs the upstream to accept both values during the switch.
