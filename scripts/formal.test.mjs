// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_MS, TLC_EXIT_TABLE, TLA_TOOLS_SHA256, cfgFlags, describeOutcome, distinctStates, ensureJar, extractDefinitions, findJava, generateMutantCfg, hashEntry, main, normalize, parseCfg, runOutcome, sha256, validateManifest } from "./formal.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures", "formal");
const TOY = join(FIXTURES, "toy");
const TOY_HASH = "fa1d08fbaf0641ccc345320e9aa4a16f2ba06f3dd0903df094260e1237b1ee13";

const read = (p) => readFileSync(p, "utf8");

const toyManifest = () => JSON.parse(read(join(TOY, "formal.json")));

function tempToy() {
  const parent = mkdtempSync(join(tmpdir(), "rose-formal-test-"));
  cpSync(TOY, join(parent, "toy"), { recursive: true });
  return parent;
}

function fakeJava(behavior) {
  const calls = [];
  const impl = (cmd, args) => {
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
    const result = behavior({ cmd, args: [...args], cfgPath, cfgText });
    calls.push({ cmd, args: [...args], cfgPath, cfgText });
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

test("exit-code table names every TLC code", () => {
  const byCode = new Map(TLC_EXIT_TABLE);
  assert.equal(byCode.get(0), "pass");
  assert.equal(byCode.get(10), "ASSUME evaluated to FALSE");
  assert.equal(byCode.get(11), "deadlock (no enabled next step)");
  assert.equal(byCode.get(12), "safety invariant violated");
  assert.equal(byCode.get(13), "temporal property violated");
  assert.equal(byCode.get(150), "parse or semantic error");
  assert.equal(byCode.get(151), "constant missing from cfg");
  assert.equal(byCode.get(255), "out of memory");
  assert.equal(byCode.get(1), "bad option");
  assert.equal(byCode.get(142), "timed out");
});

test("runOutcome classifies every exit code, and a zero-exit violation is never a pass", () => {
  const base = { signal: null, error: null, stderr: "", timedOut: false };
  assert.equal(runOutcome({ ...base, status: 0, stdout: "Model checking completed. No error has been found." }).kind, "pass");
  assert.equal(runOutcome({ ...base, status: 0, stdout: "544 lines: Invariant X is violated." }).kind, "violation-exit-zero");
  assert.equal(runOutcome({ ...base, status: 12, stdout: "Error: Invariant NoEarlyPurge is violated." }).kind, "safety-violation");
  assert.equal(runOutcome({ ...base, status: 12, stdout: "Error: Invariant NoEarlyPurge is violated." }).invariant, "NoEarlyPurge");
  assert.equal(runOutcome({ ...base, status: 13, stdout: "Error: Temporal properties were violated." }).kind, "liveness-violation");
  assert.equal(runOutcome({ ...base, status: 10, stdout: "" }).kind, "assume-false");
  assert.equal(runOutcome({ ...base, status: 11, stdout: "" }).kind, "deadlock");
  assert.equal(runOutcome({ ...base, status: 150, stdout: "" }).kind, "parse-semantic");
  assert.equal(runOutcome({ ...base, status: 151, stdout: "" }).kind, "constant-missing");
  assert.equal(runOutcome({ ...base, status: 255, stdout: "" }).kind, "oom");
  assert.equal(runOutcome({ ...base, status: 1, stdout: "" }).kind, "bad-option");
  assert.equal(runOutcome({ ...base, status: 142, stdout: "" }).kind, "timeout");
  assert.equal(runOutcome({ ...base, status: 12, signal: "SIGTERM", timedOut: true, stdout: "" }).kind, "timeout");
});

test("mutant cfg keeps constants, drops every rule, and sets one rule plus MUTANTS", () => {
  const mainCfg = "SPECIFICATION Spec\nCONSTANT\n  N = 3\n  MUTANTS = {}\nINVARIANT TypeOK\nPROPERTY Term\n";
  const safety = generateMutantCfg(mainCfg, "m1", { id: "TypeOK", kind: "safety" });
  assert.match(safety, /SPECIFICATION Spec/);
  assert.match(safety, /N = 3/);
  assert.doesNotMatch(safety, /MUTANTS = \{\}/);
  assert.match(safety, /MUTANTS = \{"m1"\}/);
  assert.match(safety, /INVARIANT TypeOK/);
  assert.doesNotMatch(safety, /PROPERTY/);
  assert.doesNotMatch(safety, /INVARIANTS/);

  const liveness = generateMutantCfg(mainCfg, "m2", { id: "Term", kind: "liveness" });
  assert.match(liveness, /PROPERTY Term/);
  assert.doesNotMatch(liveness, /INVARIANT/);
});

test("a cfg with SYMMETRY and a PROPERTY is refused", async () => {
  const dir = tempToy();
  writeFileSync(join(dir, "toy", "Toy.cfg"), "SPECIFICATION Spec\nCONSTANT\n  MUTANTS = {}\nSYMMETRY Symm\nINVARIANT CounterLeqBound\nPROPERTY Term\n");
  const { r, errLines } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("SYMMETRY"));
});

test("TLC argv never contains -continue", async () => {
  const { fake } = await runHarness(["--flows", FIXTURES], { behavior: toyBehavior });
  assert.ok(fake.calls.length >= 2);
  for (const call of fake.calls) assert.ok(!call.args.includes("-continue"), "argv must never pass -continue");
  assert.ok(!read(new URL("./formal.mjs", import.meta.url)).includes("-continue"));
});

test("a mutant id missing from the model is refused", () => {
  const manifest = toyManifest();
  manifest.mutants = [{ id: "drop-gard", breaks: "CounterLeqBound", code: "x#f" }];
  assert.throws(() => validateManifest(manifest, { specText: read(join(TOY, "Toy.tla")), dirName: "toy" }), /drop-gard/);
});

test("a main run that deadlocks is a model error, not a pass", async () => {
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { behavior: () => ({ status: 11, stdout: "Deadlock reached.", stderr: "" }) });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("deadlock"));
});

