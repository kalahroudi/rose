# Local development

```sh
pnpm install
pnpm dev
```

`pnpm dev` needs no configuration and no Cloudflare account. It:

1. creates `apps/app/.dev.vars` and `apps/admin/.dev.vars` with fresh random keys if they
   are missing (git-ignored; existing files are kept so local data stays readable);
2. applies control-plane migrations to a local D1 database in `.wrangler/state`;
3. starts **one** local Workers runtime on `127.0.0.1:8787` running both workers plus a
   small development router (`scripts/dev/`), so they share the same database;
4. starts Vite for the operator console (`:5173`) and the tenant app (`:5174`) with hot
   reload; API calls are proxied to the runtime with the original `Host` header;
5. pings both workers every 3 seconds to run the sweep that the hourly cron runs in
   production (cron triggers do not fire locally). Jobs themselves start through the
   local queue, as in production.

| URL | What |
|---|---|
| http://localhost:5173 | Operator console. Sign in as `admin@example.com` (set `ROSE_ADMIN_EMAIL=you@x.com pnpm dev` on first run to change it). |
| http://rose.localhost:5174 | Tenant app root: sign up and create a workspace. `*.localhost` resolves to your machine in Chrome, Firefox and Edge. For Safari add `rose.localhost` to `/etc/hosts`. |
| http://`<slug>`.rose.localhost:5174 | A workspace. For Safari add `<slug>.rose.localhost` to `/etc/hosts` too. |

The tenant app root is `rose.localhost`, not `localhost`. Browsers treat `localhost` and
`<slug>.localhost` as two different sites, so the handoff from root to workspace counts as
cross-site. `rose.localhost` and `<slug>.rose.localhost` are one site, as the root domain
and its workspaces are in production. A checkout whose `.dev.vars` still says
`APP_BASE_DOMAIN=localhost` is moved to `rose.localhost` the next time `pnpm dev` or
`pnpm setup` runs, and the terminal says so. After the move you are signed out of the
tenant app and passkeys registered on the old hosts no longer work, so sign in with the
code and re-add them. Any other value you set is kept. The operator console stays on
`localhost:5173`.

**Sign-in codes** are shown on the sign-in screen and printed in the terminal. No email
is sent in development.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Run everything locally |
| `pnpm verify` | Guard + knip (dead code) + script tests + typecheck + all tests. The definition of "it works" |
| `pnpm guard` | Static guardrails only (fast) |
| `pnpm test` | All test suites, in the real Workers runtime |
| `pnpm test:coverage` | The same suites with a coverage report per package ([testing.md](testing.md#coverage)) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm build` | Production build of both SPAs |
| `pnpm setup` | (Re)create local secrets, git hooks, local database |
| `pnpm brand --name … --color …` | Rebrand ([branding.md](branding.md)) |
| `pnpm test:scripts` | Tests for the guard, scripts and the example upstream |

## Resetting local data

```sh
rm -rf .wrangler/state      # all tenants, users and sessions
pnpm dev                    # recreates the database
```

Deleting `.dev.vars` as well generates new keys; data encrypted under the old keys
becomes unreadable, so remove `.wrangler/state` at the same time.

## Trying the upstream gateway

See [`examples/upstream-service`](../examples/upstream-service/README.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` on 8787, 5173 or 5174 | Another `pnpm dev` (or other tool) is running. Stop it. |
| "Sessions require HTTPS" | `ENVIRONMENT=production` with an `http://` URL. Local `.dev.vars` must say `development`. |
| Passkey prompt fails on `*.localhost` in Safari | Use Chrome/Firefox locally, or sign in with the email code. |
| A workspace says "not found" right after renaming or deleting | The host cache lasts up to 5 seconds. |
| Tests fail with a storage error after changing a core migration | Core migrations are immutable once shipped; add a new numbered file. |

## How it differs from production

- One runtime and a dev router instead of two deployed Workers on separate hostnames.
- `http://` and plain cookie names (`rose_session`) instead of `__Host-` cookies.
- Codes on screen instead of email; custom domains activate without verification.
- The hourly sweep runs every 3 seconds.
