// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_SECONDS,
  MISE_TIMEOUT_MS,
  TLC_EXIT_TABLE,
  cfgFlags,
  describeOutcome,
  discoverFlows,
  distinctStates,
  downloadJar,
  ensureJar,
  extractDefinitions,
  findJava,
  generateMutantCfg,
  hashEntry,
  main,
  normalize,
  parseCfg,
  runOutcome,
  runTlc,
  sha256,
  validateManifest,
} from "./formal.mjs";
import { ROOT } from "./lib.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures", "formal");
const TOY = join(FIXTURES, "toy");
const TS_DRIFT = join(FIXTURES, "ts-drift.ts");
const TOY_HASH = "637a9f82c4c1f325b3146f2e47ec50673e7f76a68bfbc83d3593cd8f035d793e";

const read = (p) => readFileSync(p, "utf8");
const toyManifest = () => JSON.parse(read(join(TOY, "formal.json")));
const gitStatus = (paths = []) => execFileSync("git", ["status", "--porcelain", ...paths], { cwd: ROOT, encoding: "utf8" });

function makeTempDir(t, prefix = "rose-formal-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempToy(t) {
  const parent = makeTempDir(t);
  cpSync(TOY, join(parent, "toy"), { recursive: true });
  return parent;
}

function fakeJava(behavior) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const idx = args.indexOf("-config");
    const cfgPath = idx >= 0 ? args[idx + 1] : null;
    let cfgText = "";
    if (cfgPath) {
      try {
        cfgText = readFileSync(cfgPath, "utf8");
      } catch {
        cfgText = "";
      }
    }
    const result = behavior({ cmd, args: [...args], opts, cfgPath, cfgText });
    calls.push({ cmd, args: [...args], opts, cfgPath, cfgText });
    return result;
  };
  return { impl, calls };
}

async function runHarness(argv, { behavior, java = "/fake/java", findJava: fj } = {}) {
  const logLines = [];
  const errLines = [];
  const fake = fakeJava(behavior ?? (() => ({ status: 0, stdout: "ok" })));
  const r = await main(argv, {
    spawnSync: fake.impl,
    findJava: fj ?? (() => java),
    ensureJar: async () => "/fake/tla2tools.jar",
    log: (s) => logLines.push(s),
    err: (s) => errLines.push(s),
  });
  return { r, fake, logLines, errLines };
}

const toyBehavior = ({ cfgText }) => (cfgText.includes('MUTANTS = {"drop-guard"}')
  ? { status: 12, stdout: "Error: Invariant CounterLeqBound is violated.\n4 distinct states found.\n" }
  : { status: 0, stdout: "Model checking completed. No error has been found.\n3 distinct states found.\n" });

// ── Exit codes, signals and outcomes ──────────────────────────────────────────────

test("runOutcome and describeOutcome are driven by TLC_EXIT_TABLE and reject zero-exit violations", () => {
  const base = { signal: null, error: null, stderr: "", timedOut: false };
  for (const { code, kind, description } of TLC_EXIT_TABLE) {
    const stdout = code === 12
      ? "Error: Invariant NoEarlyPurge is violated."
      : code === 13
        ? "Error: Temporal properties were violated."
        : "Model checking completed. No error has been found.";
    const outcome = runOutcome({ ...base, status: code, stdout });
    assert.equal(outcome.kind, kind, `exit code ${code} should classify as ${kind}`);
    if (code === 12) {
      assert.equal(outcome.invariant, "NoEarlyPurge");
      assert.equal(describeOutcome(outcome), "invariant NoEarlyPurge violated (exit 12)");
    } else {
      assert.equal(describeOutcome(outcome), description);
    }
  }
  const zeroViol = runOutcome({ ...base, status: 0, stdout: "544 lines: Invariant X is violated." });
  assert.equal(zeroViol.kind, "violation-exit-zero");
  assert.equal(describeOutcome(zeroViol), "reported a violation but exited 0");

  const unknown = runOutcome({ ...base, status: 99, stdout: "" });
  assert.deepEqual(unknown, { kind: "unknown", status: 99 });
  assert.equal(describeOutcome(unknown), "exited 99");

  const spawnErr = runOutcome({ ...base, status: null, error: new Error("ENOENT"), stdout: "" });
  assert.deepEqual(spawnErr, { kind: "spawn-error", message: "ENOENT" });
  assert.equal(describeOutcome(spawnErr), "could not run java: ENOENT");
});

test("non-timeout signals are reported as their own signal outcome, distinct from timeouts", () => {
  const sig = runOutcome({ status: null, signal: "SIGKILL", error: null, stdout: "", stderr: "", timedOut: false });
  assert.deepEqual(sig, { kind: "signal", signal: "SIGKILL" });
  assert.equal(describeOutcome(sig), "killed by signal SIGKILL");

  const timedOut = runOutcome({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: "timed out" }, stdout: "", stderr: "", timedOut: true });
  assert.deepEqual(timedOut, { kind: "timeout" });
  assert.equal(describeOutcome(timedOut), "timed out");

  // runTlc must not mark a non-ETIMEDOUT signal as timedOut
  const r = runTlc("/fake/java", "/fake.jar", join(TOY, "Toy.tla"), {
    configPath: join(TOY, "Toy.cfg"),
    spawnSync: () => ({ status: null, signal: "SIGKILL", error: null, stdout: "", stderr: "" }),
  });
  assert.equal(r.timedOut, false);
  assert.deepEqual(runOutcome(r), { kind: "signal", signal: "SIGKILL" });

  // runTlc marks an ETIMEDOUT error as timedOut, classified as timeout rather than signal
  const tlcTimeout = runTlc("/fake/java", "/fake.jar", join(TOY, "Toy.tla"), {
    configPath: join(TOY, "Toy.cfg"),
    spawnSync: () => ({ status: null, signal: "SIGTERM", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }),
  });
  assert.equal(tlcTimeout.timedOut, true);
  assert.deepEqual(runOutcome(tlcTimeout), { kind: "timeout" });
});

test("a mutant killed by SIGKILL is reported as a signal failure, not a killed mutant", async () => {
  const behavior = ({ cfgText }) => (cfgText.includes('MUTANTS = {"drop-guard"}')
    ? { status: null, signal: "SIGKILL", stdout: "", stderr: "" }
    : { status: 0, stdout: "ok" });
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { behavior });
  assert.equal(r.code, 1);
  assert.match(errLines.join("\n"), /killed by signal SIGKILL \(not a killed mutant\)/);
});

