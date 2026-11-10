# Deployment

> **Status:** the production path below is implemented and its `--dry-run` is tested, but
> it has not been run against a live Cloudflare account as part of this repository's
> test suite. Run it with `--dry-run` first and read the plan.

## Prerequisites

- A Cloudflare account with the Workers Paid plan (Durable Objects with SQLite, D1,
  cron triggers, rate limiting).
- A domain on that account (the *base domain*). Tenants live at `<slug>.<base>`.
- `npx wrangler login` done on your machine (or `CLOUDFLARE_API_TOKEN` in CI).
- An email provider account. [Resend](https://resend.com) is supported out of the box;
  add another in `packages/core/src/email.ts`.

## One command

```sh
pnpm setup --production --dry-run     # see exactly what will happen
pnpm setup --production               # guided
```

Unattended (CI): pass every answer as a flag or environment variable.

```sh
RESEND_API_KEY=… pnpm setup --production --yes \
  --domain acme.app --admin-host admin.acme.app --operator-email you@acme.app \
  --app-name "Acme" --email-provider resend --email-from "Acme <login@acme.app>"
```

What it does, in order:

1. Checks `wrangler whoami`.
2. Creates the D1 database `rose-control` (or reuses it) and writes its id into both
   `wrangler.jsonc` files.
3. Writes non-secret vars and routes into both `wrangler.jsonc` files
   (`APP_BASE_DOMAIN`, `APP_NAME`, `EMAIL_*`, `BOOTSTRAP_OPERATOR_EMAIL`; app routes
   `<base>/*` and `*.<base>/*`; admin route `<admin-host>/*`, which wins over the
   wildcard because it is more specific).
4. Applies control-plane migrations (`wrangler d1 migrations apply --remote`).
5. Builds and deploys both workers.
6. Generates secrets and pipes them straight to `wrangler secret put`: a separate
   `ROSE_MASTER_KEY` for each worker, `UPSTREAM_SIGNING_SECRET`, and your
   `RESEND_API_KEY`. They are never printed or written to disk. Existing master keys are
   **kept** on re-runs (replacing one would orphan encrypted data). Between step 5 and
   this step the workers fail closed (HTTP 503).

It is safe to re-run. Commit the changed `wrangler.jsonc` files; they contain no secrets.

## What you do by hand

| Task | Why it is manual |
|---|---|
| **DNS**: proxied records for `@`, `*` and the admin host (e.g. `AAAA 100::`) | The script has no DNS permissions by design; it prints the exact records |
| **Back up the tenant worker's `ROSE_MASTER_KEY`** | Cloudflare never shows a secret again. To hold a copy, set it yourself *before* running setup: `openssl rand -base64 32`, store it in your secret manager, then `wrangler secret put ROSE_MASTER_KEY` in `apps/app`. Setup keeps an existing key |
| Verify your sending domain with the email provider | Done in the provider's dashboard |
| Cloudflare Access on the admin hostname (recommended) | See below |
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

## Subsequent deploys

```sh
pnpm deploy
```

Runs `pnpm verify` (guard, types, all tests), builds, applies migrations and deploys
both workers. It stops at the first failure and refuses to run while `wrangler.jsonc`
still has placeholder values. In CI, run the same command with `CLOUDFLARE_API_TOKEN`.

Tenant database migrations need no step: each tenant's Durable Object applies new module
migrations the next time it starts after a deploy.

## Configuration reference

| Name | Worker | Kind | Meaning |
|---|---|---|---|
| `ROSE_MASTER_KEY` | both (different values) | secret | base64 of 32 random bytes; root of key derivation |
| `ROSE_MASTER_KEY_PREVIOUS` | both | secret, optional | Old key during rotation ([encryption.md](encryption.md)) |
| `ENVIRONMENT` | both | var | `production` in deployed workers. Anything else enables on-screen sign-in codes |
| `APP_BASE_DOMAIN` | both | var | Tenants live at `<slug>.<this>` |
| `APP_NAME` | both | var | Product name in UI, emails, passkey prompts |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY` | both | var, var, secret | Mail delivery |
| `BOOTSTRAP_OPERATOR_EMAIL` | admin | var | May become the first operator while there are none |
| `APP_URL_TEMPLATE` | admin | var | How the console links to tenant apps, `https://{host}` |
| `UPSTREAM_MODE`, `UPSTREAM_ORIGIN` | app | var | `off` \| `origin` \| `dispatch` |
| `UPSTREAM_SIGNING_SECRET` | app | secret | Signs the tenant token sent upstream |
| `RL_AUTH` | both | rate-limit binding | Required in production |
| `DB` | both | D1 binding | Control plane |
| `TENANT_DO` | app only | Durable Object | Per-tenant databases |

## Production checklist

- [ ] `pnpm verify` is green on the commit you deploy; CI is required on `main`.
- [ ] `ENVIRONMENT` is `production` in both workers (Setup shows it).
- [ ] Real base domain; DNS records proxied; HTTPS works on apex, a tenant and the console.
- [ ] Email provider configured and the sending domain verified (SPF/DKIM).
- [ ] At least two platform owners, each with a passkey.
- [ ] Cloudflare Access in front of the console.
- [ ] The tenant worker's master key is backed up in a secret manager.
- [ ] Branch protection on `main` with CODEOWNERS review, so `guard.lock.json` changes are always seen by a human.
- [ ] You have read the limits in [architecture.md](architecture.md#known-limits).

## Operations

- **Cron** runs every minute in both workers: background jobs and cleanup of expired
  sessions, codes, handoffs, challenges and invitations.
- **Logs**: Workers observability is enabled. Errors are JSON lines with a `requestId`,
  which is also returned to the client in `X-Request-Id` and in error bodies.
- **Suspending a tenant** (console) blocks its sessions and API keys on the next request.
- **Deleting a tenant** is asynchronous and irreversible: the tenant database and its
  encryption key are destroyed by the next cron tick.
- **Backups**: D1 has point-in-time recovery (Time Travel). Durable Object storage has
  its own point-in-time recovery API; Rose does not wrap it yet.
- **Rotating secrets**: [encryption.md](encryption.md#rotating-the-master-key). Rotating
  `UPSTREAM_SIGNING_SECRET` needs the upstream to accept both values during the switch.
