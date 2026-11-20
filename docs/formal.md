# Formal models

`pnpm formal` runs `scripts/formal.mjs`. It checks every `formal/<flow>/formal.json`
flow with TLC, proves each mutant fails, and fails when modelled code changed. It runs
in `pnpm verify` (after `pnpm test:scripts`) and in the CI verify job. With no
`formal/` directory it prints `formal: no flows found` and passes.

## What a model is

A flow is one code flow (for example tenant deletion) modelled with several rules,
written as a TLA+ spec plus a manifest. The manifest `formal/<flow>/formal.json`
declares the model and the code it models:

- `flow` equals the directory name.
- `spec` names the `.tla` model in that directory.
- `config` names a single `.cfg`, or `configs` lists several `.cfg` files and which
  rules each one checks.
- `rules` lists the checked properties: `id` (the TLA name TLC prints), `kind`
  (`safety` or `liveness`), `sentence` (one plain sentence), and `harm` (one sentence
  of the harm if broken).
- `mutants` lists the guards the model can switch off. Each has `id`, `breaks` (the
  rule it must violate), and optional `code` and `change`.
- `covered` lists the modelled source files, the functions to hash, and the expected
  `sha256`.
- `bounds` records model bounds. `assumptions`, `notModelled`, and `traceTest` are
  optional and record scope.

A run first checks the main config, then runs one TLC pass per mutant. A mutant must
make its rule fail. A mutant that survives (the model still passes) is a failed check.

## Quality bar

A flow lands only when all seven hold:

1. True to the code. One TLA+ action = one indivisible code step (one D1 statement or batch, one DO call). A read-then-write in code is two actions. Each action has a `\* code: <path>#<function>` comment a reviewer can open.
2. Able to fail. Every rule has at least one mutant (a removed guard or reordered step) that TLC must report as a violation of that rule. CI checks that the mutants fail.
3. Findings stay findings. If the current code breaks a rule, report it as a bug task with the trace in code words. Never weaken a rule or the model to get green.
4. Honest scope. The manifest states bounds, assumptions and what is not modelled.
5. Readable without TLA+. Each rule is one plain sentence plus one sentence of harm. The owner approves the sentences, not the TLA+.
6. Tied to the code. Each mutant's trace is replayed against the real code as a test, and the real code must block it at the guarded step. Remove the guard and the test fails. The harness checks that `traceTest` names a file but does not run it: the reviewer checks this item. Covered files are hashed; a change to them makes `pnpm formal` fail until someone re-checks the model and resyncs.
7. Cheap to rerun. One command, pinned tool version, under 60 s per flow.

## Adding a flow

1. Create `formal/<flow>/` with `formal.json`, the `.tla` spec, and one or more
   `.cfg` files. `"flow"` must equal the directory name.
2. Declare the rules, mutants, covered files, and bounds in `formal.json`. Every rule
   needs at least one mutant, and every mutant must appear in the model as
   `"<id>" \in MUTANTS`.
3. Leave `sha256` out of each `covered` entry for a new flow.
4. Run `pnpm formal`. A new flow reports stale until a human runs
   `pnpm formal --resync <flow>`, which fills the hashes only after the flow passes.
5. The harness already runs every mutant against the model automatically. To prove the
   real code blocks it (quality bar 6), set `traceTest` to the flow's trace test; a flow
   does not land without one. For each guard, temporarily remove it in the code, run that
   test, confirm it fails, then revert.

Manifest keys, config placement, exit codes, and drift hashing are covered in
[docs/internals/formal-harness.md](internals/formal-harness.md).

## Reading a failure

- **Violation in the main run (no mutant).** Either the code breaks the rule, so file a
  bug with the trace in code words and never weaken the rule or the model to get green;
  or the model is not true to the code, so fix the model to match the code and say why
  in the commit.
- **Safety or liveness violation.** TLC reports `invariant <id> violated` or
  `Temporal properties were violated`. The harness prints the TLC trace under
  `<flow> <check> output:`. Map each step back to the code with the action's
  `\* code: <path>#<function>` marker.
- **Mutant survived.** A mutant run passed when it must fail. The guard that mutant
  switches off is missing from the model, or the model does not express the rule.
  Fix the model, not the rule.
- **Stale hash.** The harness prints `covered code changed: <files>`. The modelled
  code changed since the recorded hash. Re-check the model, then resync (below).

## Stale hashes and resync

A flow is stale when a covered function changed since its recorded `sha256`. A normal
`pnpm formal` run fails on a stale flow, so the change does not land with an
unverified model.

Resync is manual and owner-reviewed:

1. Re-check the model against the changed code.
2. A human runs `pnpm formal --resync <flow>` locally.
3. The resulting `sha256` change is an owner-reviewed diff.

`pnpm verify` and CI never run `--resync`. Only the owner approves a hash refresh.