// ── parseCfg and mutant cfg generation ────────────────────────────────────────────

test("parseCfg is CRLF-safe, keyword-driven (not indentation-driven) and ignores comments", () => {
  const cfg = [
    "\\* header comment",
    "(* block comment with SYMMETRY Symm",
    "   and PROPERTY FakeProp *)",
    "SPECIFICATION Spec",
    "CONSTANTS",
    "N = 3 \\* inline comment",
    "",
    "TYPE = \"a\"",
    "MUTANTS = {}",
    "  VIEW MyView",
    "INVARIANTS",
    "TypeOK CounterLeqBound",
    "ExtraInv",
    "CONSTRAINT",
    "StateBound",
  ].join("\r\n");

  const sections = parseCfg(cfg);
  assert.deepEqual(sections, [
    { keyword: "SPECIFICATION", args: ["Spec"] },
    { keyword: "CONSTANTS", args: ["N = 3", 'TYPE = "a"', "MUTANTS = {}"] },
    { keyword: "VIEW", args: ["MyView"] },
    { keyword: "INVARIANTS", args: ["TypeOK", "CounterLeqBound", "ExtraInv"] },
    { keyword: "CONSTRAINT", args: ["StateBound"] },
  ]);

  const flags = cfgFlags(sections);
  assert.equal(flags.hasSymmetry, false);
  assert.equal(flags.hasProperty, false);
  assert.deepEqual(flags.invariants, new Set(["CounterLeqBound", "ExtraInv", "TypeOK"]));
});

test("parseCfg splits on whitespace so keywords start sections anywhere on a line and one-line CONSTANTS are kept", () => {
  const inline = "SPECIFICATION Spec CONSTANTS a = 1 b = {t1, t2} MUTANTS = {} INVARIANT TypeOK ExtraInv SYMMETRY Symm PROPERTY Live";
  const sections = parseCfg(inline);
  assert.deepEqual(sections, [
    { keyword: "SPECIFICATION", args: ["Spec"] },
    { keyword: "CONSTANTS", args: ["a = 1", "b = {t1, t2}", "MUTANTS = {}"] },
    { keyword: "INVARIANT", args: ["TypeOK", "ExtraInv"] },
    { keyword: "SYMMETRY", args: ["Symm"] },
    { keyword: "PROPERTY", args: ["Live"] },
  ]);
  const flags = cfgFlags(sections);
  assert.equal(flags.hasSymmetry, true);
  assert.equal(flags.hasProperty, true);
  assert.deepEqual(flags.invariants, new Set(["TypeOK", "ExtraInv"]));
  assert.deepEqual(flags.properties, new Set(["Live"]));

  // validateManifest catches inline SYMMETRY + PROPERTY on the same line
  assert.throws(
    () => validateManifest(toyManifest(), {
      dirName: "toy",
      cfgTexts: { "Toy.cfg": "SPECIFICATION Spec CONSTANT MUTANTS = {} INVARIANT CounterLeqBound SYMMETRY Symm PROPERTY Live\n" },
    }),
    /SYMMETRY is refused/,
  );

  // One-line CONSTANTS keep non-MUTANTS entries in mutant cfg
  const mutant = generateMutantCfg("SPECIFICATION Spec CONSTANTS a = 1 b = {t1, t2} MUTANTS = {} INVARIANT TypeOK", "m1", { id: "TypeOK", kind: "safety" });
  assert.match(mutant, /a = 1/);
  assert.match(mutant, /b = \{t1, t2\}/);
  assert.doesNotMatch(mutant, /MUTANTS = \{\}/);
  assert.match(mutant, /MUTANTS = \{"m1"\}/);
});

test("generateMutantCfg strips MUTANTS <- ... as well as MUTANTS = ...", () => {
  const cfg = [
    "SPECIFICATION Spec",
    "CONSTANTS a = 1 MUTANTS <- EmptySet b = 2",
    "CONSTANT",
    "  MUTANTS <- [Mod] OtherEmpty",
    "  c = 3",
    "INVARIANT TypeOK",
  ].join("\n");
  const mutant = generateMutantCfg(cfg, "m1", { id: "TypeOK", kind: "safety" });
  assert.match(mutant, /a = 1/);
  assert.match(mutant, /b = 2/);
  assert.match(mutant, /c = 3/);
  assert.doesNotMatch(mutant, /MUTANTS\s*<-/);
  assert.match(mutant, /MUTANTS = \{"m1"\}/);
});

test("mutant cfg keeps constants, VIEW and other keywords; strips SYMMETRY for liveness only", () => {
  const mainCfg = [
    "SPECIFICATION Spec",
    "CONSTANT",
    "N = 3",
    "MUTANTS = {}",
    "VIEW MyView",
    "SYMMETRY Symm",
    "CHECK_DEADLOCK FALSE",
    "INVARIANT TypeOK",
    "PROPERTY Term",
  ].join("\r\n");

  const safety = generateMutantCfg(mainCfg, "m1", { id: "TypeOK", kind: "safety" });
  assert.match(safety, /SPECIFICATION Spec/);
  assert.match(safety, /VIEW MyView/);
  assert.match(safety, /SYMMETRY Symm/);
  assert.match(safety, /CHECK_DEADLOCK FALSE/);
  assert.match(safety, /N = 3/);
  assert.doesNotMatch(safety, /MUTANTS = \{\}/);
  assert.match(safety, /MUTANTS = \{"m1"\}/);
  assert.match(safety, /INVARIANT TypeOK/);
  assert.doesNotMatch(safety, /PROPERTY/);
  assert.doesNotMatch(safety, /INVARIANTS/);

  const liveness = generateMutantCfg(mainCfg, "m2", { id: "Term", kind: "liveness" });
  assert.match(liveness, /VIEW MyView/);
  assert.match(liveness, /CHECK_DEADLOCK FALSE/);
  assert.doesNotMatch(liveness, /SYMMETRY/);
  assert.match(liveness, /PROPERTY Term/);
  assert.doesNotMatch(liveness, /INVARIANT/);
});

// ── Multi-config manifests and rule placement ─────────────────────────────────────