test("each TLC run gets a fresh metadir that is removed afterwards", async () => {
  const metadirs = [];
  const impl = (cmd, args) => {
    const i = args.indexOf("-metadir");
    metadirs.push(args[i + 1]);
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

test("comment-only edits do not change the hash; body edits do", () => {
  const dir = mkdtempSync(join(tmpdir(), "rose-hash-"));
  const entry = { file: "m.mjs", functions: ["f"] };
  writeFileSync(join(dir, "m.mjs"), "export function f() {\n  return 1; // count\n}\n");
  const before = hashEntry(entry, readFileSync, dir).sha256;
  writeFileSync(join(dir, "m.mjs"), "export function f() {\n  // a longer comment\n  return 1;\n}\n");
  assert.equal(hashEntry(entry, readFileSync, dir).sha256, before);
  writeFileSync(join(dir, "m.mjs"), "export function f() {\n  return 2;\n}\n");
  assert.notEqual(hashEntry(entry, readFileSync, dir).sha256, before);
  rmSync(dir, { recursive: true, force: true });
});

test("a covered function that no longer exists is stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "rose-hash-"));
  writeFileSync(join(dir, "m.mjs"), "export function g() { return 1; }\n");
  assert.equal(hashEntry({ file: "m.mjs", functions: ["f"] }, readFileSync, dir).found, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a covered name defined twice is an error", () => {
  const src = "export function f() { return 1; }\nconst f = () => { return 2; };\n";
  assert.throws(() => hashEntry({ file: "x.mjs", functions: ["f"] }, () => src, "/"), /defined 2 times/);
});

test("braces inside strings, templates and regexes do not end the body", () => {
  const src = 'export function f(x) { return "}" + `${x ? "{" : "}"}` + /}/.source; }';
  const bodies = extractDefinitions(src, "f");
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].startsWith("{") && bodies[0].endsWith("}"));
  const n = normalize(bodies[0]);
  assert.ok(n.includes('"}"'), "a brace inside a string is kept");
  assert.ok(n.includes('${x ? "{" : "}"}'), "a template with braces is kept");
  assert.ok(n.includes("/}/"), "a brace inside a regex is kept");
});

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

test("a mutant that does not fail makes the harness fail", async () => {
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { behavior: () => ({ status: 0, stdout: "Model checking completed. No error has been found." }) });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("mutant survived"));
});

test("a mutant violating the wrong invariant makes the harness fail", async () => {
  const behavior = ({ cfgText }) => (cfgText.includes('MUTANTS = {"drop-guard"}')
    ? { status: 12, stdout: "Error: Invariant WrongRule is violated." }
    : { status: 0, stdout: "ok" });
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { behavior });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("wrong invariant"));
});

test("a jar whose sha256 does not match is refused", async () => {
  await assert.rejects(
    ensureJar({ cacheDir: mkdtempSync(join(tmpdir(), "rose-jar-")), url: "https://example.invalid/tla2tools.jar", sha: sha256("good"), download: async () => Buffer.from("bad") }),
    /does not match/,
  );
});

test("a matching jar is downloaded once and reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rose-jar-"));
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
  rmSync(dir, { recursive: true, force: true });
});

test("a covered file that changed fails with the drift message", async () => {
  const dir = tempToy();
  const manifest = JSON.parse(read(join(dir, "toy", "formal.json")));
  manifest.covered[0].sha256 = "0".repeat(64);
  writeFileSync(join(dir, "toy", "formal.json"), JSON.stringify(manifest, null, 2) + "\n");
  const { r, errLines } = await runHarness(["--flows", dir], { behavior: toyBehavior });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("covered code changed"));
  assert.ok(errLines.join("\n").includes("--resync toy"));
});

