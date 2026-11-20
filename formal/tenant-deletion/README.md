# Tenant deletion formal check

TLA+ model of Rose's workspace deletion grace period. Agents: use the project skill
`.cursor/skills/verify-tenant-deletion` (or ask for `/verify-tenant-deletion`).

```sh
node formal/tenant-deletion/sync-check.mjs
formal/tenant-deletion/run.sh
```

Tooling: Java 11+ (`mise install java@temurin-25`), `formal/tools/tla2tools.jar`
(sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, tla2tools 1.7.4),
and the pstack statechart skill.