test("multi-config manifest validates rule partition, placement, SYMMETRY, and runs each mutant against its owner config", async (t) => {
  const dir = makeTempDir(t);
  const flowDir = join(dir, "multi");
  cpSync(TOY, flowDir, { recursive: true });
  writeFileSync(join(flowDir, "Multi.tla"), `${read(join(TOY, "Toy.tla")).replace("MODULE Toy", "MODULE Multi").replace("====", 'DropLive == "drop-live" \\in MUTANTS\nEventuallyDone == <> (counter = 2)\n====')}\n`);
  writeFileSync(join(flowDir, "Safety.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nVIEW MyView\nSYMMETRY Symm\nINVARIANT CounterLeqBound\n");
  writeFileSync(join(flowDir, "Liveness.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nVIEW LiveView\nPROPERTY EventuallyDone\n");
  const manifest = {
    flow: "multi",
    spec: "Multi.tla",
    configs: [
      { file: "Safety.cfg", rules: ["CounterLeqBound"] },
      { file: "Liveness.cfg", rules: ["EventuallyDone"] },
    ],
    rules: [
      { id: "CounterLeqBound", kind: "safety", sentence: "counter <= 2", harm: "overflow" },
      { id: "EventuallyDone", kind: "liveness", sentence: "counter reaches 2", harm: "stalls" },
    ],
    mutants: [
      { id: "drop-guard", breaks: "CounterLeqBound", code: "scripts/fixtures/formal/toy/toy.ts#counterGuard" },
      { id: "drop-live", breaks: "EventuallyDone", code: "scripts/fixtures/formal/toy/toy.ts#counterGuard" },
    ],
    covered: toyManifest().covered,
    bounds: "bound 2",
    notModelled: [],
  };
  writeFileSync(join(flowDir, "formal.json"), JSON.stringify(manifest, null, 2) + "\n");

  const behavior = ({ cfgText }) => {
    if (cfgText.includes('MUTANTS = {"drop-guard"}')) {
      assert.match(cfgText, /VIEW MyView/);
      assert.match(cfgText, /SYMMETRY Symm/);
      assert.match(cfgText, /INVARIANT CounterLeqBound/);
      return { status: 12, stdout: "Error: Invariant CounterLeqBound is violated.\n4 distinct states found.\n" };
    }
    if (cfgText.includes('MUTANTS = {"drop-live"}')) {
      assert.match(cfgText, /VIEW LiveView/);
      assert.doesNotMatch(cfgText, /SYMMETRY/);
      assert.match(cfgText, /PROPERTY EventuallyDone/);
      return { status: 13, stdout: "Error: Temporal properties were violated.\n5 distinct states found.\n" };
    }
    return { status: 0, stdout: "Model checking completed. No error has been found.\n3 distinct states found.\n" };
  };

  const { r, fake } = await runHarness(["--flows", dir], { behavior });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(r.checks.map((c) => c.check), [
    "main (Safety.cfg)",
    "main (Liveness.cfg)",
    "mutant drop-guard",
    "mutant drop-live",
  ]);
});

test("validateManifest rejects invalid config/configs, rule placement mismatches, and SYMMETRY with liveness", () => {
  const base = toyManifest();

  // Both config and configs
  const both = { ...base, configs: [{ file: "Toy.cfg", rules: ["CounterLeqBound"] }] };
  assert.throws(() => validateManifest(both, { dirName: "toy" }), /cannot specify both/);

  // Neither config nor configs
  const neither = { ...base };
  delete neither.config;
  assert.throws(() => validateManifest(neither, { dirName: "toy" }), /must specify "config" or "configs"/);

  // Rule missing from configs
  const multi = {
    ...base,
    rules: [
      ...base.rules,
      { id: "EventuallyDone", kind: "liveness", sentence: "s", harm: "h" },
    ],
    mutants: [
      ...base.mutants,
      { id: "drop-live", breaks: "EventuallyDone" },
    ],
    configs: [{ file: "Safety.cfg", rules: ["CounterLeqBound"] }],
  };
  delete multi.config;
  assert.throws(() => validateManifest(multi, { dirName: "toy" }), /EventuallyDone.*not assigned/);

  // Rule listed in two configs
  const dupRule = {
    ...multi,
    configs: [
      { file: "Safety.cfg", rules: ["CounterLeqBound"] },
      { file: "Liveness.cfg", rules: ["CounterLeqBound", "EventuallyDone"] },
    ],
  };
  assert.throws(() => validateManifest(dupRule, { dirName: "toy" }), /CounterLeqBound.*exactly one config/);

  // Rule missing from cfg's INVARIANT/PROPERTY
  assert.throws(
    () => validateManifest(base, {
      dirName: "toy",
      cfgTexts: { "Toy.cfg": "SPECIFICATION Spec\nCONSTANT MUTANTS = {}\nPROPERTY CounterLeqBound\n" },
    }),
    /safety rule "CounterLeqBound" must be declared under INVARIANT/,
  );

  const livenessManifest = {
    ...base,
    rules: [{ id: "EventuallyDone", kind: "liveness", sentence: "s", harm: "h" }],
    mutants: [{ id: "drop-guard", breaks: "EventuallyDone" }],
  };
  assert.throws(
    () => validateManifest(livenessManifest, {
      dirName: "toy",
      cfgTexts: { "Toy.cfg": "SPECIFICATION Spec\nCONSTANT MUTANTS = {}\nINVARIANT EventuallyDone\n" },
    }),
    /liveness rule "EventuallyDone" must be declared under PROPERTY/,
  );

  // SYMMETRY with liveness rule refused
  assert.throws(
    () => validateManifest(livenessManifest, {
      dirName: "toy",
      cfgTexts: { "Toy.cfg": "SPECIFICATION Spec\nCONSTANT MUTANTS = {}\nSYMMETRY Symm\nPROPERTY EventuallyDone\n" },
    }),
    /SYMMETRY is refused/,
  );
});

test("a cfg with SYMMETRY and a PROPERTY is refused end to end", async (t) => {
  const dir = tempToy(t);
  writeFileSync(join(dir, "toy", "Toy.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nSYMMETRY Symm\nINVARIANT CounterLeqBound\nPROPERTY Term\n");
  const { r, errLines } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("SYMMETRY"));
});

// ── timeoutSeconds ────────────────────────────────────────────────────────────────

test("timeoutSeconds validates finiteness and maximum, and is passed to TLC per flow", async (t) => {
  const base = toyManifest();
  for (const badVal of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX_TIMEOUT_SECONDS + 1, "10"]) {
    assert.throws(() => validateManifest({ ...base, timeoutSeconds: badVal }, { dirName: "toy" }), /timeoutSeconds/);
  }
  assert.doesNotThrow(() => validateManifest({ ...base, timeoutSeconds: MAX_TIMEOUT_SECONDS }, { dirName: "toy" }));

  const dir = tempToy(t);
  const manifest = JSON.parse(read(join(dir, "toy", "formal.json")));
  manifest.timeoutSeconds = 17;
  writeFileSync(join(dir, "toy", "formal.json"), JSON.stringify(manifest, null, 2) + "\n");
  const { r, fake } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 0);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) assert.equal(call.opts.timeout, 17_000);

  // Default timeout when timeoutSeconds is omitted
  const { fake: defaultFake } = await runHarness(["--flows", FIXTURES], { behavior: toyBehavior });
  for (const call of defaultFake.calls) assert.equal(call.opts.timeout, DEFAULT_TIMEOUT_MS);
});