test("--resync after a green run updates only the covered hashes", async () => {
  const dir = tempToy();
  const manifestPath = join(dir, "toy", "formal.json");
  const before = JSON.parse(read(manifestPath));
  before.covered[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(before, null, 2) + "\n");
  const { r } = await runHarness(["--flows", dir, "--resync", "toy"], { behavior: toyBehavior });
  assert.equal(r.code, 0);
  const after = JSON.parse(read(manifestPath));
  assert.equal(after.covered[0].sha256, TOY_HASH);
  delete before.covered[0].sha256;
  delete after.covered[0].sha256;
  assert.deepEqual(after, before);
});

test("--resync does not rewrite hashes when a mutant survives", async () => {
  const dir = tempToy();
  const manifestPath = join(dir, "toy", "formal.json");
  const before = JSON.parse(read(manifestPath));
  before.covered[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(before, null, 2) + "\n");
  const { r } = await runHarness(["--flows", dir, "--resync", "toy"], { behavior: () => ({ status: 0, stdout: "ok" }) });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(read(manifestPath)).covered[0].sha256, "0".repeat(64));
});

test("no Java produces a clear error", async () => {
  const { r, errLines } = await runHarness(["--flows", FIXTURES], { findJava: () => null });
  assert.equal(r.code, 1);
  assert.ok(errLines.join("\n").includes("no Java found"));
});

test("findJava honours $JAVA, $JAVA_HOME, mise and PATH in order", () => {
  const noMise = () => ({ status: 1, stdout: "" });
  assert.equal(findJava({ env: { JAVA: "/a/java", JAVA_HOME: "/jh", PATH: "/p" }, existsSync: (p) => p === "/a/java", spawnSync: noMise }), "/a/java");
  assert.equal(findJava({ env: { JAVA_HOME: "/jh", PATH: "" }, existsSync: (p) => p === "/jh/bin/java", spawnSync: noMise }), "/jh/bin/java");
  assert.equal(findJava({ env: {}, existsSync: (p) => p === "/mise/java/bin/java", spawnSync: () => ({ status: 0, stdout: "/mise/java\n" }) }), "/mise/java/bin/java");
  assert.equal(findJava({ env: { PATH: "/p" }, existsSync: (p) => p === "/p/java", spawnSync: noMise }), "/p/java");
  assert.equal(findJava({ env: {}, existsSync: () => false, spawnSync: noMise }), null);
});

test("distinctStates reads TLC's state count and describeOutcome names each code", () => {
  assert.equal(distinctStates("4 states generated, 3 distinct states found, 0 states left on queue."), 3);
  assert.equal(distinctStates("no states"), null);
  assert.equal(describeOutcome({ kind: "safety-violation", invariant: "X" }), "invariant X violated (exit 12)");
  assert.equal(describeOutcome({ kind: "deadlock" }), "deadlock, no enabled next step (exit 11)");
});

test("parseCfg and cfgFlags see SYMMETRY and PROPERTY", () => {
  const sections = parseCfg("SPECIFICATION Spec\nSYMMETRY Symm\nPROPERTY Term\n");
  assert.deepEqual(cfgFlags(sections), { hasSymmetry: true, hasProperty: true });
  assert.deepEqual(cfgFlags(parseCfg("SPECIFICATION Spec\nSYMMETRY Symm\nINVARIANT TypeOK\n")), { hasSymmetry: true, hasProperty: false });
});

test("validateManifest rejects unknown keys and a rule with no mutant", () => {
  const manifest = toyManifest();
  const withUnknown = JSON.parse(JSON.stringify(manifest));
  withUnknown.extra = true;
  assert.throws(() => validateManifest(withUnknown, { dirName: "toy" }), /unknown manifest key/);

  const noMutant = JSON.parse(JSON.stringify(manifest));
  noMutant.rules.push({ id: "LoneRule", kind: "safety", sentence: "s", harm: "h" });
  assert.throws(() => validateManifest(noMutant, { dirName: "toy" }), /LoneRule has no mutant/);
});

test("the toy manifest declares the pinned tool, version and sha", () => {
  assert.match(read(new URL("./formal.mjs", import.meta.url)), /TLA_TOOLS_SHA256/);
  assert.equal(TLA_TOOLS_SHA256, "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88");
  assert.ok(DEFAULT_TIMEOUT_MS === 120_000);
});

test("package.json wires pnpm formal but not pnpm verify", () => {
  const pkg = JSON.parse(read(join(import.meta.dirname, "..", "package.json")));
  assert.equal(pkg.scripts.formal, "node scripts/formal.mjs");
  assert.ok(!pkg.scripts.verify.includes("formal"), "verify must not run formal (T2 wires it)");
});

test("real TLC on the toy fixture (skipped only when Java is missing)", async (t) => {
  if (!findJava()) {
    t.skip("no Java found; skipped the real-TLC fixture run");
    return;
  }
  const r = await main(["--flows", FIXTURES], { log: () => {}, err: () => {} });
  assert.equal(r.code, 0, r.errors.join("\n"));
});
