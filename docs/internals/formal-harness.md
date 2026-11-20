# Formal harness

`pnpm formal` runs `scripts/formal.mjs`. It checks every `formal/*/formal.json` flow with TLC, proves each mutant fails, and detects when modelled code changed.

## Manifest

Each `formal/<flow>/formal.json` names the model, its rules, its mutants, and the code it models.

- `flow` equals the directory name.
- `spec` and `config` name the `.tla` model and the main `.cfg`.
- `rules` has one entry per checked property. Each entry has `id`, `kind` (`safety` or `liveness`), `sentence`, and `harm`. The id is the TLA name TLC prints.
- `mutants` has one entry per guard the model can switch off. `breaks` names the rule the mutant violates. Every rule needs at least one mutant.
- `covered` lists the modelled files, the functions to hash, and the expected `sha256`.
- `bounds`, `notModelled`, and `traceTest` record scope. `timeoutSeconds` overrides the 120 second per-run limit.

Unknown keys, a rule with no mutant, a mutant id missing from the model, or a covered hash that is not 64 hex characters all fail.

## Exit codes

TLC 1.7.4 returns 0 for a pass, 12 for a safety violation, and 13 for a temporal violation. The harness treats only those three as model outcomes. Every other code is a model or infrastructure error and never counts as "mutant killed".

| Code | Meaning |
|---|---|
| 0 | pass |
| 10 | ASSUME evaluated to FALSE |
| 11 | deadlock, no enabled next step |
| 12 | safety invariant violated |
| 13 | temporal property violated |
| 150 | parse or semantic error |
| 151 | constant missing from cfg |
| 255 | out of memory |
| 1 | bad option |
| 142 | timed out |

A run that prints "is violated" or "properties were violated" while exiting 0 also fails. This catches a stray `-continue` flag, which TLC must never receive.

## Mutant runs

TLC reports only the first violated invariant, and a temporal failure never names the property. The harness generates one config per mutant. The generated config keeps the main config's constants, sets `MUTANTS = {"<mutant-id>"}`, and declares only `INVARIANT <breaks>` or `PROPERTY <breaks>`.

Each mutant id must appear verbatim in the model as `"<id>" \in MUTANTS`. A misspelt id would otherwise disable nothing and exit 0 silently.

A config with both `SYMMETRY` and a `PROPERTY` is refused. TLC then gives false counterexamples.

## Drift detection

The harness hashes the covered function bodies, not the files. Comment-only edits must not force a resync. The repository runs typescript 7.0.2, whose module has no compiler API, and adding a parser dependency needs owner sign-off. A small scanner in `scripts/formal.mjs` finds `function <name>(`, `const <name> =`, and `"<name>":`, then extracts the brace-delimited body while skipping strings, template literals, regex literals, and comments. It strips comments and whitespace and hashes the rest.

A missing function counts as stale. A name defined twice fails. The scanner accepts only brace-delimited bodies. A covered function written as an expression-bodied arrow (`const f = () => 1`) fails loudly instead of hashing the wrong text.

`--resync <flow>` recomputes and rewrites only the `sha256` fields, and only after the flow passes main and every mutant.

## Run layout

Every TLC run gets a fresh `mkdtemp` metadir under `formal-runs/` (git-ignored) and removes it after. TLC stores its state there. The generated mutant config is written next to the flow, as `Mutant-<suffix>.cfg`, and removed after the run.

The config goes next to the flow because TLC, when spawned from a test runner, could not read a config file written into a directory the harness created in the same run. It reads a file written into an existing directory. The metadir has no such problem; TLC writes its own state there.

## Toolchain

The jar is tla2tools 1.7.4, cached at `~/.cache/rose-formal/tla2tools.jar` and verified against `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. A download goes to a temp file, is verified, and renamed. Java resolves from `$JAVA`, then `$JAVA_HOME/bin/java`, then `mise where java@temurin-25` plus `bin/java`, then `PATH`.