// ── TLC invocation, temp mutant cfgs, clean git status ────────────────────────────

test("TLC argv never contains -continue and mutant cfgs live only in per-run temp dirs", async () => {
  const beforeEntries = readdirSync(TOY).sort();
  const seenMetadirs = [];
  const seenMutantCfgs = [];

  const behavior = ({ args, cfgPath, cfgText }) => {
    assert.ok(!args.includes("-continue"), "argv must never pass -continue");
    assert.ok(args.includes(`-DTLA-Library=${resolve(TOY)}`), "TLA-Library must include spec dir");
    const metadir = args[args.indexOf("-metadir") + 1];
    seenMetadirs.push(metadir);
    // Tracked dir must never gain any files even while TLC is running
    assert.deepEqual(readdirSync(TOY).sort(), beforeEntries);
    if (cfgText.includes('MUTANTS = {"drop-guard"}')) {
      seenMutantCfgs.push(cfgPath);
      assert.equal(dirname(cfgPath), dirname(metadir), "mutant cfg must be in per-run temp dir");
      assert.notEqual(dirname(cfgPath), resolve(TOY), "mutant cfg must never be written in tracked dir");
      return { status: 12, stdout: "Error: Invariant CounterLeqBound is violated.\n4 distinct states found.\n" };
    }
    return { status: 0, stdout: "Model checking completed. No error has been found.\n3 distinct states found.\n" };
  };

  const { r } = await runHarness(["--flows", FIXTURES], { behavior });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.equal(seenMutantCfgs.length, 1);
  assert.equal(existsSync(seenMutantCfgs[0]), false, "mutant cfg removed after run");
  for (const m of seenMetadirs) assert.equal(existsSync(m), false, "metadir removed after run");
  assert.deepEqual(readdirSync(TOY).sort(), beforeEntries);
});

test("each concurrent TLC run gets a unique metadir that is removed afterwards", async () => {
  const metadirs = [];
  const impl = (_cmd, args) => {
    metadirs.push(args[args.indexOf("-metadir") + 1]);
    const cfg = args[args.indexOf("-config") + 1];
    return readFileSync(cfg, "utf8").includes('MUTANTS = {"drop-guard"}')
      ? { status: 12, stdout: "Error: Invariant CounterLeqBound is violated." }
      : { status: 0, stdout: "ok" };
  };
  const opts = { spawnSync: impl, findJava: () => "/fake/java", ensureJar: async () => "/fake.jar", log: () => {}, err: () => {} };
  const [a, b] = await Promise.all([main(["--flows", FIXTURES], opts), main(["--flows", FIXTURES], opts)]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(metadirs.length, 4);
  assert.equal(new Set(metadirs).size, 4, "metadirs must be unique");
  for (const m of metadirs) assert.equal(existsSync(m), false, "metadir removed after run");
});

// ── Drift extraction on TypeScript fixtures ───────────────────────────────────────

test("drift extraction skips TS return types, generic constraints, typed consts, a++ / b, and braces in strings/templates", () => {
  const src = read(TS_DRIFT);

  const expectedBody = (name, mustInclude, mustExclude = []) => {
    const bodies = extractDefinitions(src, name);
    assert.equal(bodies.length, 1, `${name} should extract exactly one body`);
    assert.ok(bodies[0].startsWith("{") && bodies[0].endsWith("}"), `${name} body must be brace-delimited`);
    for (const s of mustInclude) assert.ok(bodies[0].includes(s), `${name} body should include ${s}, got: ${bodies[0]}`);
    for (const s of mustExclude) assert.ok(!bodies[0].includes(s), `${name} body should not include ${s}, got: ${bodies[0]}`);
    return bodies[0];
  };

  expectedBody("objReturn", ["return { ok: x > 0, meta: { n: x } }"], ["meta: { n: number }"]);
  expectedBody("unionReturn", ['{ err: "bad" }'], ["Promise<"]);
  expectedBody("fnReturn", ["return (y) => ({ sum: x + y })"], ["sum: number"]);
  expectedBody("predReturn", ['"id" in x'], ["id: string"]);
  expectedBody("overloaded", ['typeof x === "string"'], ['kind: "s"; v: string']);
  expectedBody("genericFn", ["return { id: item.id }"], ["tags: Record", "extra?: U"]);
  expectedBody("genericArrow", ["return fn(x)"], ["F extends"]);
  expectedBody("typedArrow", ["return { ok: a <= b.limit }"], ["limit: number"]);
  expectedBody("typedFuncExpr", ["return { n: v.n + 1 }"], ["n: number"]);
  expectedBody("postfixDiv", ["return a++ / b + a-- / b"], ["afterDiv", "1 / 2"]);

  const litBody = expectedBody("bracesInLiterals", ['"}"', '"{"', "/}/"]);
  const norm = normalize(litBody);
  assert.ok(norm.includes('"}"'), "brace inside string kept");
  assert.ok(norm.includes("/}/"), "brace inside regex kept");
  assert.ok(!norm.includes("comment with }"), "comment inside template expression stripped");
});

test("expression-bodied arrows fail loudly instead of scanning into the next function", () => {
  assert.throws(() => extractDefinitions("export const f = () => 1;\n", "f"), /brace-delimited body/);
  assert.throws(
    () => extractDefinitions("export const f = (x: number): number => x + 1\nexport function g() { return 2; }\n", "f"),
    /brace-delimited body/,
  );
  assert.throws(() => extractDefinitions("export const f = () => (1 + 2);\n", "f"), /brace-delimited body/);
  assert.throws(() => extractDefinitions("export const f = () => ({ a: 1 }).a;\n", "f"), /brace-delimited body/);
  assert.throws(() => extractDefinitions('const m = { "f": () => 1 };\n', "f"), /brace-delimited body/);
});

test("extractDefinitions and normalize fail closed on ambiguous slash (tokenizeSafe), handle readonly return types, and skip type/interface spans", () => {
  // Repro 1: ambiguous `/` fails closed in both extractDefinitions and normalize
  const ambiguous = "export function f(a: number) { const x = a++ / 1; return /; }\n";
  assert.throws(() => extractDefinitions(ambiguous, "f"), /Ambiguous `\/`/);
  assert.throws(() => normalize("{ const x = a++ / 1; return /; }"), /Ambiguous `\/`/);

  // Repro 2: readonly in return type must not stop at the type's `{`
  const readonlySrc = "export function getItems(n: number): readonly { id: string; count: number }[] {\n  return [{ id: 'a', count: n }];\n}\n";
  const readonlyBodies = extractDefinitions(readonlySrc, "getItems");
  assert.equal(readonlyBodies.length, 1);
  assert.ok(readonlyBodies[0].includes("return [{ id: 'a', count: n }]"), `got: ${readonlyBodies[0]}`);
  assert.ok(!readonlyBodies[0].includes("id: string"));

  // Repro 3: quoted keys inside `type X = ...` and `interface X { ... }` are never read as bodies
  const typeAndInterfaceOnly = [
    'type Handlers = {',
    '  "tenant.purge": (env: unknown) => { done: boolean };',
    '};',
    'export type UnionHandlers<T extends { id: string }> =',
    '  | { "tenant.purge": (x: T) => { ok: true } }',
    '  | { other: number }',
    'export interface HandlerMap extends Record<string, unknown> {',
    '  "tenant.purge": (env: unknown) => { done: boolean };',
    '}',
  ].join("\n");
  assert.deepEqual(extractDefinitions(typeAndInterfaceOnly, "tenant.purge"), []);

  const withRealHandler = `${typeAndInterfaceOnly}\nconst handlers = {\n  "tenant.purge": async (env: unknown) => {\n    return { purged: true };\n  },\n};\n`;
  const extracted = extractDefinitions(withRealHandler, "tenant.purge");
  assert.equal(extracted.length, 1);
  assert.ok(extracted[0].includes("return { purged: true }"));
});

test("nested const, let or var with the covered name that is not a function is skipped instead of throwing", () => {
  const src = [
    "export function other() {",
    "  const target = computeTarget();",
    "  let target2 = 1;",
    "  if (target) {",
    "    var target = null;",
    "  }",
    "  return target;",
    "}",
    "export function target(x: number) {",
    "  return x + 1;",
    "}",
  ].join("\n");
  const bodies = extractDefinitions(src, "target");
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].includes("return x + 1"));

  const onlyNestedNonFn = "export function other() { const missing = 123; let missing2 = 'a'; var missing3 = {}; }\n";
  assert.deepEqual(extractDefinitions(onlyNestedNonFn, "missing"), []);
});

