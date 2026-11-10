# Contributing

Thanks for helping. Rose is Apache-2.0; by contributing you agree your work is licensed
under the same terms.

## Setup

```sh
pnpm install
pnpm dev        # runs everything locally, no accounts needed
pnpm verify     # guard + typecheck + all tests: must pass before a PR
```

Requirements: Node 22+, pnpm. See [docs/local-development.md](docs/local-development.md).

## Ground rules

- **Read [AGENTS.md](AGENTS.md).** The invariants there apply to humans too.
- New product features are **modules** in `apps/app/worker/modules/`
  ([docs/adding-a-module.md](docs/adding-a-module.md)). They rarely need core changes.
- Changes to the **protected security core** need a clear justification, a test that
  proves the security property, and a maintainer-approved `guard.lock.json` update
  (`pnpm guard:approve`, run by a human after reviewing the diff).
  See [docs/agents.md](docs/agents.md#5-the-protected-core-and-guardlockjson).
- Never edit a shipped migration; add a new one.
- No new dependency without discussion. Every dependency is attack surface.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.
- Keep docs honest: if something is not implemented or not tested, say so.

## Pull requests

- One topic per PR; fill in the template's security checklist.
- CI runs the same checks as `pnpm verify`, plus a build.
- List any `guard-allow` exception and why. The expected number is zero.

## Reporting security issues

Privately, please: see [SECURITY.md](SECURITY.md).

## Using AI agents

Welcome, and expected. The repository ships agent instructions, hooks and skills
([docs/agents.md](docs/agents.md)). You remain responsible for what you submit: review
the diff, and never let an agent approve its own changes to the security core.
