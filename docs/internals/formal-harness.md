# Formal harness

`pnpm formal` runs `scripts/formal.mjs`. It checks every `formal/*/formal.json` flow with TLC, proves each mutant fails, and detects when modelled code changed. It is not yet run by `pnpm verify` or CI (T2 wires it).

CLI options:

- `--flows <dir>`: read flows from `<dir>` instead of `formal/`. Bare `--flows` without a path or a path that does not exist is rejected.
- `--resync <flow>`: recompute and rewrite only the `sha256` fields for `<flow>`, and only after the flow passes every main config and every mutant. Bare `--resync` without a flow name is rejected.
- Unknown flags and positional arguments are rejected.

## Manifest

Each `formal/<flow>/formal.json` names the model, its configs, its rules, its mutants, and the code it models.

- `flow` equals the directory name.
- `spec` names the `.tla` model.
- `config` or `configs` (exactly one of the two):
  - `"config": "<x>.cfg"` names a single `.cfg` holding every rule.
  - `"configs": [{ "file": "<x>.cfg", "rules": ["<ruleId>", ...] }, ...]` lists multiple `.cfg` files (for example, a symmetric safety config and a non-symmetric liveness config).
- `rules` has one entry per checked property. Each entry has `id`, `kind` (`safety` or `liveness`), `sentence`, and `harm`. The id is the TLA name TLC prints.
- `mutants` has one entry per guard the model can switch off. `breaks` names the rule the mutant violates, with optional `code` and `change` (non-empty string). Every rule needs at least one mutant.
- `covered` lists the modelled files, the functions to hash (each a non-empty string), and the expected `sha256`.
- `bounds` records model bounds; optional `assumptions` (array of non-empty strings), `notModelled` (array of strings), and `traceTest` record scope.
- `timeoutSeconds` overrides the 120-second default per TLC run for that flow. It must be a finite positive number up to 3600 (`MAX_TIMEOUT_SECONDS`).

Unknown keys, specifying both or neither of `config`/`configs`, a rule not assigned to exactly one config, a rule missing from its config's `INVARIANT(S)` / `PROPERTY`/`PROPERTIES`, a rule with no mutant, a mutant id missing from the model, an out-of-range or non-finite `timeoutSeconds`, or a covered hash that is not 64 hex characters all fail.

## Configs and rule placement

The config parser (`parseCfg`) is CRLF-safe and driven by TLC's `.cfg` keywords (`SPECIFICATION`, `INIT`, `NEXT`, `CONSTANT`/`CONSTANTS`, `CONSTRAINT`/`CONSTRAINTS`, `ACTION_CONSTRAINT`/`ACTION_CONSTRAINTS`, `INVARIANT`/`INVARIANTS`, `PROPERTY`/`PROPERTIES`, `SYMMETRY`, `VIEW`, `TYPE`, `TYPE_CONSTRAINT`, `CHECK_DEADLOCK`, `ALIAS`, `POSTCONDITION`), not indentation. Line comments (`\*`) and block comments (`(* ... *)`) are ignored.

- Every rule in `formal.json` must be assigned to exactly one config.
- Every `safety` rule must be declared under `INVARIANT` or `INVARIANTS` in its assigned config.
- Every `liveness` rule must be declared under `PROPERTY` or `PROPERTIES` in its assigned config.
- `SYMMETRY` is refused in any config holding a liveness rule or a `PROPERTY`/`PROPERTIES` directive (TLC produces false counterexamples when symmetry reduction is combined with liveness). Put safety rules in a separate symmetric config via `configs`.
- `VIEW` and other TLC cfg keywords pass through unchanged into generated mutant configs.

## Exit codes

TLC 1.7.4 reports its outcomes through `tlc2.output.EC.ExitStatus`. The harness drives classification and descriptions from `TLC_EXIT_TABLE` and treats only a pass, a safety violation, and a temporal violation as model outcomes. Every other code, timeout, or signal is a model or infrastructure error and never counts as "mutant killed".

| Code | Meaning |
|---|---|
| 0 | pass |
| 10 | ASSUME evaluated to FALSE |
| 11 | deadlock, no enabled next step |
| 12 | safety invariant violated |
| 13 | temporal property violated |
| 14 | Assert evaluated to FALSE |
| 75 | spec evaluation failed |
| 76 | safety invariant evaluation failed |
| 77 | liveness property evaluation failed |
| 150 | spec parse error |
| 151 | config parse error |
| 152 | state space too large |
| 153 | system error |
| 255 | TLC error |

A timeout is the harness's own kill, never a TLC exit code: `runTlc` gives `spawnSync` a timeout, and a run whose java process had to be killed reports `ETIMEDOUT`, which `runOutcome` classifies as `timeout`. Non-timeout signals (such as `SIGKILL` or `SIGSEGV`) are reported as their own `signal` outcome (`killed by signal <SIG>`).

A run that prints "is violated" or "properties were violated" while exiting 0 also fails. This catches a stray `-continue` flag, which TLC must never receive.

## Mutant runs

TLC reports only the first violated invariant, and a temporal failure never names the property. The harness generates one config per mutant from the config that owns the mutant's `breaks` rule. The generated config keeps that config's constants, `VIEW`, and other directives, sets `MUTANTS = {"<mutant-id>"}`, strips `SYMMETRY` for liveness mutants, and declares only `INVARIANT <breaks>` or `PROPERTY <breaks>`.

Each mutant id must appear verbatim in the model as `"<id>" \in MUTANTS`. A misspelt id would otherwise disable nothing and exit 0 silently.

## Drift detection

The harness hashes the covered functions, not the files. `scripts/formal.mjs` parses each covered file with `oxc-parser` (`parseSync`; a direct devDependency pinned to 0.156.0) and walks the AST for each covered name, matching it as a function declaration, a variable declarator at any nesting depth whose initializer is an arrow or function expression (optionally wrapped in one call such as `idempotent(...)`), or an object property with a string or identifier key whose value is such a function. The hashed span runs from the declaration start (`export`/`async`/`function`/`const` keyword, or the property key) to its end, so parameters, defaults, types, `async`, and the body are all covered.

Normalisation drops the comment ranges `parseSync` returns and collapses whitespace, then hashes with SHA-256. Comment-only and whitespace-only edits keep the hash; any other edit changes it.

A missing function counts as stale. A name defined more than once in a file fails naming the file and both line numbers. A parse error in a covered file fails the check.

When covered code drifts, the harness tells you to re-check the model against the changed code (`docs/internals/formal-harness.md`), then run `pnpm formal --resync <flow>`.

## Run layout

Every TLC run gets a fresh `mkdtemp` directory under `formal-runs/` (git-ignored) and removes it afterward. TLC stores its `-metadir` state inside that temp directory, and generated mutant configs are written only inside that temp directory (never into tracked flow directories). TLC is invoked with the per-run temp directory as `cwd`, an absolute `-config` path, and `-DTLA-Library=<specDir>` so the flow's `.tla` directory is on the TLC module path.

## Toolchain and testing

The jar is tla2tools 1.7.4, cached at `~/.cache/rose-formal/tla2tools.jar` and verified against `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. Downloads use `AbortSignal.timeout` (60 seconds), enforce a 32 MiB size cap, verify the SHA-256 before writing to a temp file, and atomically rename into place.

Java resolves in order: `$JAVA`, then `$JAVA_HOME/bin/java`, then `mise where java@temurin-25` (only if neither `$JAVA` nor `$JAVA_HOME` resolved, with a 5-second timeout), then `PATH`.

In `scripts/formal.test.mjs`, the real-TLC fixture test skips only when no Java is found and prints a loud `SKIPPED` notice.