test("covered functions support quoted object keys, nested const arrows, and reject duplicates naming file and name", () => {
  // Quoted object keys (plain and wrapped in a call like idempotent(...))
  const quotedSrc = [
    "export function tenantJobHandlers() {",
    "  const handlers = {",
    '    "tenant.purge": idempotent(async (env, _job, payload) => {',
    "      return { done: true, result: payload };",
    "    }),",
    '    "other.job": async () => { return { done: true }; },',
    "  };",
    "  return handlers;",
    "}",
  ].join("\n");
  const purgeBodies = extractDefinitions(quotedSrc, "tenant.purge");
  assert.equal(purgeBodies.length, 1);
  assert.ok(purgeBodies[0].includes("return { done: true, result: payload }"));
  const otherBodies = extractDefinitions(quotedSrc, "other.job");
  assert.equal(otherBodies.length, 1);
  assert.ok(otherBodies[0].includes("return { done: true }"));

  // Const arrows declared inside another function (including parenthesized object-literal return)
  const nestedArrowsSrc = [
    "export function createTenantApp() {",
    "  const realmFor = (c: Ctx, tenant: TenantRow): AuthRealm => ({",
    "    scope: tenant.id,",
    "    admit: async () => { return true; },",
    "  });",
    "  const activeTenant = (c: Ctx): TenantRow => {",
    '    const host = c.get("host");',
    "    return host.tenant;",
    "  };",
    "  const authenticate = async (c: Ctx, next: () => Promise<void>) => {",
    "    const row = activeTenant(c);",
    "    await next();",
    "  };",
    "  return { realmFor, activeTenant, authenticate };",
    "}",
  ].join("\n");
  assert.equal(extractDefinitions(nestedArrowsSrc, "realmFor").length, 1);
  assert.ok(extractDefinitions(nestedArrowsSrc, "realmFor")[0].includes("scope: tenant.id"));
  assert.equal(extractDefinitions(nestedArrowsSrc, "activeTenant").length, 1);
  assert.ok(extractDefinitions(nestedArrowsSrc, "activeTenant")[0].includes('c.get("host")'));
  assert.equal(extractDefinitions(nestedArrowsSrc, "authenticate").length, 1);
  assert.ok(extractDefinitions(nestedArrowsSrc, "authenticate")[0].includes("await next()"));

  // Combined file with quoted handler + top-level function + nested const arrows hashes cleanly
  const combined = `${quotedSrc}\nexport async function tenantTick() { return 1; }\n${nestedArrowsSrc}\n`;
  const combinedHash = hashEntry(
    { file: "src/tenant-app.ts", functions: ["tenant.purge", "tenantTick", "realmFor", "activeTenant", "authenticate"] },
    () => combined,
    "/",
  );
  assert.equal(combinedHash.found, true);
  assert.match(combinedHash.sha256, /^[0-9a-f]{64}$/);

  // Duplicate names (quoted object key and nested const arrow) error naming file and name
  const dupQuoted = 'const a = { "tenant.purge": () => { return 1; } };\nconst b = { "tenant.purge": idempotent(async () => { return 2; }) };\n';
  assert.throws(
    () => hashEntry({ file: "src/tenant-app.ts", functions: ["tenant.purge"] }, () => dupQuoted, "/"),
    /src\/tenant-app\.ts: "tenant\.purge" is defined 2 times/,
  );

  const dupNested = "function a() { const activeTenant = () => { return 1; }; }\nfunction b() { const activeTenant = () => { return 2; }; }\n";
  assert.throws(
    () => hashEntry({ file: "src/tenant-app.ts", functions: ["activeTenant"] }, () => dupNested, "/"),
    /src\/tenant-app\.ts: "activeTenant" is defined 2 times/,
  );
});

