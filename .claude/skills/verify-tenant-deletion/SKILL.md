---
name: verify-tenant-deletion
description: >
  Formally check Rose's workspace deletion grace period (no early purge of tenant
  private storage). Use when changing tenant deletion, purge jobs, Tenant DO purge,
  cancel-deletion, or anything under packages/core/src/control/tenants.ts,
  packages/core/src/tenant-app.ts (tenant.purge), packages/core/src/tenancy/context.ts,
  or packages/core/src/tenancy/tenant-do.ts; or when the user asks to verify deletion
  safety, grace period, or early purge.
---

# Verify tenant deletion (formal)

## Property

**Private tenant storage is never destroyed before `delete_after`.**

Harm if broken: the only copy of a workspace's data (and its wrapped data key) is wiped while the owner can still cancel inside the advertised 48-hour window.

## When to run this

Run before you finish any change that touches the covered files below. If your diff does not touch them and you are not asked about deletion/purge, skip.

## Covered code

| Path | What the model treats as one step |
|---|---|
| `packages/core/src/control/tenants.ts` | `requestTenantDeletion`, `cancelTenantDeletion`, `beginTenantPurge`, `deleteTenantRecords`, suspend/resume |
| `packages/core/src/tenant-app.ts` | `tenantJobHandlers["tenant.purge"]` grace gate → begin → wipe |
| `packages/core/src/tenancy/context.ts` | `purgeTenantStorage` |
| `packages/core/src/tenancy/tenant-do.ts` | `assertTenant` / `purge` |

Model + config: `formal/tenant-deletion/TenantDeletion.tla`, `TenantDeletion.cfg`.

**Sync commit (model last confirmed against this tree):** replace this line after a successful run that you verified still describes the code:

`sync-commit: 2fea6b00ac044ec405a6f20bda29ffc58a843ac2`

Move `sync-commit` forward only after you confirm the TLA actions still match those functions at the new commit (re-read the files; do not bump on hope).

## Bounds and assumptions

- Two tenants `{t1, t2}`; grace = 2 ticks; clock ≤ 5. Ticks abstract `DELETE_GRACE_MS` (48h), not wall-clock ms.
- One purge success is `BeginPurge` then `DestroyAndWipe` (handler may do both in one invocation; ordering is what matters).
- Does **not** model host-cache staleness, control-plane row races beyond status, or Cloudflare DO scheduling. A pass is a pass of this model under these bounds, not of the whole platform.
- Cross-tenant wipe is impossible in the model because destroy only updates index `t` of the job's tenant (mirrors `idFromName(tenantId)` + `assertTenant`).

## How to run

From the repo root:

```sh
node formal/tenant-deletion/sync-check.mjs
chmod +x formal/tenant-deletion/run.sh   # once
formal/tenant-deletion/run.sh formal/tenant-deletion/out
```

Needs Node, Java 11+ (`mise install java@temurin-25`), `formal/tools/tla2tools.jar` (v1.7.4), and the pstack **statechart** skill (Cursor plugin). You can set `JAVA` and `TLA2TOOLS` yourself.

Exit codes: `0` all invariants hold; `1` an invariant breaks (real finding); `2` tool/setup error.

With the default bounds (2 tenants, Grace=2, MaxClock=5) TLC explores ~2,106 distinct states, above the statechart drawing budget of 500, so a pass writes `report.md` and `tlc.out` but no `chart.mmd`. That is expected; the invariants are still checked. Use `/statechart` to read the report.

## Reading the result

1. Read every TLC / statechart result with the pstack **`/statechart`** skill. Do not invent Mermaid or paraphrase TLC traces by hand when `/statechart` is available.
2. **Pass:** `sync-check` OK and statechart exit 0. Report: property holds under the bounds above.
3. **Fail (invariant):** Treat it as a product bug until you prove a modeling error. Tell the user the property in one sentence, the harm in one sentence, and the counterexample as a short sequence in product words (owner schedules deletion → purge runs before deadline → storage gone). Do **not** weaken the invariant or the model to make it pass. Do **not** change product code unless the user asks.
4. **Fail (sync-check):** The TypeScript no longer contains the grace gates the model claims. Either restore the gate or update the model to match the new code, then re-run TLC. If the new code allows early purge, TLC must fail — that is a finding.
5. **Modeling error only when:** a step in the counterexample cannot happen in the listed functions (wrong guard, merged steps that are not atomic in code, etc.). Fix the model, re-run; do not drop the property.

## After an intentional change

If the change deliberately alters deletion behaviour, update `TenantDeletion.tla` so every action still points at real code, re-run both commands, then set `sync-commit` to the new HEAD only after the check matches.

## Broken-variant check (do this when creating or materially editing this skill)

1. Scratch-remove the grace gate in `tenant-app.ts` (`row.delete_after !== null && row.delete_after > t` early return) **or** the `delete_after <= ?` clause in `beginTenantPurge`.
2. Run `node formal/tenant-deletion/sync-check.mjs` — it must fail.
3. Restore the scratch change. Confirm sync-check and `run.sh` are green again.

To see TLC itself fail the property, temporarily add a model action that destroys storage while `clock < deleteAfter[t]`, run `run.sh` into a fresh out dir, read the path with `/statechart`, then drop that action.

## Maintain

Use `/maintain-formal-verification-skill` after covered code changes that did not re-run this check.