test("comment-only edits (including inside template expressions) do not change the hash; body and template text edits do", (t) => {
  const dir = makeTempDir(t, "rose-hash-");
  const entry = { file: "m.ts", functions: ["f"] };
  writeFileSync(join(dir, "m.ts"), "export function f(x: number): string {\n  return `a${x}b`; // count\n}\n");
  const before = hashEntry(entry, readFileSync, dir).sha256;

  writeFileSync(join(dir, "m.ts"), "export function f(x: number): string {\n  // a longer comment\n  return `a${/* inner comment */ x}b`;\n}\n");
  assert.equal(hashEntry(entry, readFileSync, dir).sha256, before);

  // Moving template text across interpolation must change the hash
  writeFileSync(join(dir, "m.ts"), "export function f(x: number): string {\n  return `ab${x}`;\n}\n");
  assert.notEqual(hashEntry(entry, readFileSync, dir).sha256, before);
});

test("a covered function that no longer exists is stale; a name defined twice is an error", (t) => {
  const dir = makeTempDir(t, "rose-hash-");
  writeFileSync(join(dir, "m.ts"), "export function g() { return 1; }\n");
  assert.equal(hashEntry({ file: "m.ts", functions: ["f"] }, readFileSync, dir).found, false);

  const dup = "export function f() { return 1; }\nconst f = () => { return 2; };\n";
  assert.throws(() => hashEntry({ file: "x.ts", functions: ["f"] }, () => dup, "/"), /defined 2 times/);
});

// ── End-to-end flow checks, drift, resync, CLI errors ─────────────────────────────

test("a good flow and its killed mutant pass end to end", async () => {
  const { r, logLines } = await runHarness(["--flows", FIXTURES], { behavior: toyBehavior });
  assert.equal(r.code, 0, logLines.join("\n"));
  assert.equal(r.errors.length, 0);
  const mainCheck = r.checks.find((c) => c.check === "main");
  const mutantCheck = r.checks.find((c) => c.check === "mutant drop-guard");
  assert.equal(mainCheck.pass, true);
  assert.equal(mainCheck.states, 3);
  assert.equal(mutantCheck.pass, true);
  assert.equal(mutantCheck.states, 4);
});

test("a mutant that survives, violates the wrong invariant, or deadlocks fails the harness", async () => {
  const survived = await runHarness(["--flows", FIXTURES], { behavior: () => ({ status: 0, stdout: "Model checking completed. No error has been found." }) });
  assert.equal(survived.r.code, 1);
  assert.ok(survived.errLines.join("\n").includes("mutant survived"));

  const wrongInv = await runHarness(["--flows", FIXTURES], {
    behavior: ({ cfgText }) => (cfgText.includes('MUTANTS = {"drop-guard"}')
      ? { status: 12, stdout: "Error: Invariant WrongRule is violated." }
      : { status: 0, stdout: "ok" }),
  });
  assert.equal(wrongInv.r.code, 1);
  assert.ok(wrongInv.errLines.join("\n").includes("wrong invariant"));

  const deadlock = await runHarness(["--flows", FIXTURES], { behavior: () => ({ status: 11, stdout: "Deadlock reached.", stderr: "" }) });
  assert.equal(deadlock.r.code, 1);
  assert.ok(deadlock.errLines.join("\n").includes("deadlock"));
});

test("a covered file that changed fails with re-check hint, resync command, and docs pointer", async (t) => {
  const dir = tempToy(t);
  const manifest = JSON.parse(read(join(dir, "toy", "formal.json")));
  manifest.covered[0].sha256 = "0".repeat(64);
  writeFileSync(join(dir, "toy", "formal.json"), JSON.stringify(manifest, null, 2) + "\n");
  const { r, errLines } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 1);
  const text = errLines.join("\n");
  assert.ok(text.includes("covered code changed"));
  assert.ok(!text.includes("/maintain-formal-verification-skill"));
  assert.ok(text.includes("re-check the model against the changed code (docs/internals/formal-harness.md), then pnpm formal --resync toy"));
});

test("--resync updates only covered hashes after a green run and refuses when a mutant survives", async (t) => {
  const dir = tempToy(t);
  const manifestPath = join(dir, "toy", "formal.json");
  const before = JSON.parse(read(manifestPath));
  before.covered[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(before, null, 2) + "\n");

  const failed = await runHarness(["--flows", dir, "--resync", "toy"], { behavior: () => ({ status: 0, stdout: "ok" }) });
  assert.equal(failed.r.code, 1);
  assert.equal(JSON.parse(read(manifestPath)).covered[0].sha256, "0".repeat(64));

  const passed = await runHarness(["--flows", dir, "--resync", "toy"], { behavior: toyBehavior });
  assert.equal(passed.r.code, 0);
  const after = JSON.parse(read(manifestPath));
  assert.equal(after.covered[0].sha256, TOY_HASH);
  delete before.covered[0].sha256;
  delete after.covered[0].sha256;
  assert.deepEqual(after, before);
});

test("CLI rejects bare --flows and --resync and prints each flow error exactly once", async (t) => {
  const bareFlows = await runHarness(["--flows"]);
  assert.equal(bareFlows.r.code, 1);
  assert.match(bareFlows.errLines.join("\n"), /--flows requires/);

  const emptyFlows = await runHarness(["--flows="]);
  assert.equal(emptyFlows.r.code, 1);
  assert.match(emptyFlows.errLines.join("\n"), /--flows requires/);

  const bareResync = await runHarness(["--flows", FIXTURES, "--resync"]);
  assert.equal(bareResync.r.code, 1);
  assert.match(bareResync.errLines.join("\n"), /--resync requires/);

  const unknownFlag = await runHarness(["--bogus"]);
  assert.equal(unknownFlag.r.code, 1);
  assert.match(unknownFlag.errLines.join("\n"), /unknown flag: --bogus/);

  const unknownFlagVal = await runHarness(["--flows", FIXTURES, "--extra=1"]);
  assert.equal(unknownFlagVal.r.code, 1);
  assert.match(unknownFlagVal.errLines.join("\n"), /unknown flag: --extra/);

  const positional = await runHarness(["toy"]);
  assert.equal(positional.r.code, 1);
  assert.match(positional.errLines.join("\n"), /unexpected positional argument: toy/);

  const shortFlag = await runHarness(["-f"]);
  assert.equal(shortFlag.r.code, 1);
  assert.match(shortFlag.errLines.join("\n"), /unexpected positional argument: -f/);

  const extraPositional = await runHarness(["--flows", FIXTURES, "extra"]);
  assert.equal(extraPositional.r.code, 1);
  assert.match(extraPositional.errLines.join("\n"), /unexpected positional argument: extra/);

  const missingFlows = await runHarness(["--flows", join(makeTempDir(t), "does-not-exist")]);
  assert.equal(missingFlows.r.code, 1);
  assert.match(missingFlows.errLines.join("\n"), /flows directory does not exist/);

  // A flow throwing during validation must print the error once, not twice
  const dir = tempToy(t);
  const bad = JSON.parse(read(join(dir, "toy", "formal.json")));
  bad.extraKey = true;
  writeFileSync(join(dir, "toy", "formal.json"), JSON.stringify(bad, null, 2) + "\n");
  const { r, errLines } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 1);
  const matches = errLines.filter((l) => l.includes('unknown manifest key "extraKey"'));
  assert.equal(matches.length, 1, `expected error printed once, got ${matches.length}: ${errLines.join(" | ")}`);
});

// ── Toolchain: findJava, mise timeout, download timeout + size cap, ensureJar ─────

test("findJava checks $JAVA then $JAVA_HOME before spawning mise, and gives mise a timeout", () => {
  let miseCalls = 0;
  let miseOpts = null;
  const spyMise = (cmd, args, opts) => {
    miseCalls++;
    miseOpts = opts;
    assert.equal(cmd, "mise");
    assert.deepEqual(args, ["where", "java@temurin-25"]);
    return { status: 0, stdout: "/mise/java\n" };
  };

  assert.equal(findJava({ env: { JAVA: "/a/java", JAVA_HOME: "/jh", PATH: "/p" }, existsSync: (p) => p === "/a/java", spawnSync: spyMise }), "/a/java");
  assert.equal(miseCalls, 0, "must not run mise when $JAVA exists");

  assert.equal(findJava({ env: { JAVA_HOME: "/jh", PATH: "/p" }, existsSync: (p) => p === "/jh/bin/java", spawnSync: spyMise }), "/jh/bin/java");
  assert.equal(miseCalls, 0, "must not run mise when $JAVA_HOME/bin/java exists");

  assert.equal(findJava({ env: {}, existsSync: (p) => p === "/mise/java/bin/java", spawnSync: spyMise }), "/mise/java/bin/java");
  assert.equal(miseCalls, 1);
  assert.equal(miseOpts.timeout, MISE_TIMEOUT_MS);

  const noMise = () => ({ status: 1, stdout: "" });
  assert.equal(findJava({ env: { PATH: "/p" }, existsSync: (p) => p === "/p/java", spawnSync: noMise }), "/p/java");
  assert.equal(findJava({ env: {}, existsSync: () => false, spawnSync: noMise }), null);
});

test("downloadJar passes AbortSignal.timeout to fetch and enforces the size cap", async () => {
  let receivedSignal = null;
  const okFetch = async (_url, init) => {
    receivedSignal = init?.signal;
    return new Response("hello", { status: 200, headers: { "content-length": "5" } });
  };
  const buf = await downloadJar("https://example.invalid/jar", { fetchImpl: okFetch, timeoutMs: 5000, maxBytes: 10 });
  assert.equal(buf.toString("utf8"), "hello");
  assert.ok(receivedSignal instanceof AbortSignal, "fetch must receive an AbortSignal");

  // Rejects oversized Content-Length before buffering
  await assert.rejects(
    downloadJar("https://example.invalid/big", {
      fetchImpl: async () => new Response("x".repeat(20), { status: 200, headers: { "content-length": "20" } }),
      maxBytes: 10,
    }),
    /exceeds 10 bytes/,
  );

  // Rejects oversized streamed body even without Content-Length
  await assert.rejects(
    downloadJar("https://example.invalid/stream", {
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }), { status: 200 }),
      maxBytes: 10,
    }),
    /exceeded 10 bytes/,
  );
});

test("ensureJar refuses a bad sha256 and caches a matching jar", async (t) => {
  await assert.rejects(
    ensureJar({ cacheDir: makeTempDir(t, "rose-jar-"), url: "https://example.invalid/tla2tools.jar", sha: sha256("good"), download: async () => Buffer.from("bad") }),
    /does not match/,
  );

  const dir = makeTempDir(t, "rose-jar-");
  const content = Buffer.from("jar-bytes");
  const sha = sha256(content);
  let downloads = 0;
  const download = async () => {
    downloads++;
    return content;
  };
  const jar = await ensureJar({ cacheDir: dir, sha, download });
  assert.equal(readFileSync(jar, "utf8"), "jar-bytes");
  assert.equal(await ensureJar({ cacheDir: dir, sha, download }), jar);
  assert.equal(downloads, 1);
});

test("no Java produces a clear error", async () => {
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { findJava: () => null });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("no Java found"));
});

test("validateManifest rejects unknown keys, missing mutants, and mutant ids absent from spec", () => {
  const manifest = toyManifest();
  const withUnknown = JSON.parse(JSON.stringify(manifest));
  withUnknown.extra = true;
  assert.throws(() => validateManifest(withUnknown, { dirName: "toy" }), /unknown manifest key/);

  const noMutant = JSON.parse(JSON.stringify(manifest));
  noMutant.rules.push({ id: "LoneRule", kind: "safety", sentence: "s", harm: "h" });
  assert.throws(() => validateManifest(noMutant, { dirName: "toy" }), /LoneRule has no mutant/);

  const typoMutant = JSON.parse(JSON.stringify(manifest));
  typoMutant.mutants = [{ id: "drop-gard", breaks: "CounterLeqBound", code: "x#f" }];
  assert.throws(() => validateManifest(typoMutant, { specText: read(join(TOY, "Toy.tla")), dirName: "toy" }), /drop-gard/);

  // covered[].functions entries must each be a non-empty string
  for (const badFn of ["", "   ", 123, null]) {
    const badFns = JSON.parse(JSON.stringify(manifest));
    badFns.covered[0].functions = [badFn];
    assert.throws(() => validateManifest(badFns, { dirName: "toy" }), /"functions" must be a non-empty string/);
  }
});

test("discoverFlows refuses non-object manifests with an error prefixed by the flow name", (t) => {
  for (const raw of ["null", "[]", '"hello"', "42", "true"]) {
    const dir = makeTempDir(t);
    const flowDir = join(dir, "bad-flow");
    cpSync(TOY, flowDir, { recursive: true });
    writeFileSync(join(flowDir, "formal.json"), raw);
    assert.throws(() => discoverFlows(dir), /^Error: bad-flow: formal\.json must be an object$/);
  }
});

test("validateManifest supports optional assumptions, optional notModelled, and optional mutant change while rejecting unknown keys", () => {
  const base = toyManifest();

  // Optional notModelled may be omitted, or an array of strings (including empty)
  const noNotModelled = JSON.parse(JSON.stringify(base));
  delete noNotModelled.notModelled;
  assert.doesNotThrow(() => validateManifest(noNotModelled, { dirName: "toy" }));
  assert.doesNotThrow(() => validateManifest({ ...base, notModelled: [] }, { dirName: "toy" }));
  assert.throws(() => validateManifest({ ...base, notModelled: "nope" }, { dirName: "toy" }), /"notModelled" must be an array of strings/);
  assert.throws(() => validateManifest({ ...base, notModelled: [123] }, { dirName: "toy" }), /"notModelled" must be an array of strings/);

  // Optional assumptions must be an array of non-empty strings
  assert.doesNotThrow(() => validateManifest({ ...base, assumptions: ["One tick >= cache TTL"] }, { dirName: "toy" }));
  assert.throws(() => validateManifest({ ...base, assumptions: "not-array" }, { dirName: "toy" }), /"assumptions" must be an array of non-empty strings/);
  assert.throws(() => validateManifest({ ...base, assumptions: [""] }, { dirName: "toy" }), /"assumptions" must be an array of non-empty strings/);
  assert.throws(() => validateManifest({ ...base, assumptions: ["   "] }, { dirName: "toy" }), /"assumptions" must be an array of non-empty strings/);
  assert.throws(() => validateManifest({ ...base, assumptions: [42] }, { dirName: "toy" }), /"assumptions" must be an array of non-empty strings/);

  // Optional mutant change must be a non-empty string
  const withChange = JSON.parse(JSON.stringify(base));
  withChange.mutants[0].change = "drop guard condition";
  assert.doesNotThrow(() => validateManifest(withChange, { dirName: "toy" }));
  for (const badChange of ["", "   ", 123, null]) {
    const m = JSON.parse(JSON.stringify(base));
    m.mutants[0].change = badChange;
    assert.throws(() => validateManifest(m, { dirName: "toy" }), /"change" must be a non-empty string/);
  }

  // Unknown keys are still rejected on manifest and mutant
  const badMutantKey = JSON.parse(JSON.stringify(base));
  badMutantKey.mutants[0].extra = "x";
  assert.throws(() => validateManifest(badMutantKey, { dirName: "toy" }), /unknown mutant key "extra"/);
});

test("distinctStates parses TLC state counts", () => {
  assert.equal(distinctStates("4 states generated, 3 distinct states found, 0 states left on queue."), 3);
  assert.equal(distinctStates("no states"), null);
});

// ── Real TLC integration test ─────────────────────────────────────────────────────

test("real TLC on the toy fixture leaves git status clean (skipped only when Java is missing)", async (t) => {
  if (!findJava()) {
    console.warn("SKIPPED: no Java found; skipping real-TLC fixture test");
    t.skip("SKIPPED: no Java found; skipping real-TLC fixture test");
    return;
  }
  const statusBefore = gitStatus();
  const r = await main(["--flows", FIXTURES], { log: () => {}, err: () => {} });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.equal(gitStatus(), statusBefore, "real TLC run must leave git status --porcelain unchanged");
  assert.ok(!gitStatus(["--", "scripts/fixtures/formal/toy"]).includes("??"), "tracked fixture dir must have no untracked files");
});

test("real TLC on a multi-config flow with VIEW and liveness (skipped only when Java is missing)", async (t) => {
  if (!findJava()) {
    console.warn("SKIPPED: no Java found; skipping real-TLC multi-config test");
    t.skip("SKIPPED: no Java found; skipping real-TLC multi-config test");
    return;
  }
  const dir = makeTempDir(t);
  const flowDir = join(dir, "multi");
  cpSync(TOY, flowDir, { recursive: true });
  const spec = [
    "---- MODULE Multi ----",
    "EXTENDS Integers",
    "CONSTANT MUTANTS",
    "VARIABLE counter",
    "Init == counter = 0",
    'DropSafety == "drop-safety" \\in MUTANTS',
    'DropLive == "drop-live" \\in MUTANTS',
    "Inc == counter < 3 /\\ (counter < 2 \\/ DropSafety) /\\ ~DropLive /\\ counter' = counter + 1",
    "Stutter == (counter = 2 \\/ DropLive) /\\ UNCHANGED counter",
    "Next == Inc \\/ Stutter",
    "CounterLeqBound == counter <= 2",
    "EventuallyTwo == <>(counter = 2)",
    "ViewCounter == counter",
    "Spec == Init /\\ [][Next]_counter /\\ WF_counter(Inc)",
    "====",
    "",
  ].join("\n");
  writeFileSync(join(flowDir, "Multi.tla"), spec);
  writeFileSync(join(flowDir, "Safety.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nVIEW ViewCounter\nINVARIANT CounterLeqBound\n");
  writeFileSync(join(flowDir, "Liveness.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nPROPERTY EventuallyTwo\n");
  const manifest = {
    flow: "multi",
    spec: "Multi.tla",
    configs: [
      { file: "Safety.cfg", rules: ["CounterLeqBound"] },
      { file: "Liveness.cfg", rules: ["EventuallyTwo"] },
    ],
    rules: [
      { id: "CounterLeqBound", kind: "safety", sentence: "counter <= 2", harm: "overflow" },
      { id: "EventuallyTwo", kind: "liveness", sentence: "counter reaches 2", harm: "stalls" },
    ],
    mutants: [
      { id: "drop-safety", breaks: "CounterLeqBound" },
      { id: "drop-live", breaks: "EventuallyTwo" },
    ],
    covered: toyManifest().covered,
    bounds: "bound 2",
    notModelled: [],
    timeoutSeconds: 60,
  };
  writeFileSync(join(flowDir, "formal.json"), JSON.stringify(manifest, null, 2) + "\n");

  const statusBefore = gitStatus();
  const r = await main(["--flows", dir], { log: () => {}, err: () => {} });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.equal(r.checks.length, 4);
  assert.equal(gitStatus(), statusBefore, "real TLC multi-config run must leave git status --porcelain unchanged");
});
