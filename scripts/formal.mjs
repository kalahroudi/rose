// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, parseArgs } from "./lib.mjs";

export const TLA_TOOLS_VERSION = "1.7.4";
export const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar`;
export const TLA_TOOLS_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MUTANTS = "MUTANTS";

export const TLC_EXIT_TABLE = [
  [0, "pass"],
  [10, "ASSUME evaluated to FALSE"],
  [11, "deadlock (no enabled next step)"],
  [12, "safety invariant violated"],
  [13, "temporal property violated"],
  [150, "parse or semantic error"],
  [151, "constant missing from cfg"],
  [255, "out of memory"],
  [1, "bad option"],
  [142, "timed out"],
];

const RULE_KEYWORDS = new Set(["INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES"]);
const CONST_KEYWORDS = new Set(["CONSTANT", "CONSTANTS"]);

const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_KEYWORDS = new Set(["return", "case", "throw", "typeof", "instanceof", "in", "of", "new", "delete", "void", "yield", "await", "do", "else"]);

export const defaultCacheDir = () => process.env.ROSE_FORMAL_CACHE ?? join(homedir(), ".cache", "rose-formal");

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function findJava({ env = process.env, existsSync: exists = existsSync, spawnSync: spawnImpl = spawnSync } = {}) {
  const candidates = [];
  if (env.JAVA) candidates.push(env.JAVA);
  if (env.JAVA_HOME) candidates.push(join(env.JAVA_HOME, "bin", "java"));
  const mise = spawnImpl("mise", ["where", "java@temurin-25"], { encoding: "utf8", env });
  if (mise.status === 0 && mise.stdout) {
    const line = mise.stdout.trim().split("\n")[0];
    if (line) candidates.push(join(line, "bin", "java"));
  }
  if (env.PATH) for (const dir of env.PATH.split(delimiter)) if (dir) candidates.push(join(dir, "java"));
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

async function defaultDownload(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureJar({ cacheDir = defaultCacheDir(), url = TLA_TOOLS_URL, sha = TLA_TOOLS_SHA256, download = defaultDownload } = {}) {
  const jar = join(cacheDir, "tla2tools.jar");
  if (existsSync(jar)) {
    const actual = sha256(readFileSync(jar));
    if (actual === sha) return jar;
    throw new Error(`tla2tools.jar at ${jar} does not match sha256 ${sha} (got ${actual}). Remove it and re-run to re-download.`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `tla2tools.jar.${process.pid}.tmp`);
  const buf = await download(url);
  const actual = sha256(buf);
  if (actual !== sha) throw new Error(`refusing tla2tools.jar from ${url}: sha256 ${actual} does not match expected ${sha}`);
  writeFileSync(tmp, buf);
  renameSync(tmp, jar);
  return jar;
}

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

function skipString(src, i, quote) {
  let k = i + 1;
  while (k < src.length) {
    if (src[k] === "\\") k += 2;
    else if (src[k] === quote) return k + 1;
    else k++;
  }
  return src.length;
}

function skipLineComment(src, i) {
  let k = i + 2;
  while (k < src.length && src[k] !== "\n") k++;
  return k;
}

function skipBlockComment(src, i) {
  const end = src.indexOf("*/", i + 2);
  return end < 0 ? src.length : end + 2;
}

function skipRegex(src, i) {
  let k = i + 1;
  let inClass = false;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") k += 2;
    else if (c === "[") { inClass = true; k++; }
    else if (c === "]") { inClass = false; k++; }
    else if (c === "/" && !inClass) return k + 1;
    else if (c === "\n") return k;
    else k++;
  }
  return src.length;
}

function skipBraced(src, openIndex) {
  let depth = 1;
  let i = openIndex + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === "`") { i = skipTemplate(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") { i = skipLineComment(src, i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = skipBlockComment(src, i); continue; }
    if (c === "/") {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      const p = k >= 0 ? src[k] : "";
      if (p === "" || REGEX_AFTER.has(p)) { i = skipRegex(src, i); continue; }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return src.length;
}

function skipTemplate(src, i) {
  let k = i + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") k += 2;
    else if (c === "`") return k + 1;
    else if (c === "$" && src[k + 1] === "{") k = skipBraced(src, k + 1);
    else k++;
  }
  return src.length;
}

function prevToken(tokens) {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") continue;
    if (t.type === "ident") return t.text;
    if (t.type === "punct") return t.text;
    return "lit";
  }
  return "";
}

function regexAfter(prev) {
  if (prev === "") return true;
  if (REGEX_KEYWORDS.has(prev)) return true;
  return prev.length === 1 && REGEX_AFTER.has(prev);
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      let e = i;
      while (e < src.length && /\s/.test(src[e])) e++;
      tokens.push({ type: "ws", start: i, end: e - 1 });
      i = e;
    } else if (c === '"' || c === "'") {
      const e = skipString(src, i, c);
      tokens.push({ type: "string", start: i, end: e - 1, text: src.slice(i, e) });
      i = e;
    } else if (c === "`") {
      const e = skipTemplate(src, i);
      tokens.push({ type: "template", start: i, end: e - 1, text: src.slice(i, e) });
      i = e;
    } else if (c === "/" && src[i + 1] === "/") {
      const e = skipLineComment(src, i);
      tokens.push({ type: "comment", start: i, end: e - 1 });
      i = e;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = skipBlockComment(src, i);
      tokens.push({ type: "comment", start: i, end: e - 1 });
      i = e;
    } else if (c === "/" && regexAfter(prevToken(tokens))) {
      const e = skipRegex(src, i);
      tokens.push({ type: "regex", start: i, end: e - 1, text: src.slice(i, e) });
      i = e;
    } else if (isIdentStart(c)) {
      let e = i;
      while (e < src.length && isIdentChar(src[e])) e++;
      tokens.push({ type: "ident", start: i, end: e - 1, text: src.slice(i, e) });
      i = e;
    } else if (/[0-9]/.test(c)) {
      let e = i;
      while (e < src.length && /[0-9a-zA-Z_$]/.test(src[e])) e++;
      tokens.push({ type: "number", start: i, end: e - 1, text: src.slice(i, e) });
      i = e;
    } else {
      tokens.push({ type: "punct", start: i, end: i, text: c });
      i++;
    }
  }
  return tokens;
}

function nextSignificant(tokens, i) {
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") continue;
    return { token: t, index: k };
  }
  return null;
}

function findCandidates(tokens, name) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "ident" && t.text === "function") {
      const n = nextSignificant(tokens, i);
      if (n && n.token.type === "ident" && n.token.text === name) out.push(n.index);
    } else if (t.type === "ident" && (t.text === "const" || t.text === "let" || t.text === "var")) {
      const n = nextSignificant(tokens, i);
      if (!n || n.token.type !== "ident" || n.token.text !== name) continue;
      const eq = nextSignificant(tokens, n.index);
      if (eq && eq.token.type === "punct" && eq.token.text === "=") out.push(n.index);
    } else if (t.type === "string" && (t.text === `"${name}"` || t.text === `'${name}'`)) {
      const colon = nextSignificant(tokens, i);
      if (colon && colon.token.type === "punct" && colon.token.text === ":") out.push(i);
    }
  }
  return out;
}

function findBodyOpen(tokens, fromIndex) {
  let depth = 0;
  for (let i = fromIndex + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") continue;
    if (t.type !== "punct") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (t.text === "{" && depth === 0) return i;
    else if (t.text === ";" && depth === 0) return -1;
  }
  return -1;
}

function matchBrace(tokens, openIndex) {
  let depth = 1;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "punct") continue;
    if (t.text === "{") depth++;
    else if (t.text === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function extractDefinitions(src, name) {
  const tokens = tokenize(src);
  const candidates = findCandidates(tokens, name);
  if (candidates.length === 0) return [];
  const bodies = [];
  for (const ci of candidates) {
    const open = findBodyOpen(tokens, ci);
    if (open === -1) throw new Error(`cannot find a brace-delimited body for "${name}"`);
    const close = matchBrace(tokens, open);
    if (close === -1) throw new Error(`unbalanced braces in "${name}"`);
    bodies.push(src.slice(tokens[open].start, tokens[close].end + 1));
  }
  return bodies;
}

export function normalize(src) {
  const tokens = tokenize(src);
  let out = "";
  for (const t of tokens) {
    if (t.type === "ws" || t.type === "comment") continue;
    out += t.text ?? src.slice(t.start, t.end + 1);
  }
  return out;
}

export function parseCfg(text) {
  const lines = text.split("\n");
  const sections = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("\\*")) { i++; continue; }
    if (line.length - trimmed.length > 0) { i++; continue; }
    const m = /^([A-Z][A-Z0-9_]*)\b\s*([\s\S]*)$/.exec(trimmed);
    if (!m) { i++; continue; }
    const keyword = m[1];
    const args = [];
    const inline = m[2].trim();
    if (inline) args.push(inline);
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      const t = l.trim();
      if (t === "") break;
      if (t.startsWith("\\*")) { j++; continue; }
      if (l.length - t.length === 0) break;
      args.push(t);
      j++;
    }
    sections.push({ keyword, args });
    i = j;
  }
  return sections;
}

export function cfgFlags(sections) {
  return {
    hasSymmetry: sections.some((s) => s.keyword === "SYMMETRY"),
    hasProperty: sections.some((s) => s.keyword === "PROPERTY" || s.keyword === "PROPERTIES"),
  };
}

export function generateMutantCfg(text, mutantId, rule) {
  const out = [];
  const constants = [];
  for (const s of parseCfg(text)) {
    if (RULE_KEYWORDS.has(s.keyword)) continue;
    if (CONST_KEYWORDS.has(s.keyword)) {
      for (const a of s.args) if (!/^MUTANTS\s*=/.test(a)) constants.push(a);
      continue;
    }
    out.push([s.keyword, ...s.args].join(" "));
  }
  out.push("CONSTANT");
  for (const c of constants) out.push(`  ${c}`);
  out.push(`  ${MUTANTS} = {"${mutantId}"}`);
  out.push(rule.kind === "safety" ? `INVARIANT ${rule.id}` : `PROPERTY ${rule.id}`);
  return out.join("\n") + "\n";
}

export function hashEntry(entry, read = readFileSync, root = ROOT) {
  const src = read(join(root, entry.file), "utf8");
  const parts = [];
  for (const fn of entry.functions) {
    const bodies = extractDefinitions(src, fn);
    if (bodies.length === 0) return { found: false };
    if (bodies.length > 1) throw new Error(`${entry.file}: "${fn}" is defined ${bodies.length} times`);
    parts.push(normalize(bodies[0]));
  }
  return { found: true, sha256: sha256(parts.join("\n")) };
}

const MANIFEST_KEYS = new Set(["flow", "spec", "config", "rules", "mutants", "covered", "bounds", "notModelled", "traceTest", "timeoutSeconds"]);
const RULE_KEYS = new Set(["id", "kind", "sentence", "harm"]);
const MUTANT_KEYS = new Set(["id", "breaks", "code"]);
const COVERED_KEYS = new Set(["file", "functions", "sha256"]);

export function validateManifest(manifest, { specText = null, dirName = null } = {}) {
  const bad = (msg) => {
    throw new Error(`${dirName ?? manifest.flow ?? "flow"}: ${msg}`);
  };
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) bad("formal.json must be an object");
  for (const k of Object.keys(manifest)) if (!MANIFEST_KEYS.has(k)) bad(`unknown manifest key "${k}"`);
  for (const k of ["flow", "spec", "config", "rules", "mutants", "covered", "bounds", "notModelled"]) {
    if (manifest[k] === undefined) bad(`missing key "${k}"`);
  }
  if (dirName && manifest.flow !== dirName) bad(`"flow" (${manifest.flow}) must equal its directory name (${dirName})`);
  if (typeof manifest.spec !== "string" || !manifest.spec) bad('"spec" must be a file name');
  if (typeof manifest.config !== "string" || !manifest.config) bad('"config" must be a file name');
  if (typeof manifest.bounds !== "string" || !manifest.bounds) bad('"bounds" must be a string');
  if (!Array.isArray(manifest.notModelled)) bad('"notModelled" must be an array');
  if (manifest.traceTest !== undefined && (typeof manifest.traceTest !== "string" || !manifest.traceTest)) bad('"traceTest" must be a string');
  if (manifest.timeoutSeconds !== undefined && (typeof manifest.timeoutSeconds !== "number" || manifest.timeoutSeconds <= 0)) bad('"timeoutSeconds" must be a positive number');

  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) bad('"rules" must be a non-empty array');
  const ruleIds = new Set();
  for (const r of manifest.rules) {
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) bad(`unknown rule key "${k}"`);
    if (typeof r.id !== "string" || !r.id) bad("each rule needs a string id");
    if (ruleIds.has(r.id)) bad(`duplicate rule id "${r.id}"`);
    ruleIds.add(r.id);
    if (r.kind !== "safety" && r.kind !== "liveness") bad(`rule ${r.id}: "kind" must be "safety" or "liveness"`);
    if (typeof r.sentence !== "string" || !r.sentence) bad(`rule ${r.id}: "sentence" is required`);
    if (typeof r.harm !== "string" || !r.harm) bad(`rule ${r.id}: "harm" is required`);
  }

  if (!Array.isArray(manifest.mutants) || manifest.mutants.length === 0) bad('"mutants" must be a non-empty array');
  const mutantIds = new Set();
  for (const m of manifest.mutants) {
    for (const k of Object.keys(m)) if (!MUTANT_KEYS.has(k)) bad(`unknown mutant key "${k}"`);
    if (typeof m.id !== "string" || !m.id) bad("each mutant needs a string id");
    if (mutantIds.has(m.id)) bad(`duplicate mutant id "${m.id}"`);
    mutantIds.add(m.id);
    if (!ruleIds.has(m.breaks)) bad(`mutant ${m.id}: "breaks" (${m.breaks}) is not a rule id`);
    if (m.code !== undefined && typeof m.code !== "string") bad(`mutant ${m.id}: "code" must be a string`);
  }
  for (const id of ruleIds) if (!manifest.mutants.some((m) => m.breaks === id)) bad(`rule ${id} has no mutant`);

  if (!Array.isArray(manifest.covered) || manifest.covered.length === 0) bad('"covered" must be a non-empty array');
  for (const c of manifest.covered) {
    for (const k of Object.keys(c)) if (!COVERED_KEYS.has(k)) bad(`unknown covered key "${k}"`);
    if (typeof c.file !== "string" || !c.file) bad("each covered entry needs a string file");
    if (!Array.isArray(c.functions) || c.functions.length === 0) bad(`covered ${c.file}: "functions" must be a non-empty array`);
    if (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256)) bad(`covered ${c.file}: "sha256" must be 64 hex characters`);
  }

  if (specText != null) {
    for (const m of manifest.mutants) {
      if (!specText.includes(`"${m.id}" \\in ${MUTANTS}`)) bad(`mutant ${m.id} does not appear in the model as "${m.id}" \\in ${MUTANTS}`);
    }
  }
  return manifest;
}

export function discoverFlows(flowsDir, { readFileSync: read = readFileSync, readdirSync: ls = readdirSync, existsSync: exists = existsSync } = {}) {
  if (!exists(flowsDir)) return [];
  const out = [];
  for (const name of ls(flowsDir).sort()) {
    const dir = join(flowsDir, name);
    const manifestPath = join(dir, "formal.json");
    if (!exists(manifestPath)) continue;
    const manifest = JSON.parse(read(manifestPath, "utf8"));
    out.push({ name, dir, manifestPath, manifest, specPath: join(dir, manifest.spec), configPath: join(dir, manifest.config) });
  }
  return out;
}

export function runOutcome({ status, signal, error, stdout, stderr, timedOut }) {
  if (timedOut) return { kind: "timeout" };
  if (error) return { kind: "spawn-error", message: error.message };
  if (signal) return { kind: "timeout" };
  const out = `${stdout}\n${stderr}`;
  const inv = /Invariant\s+(\S+)\s+is violated/.exec(out);
  const violated = /is violated|properties were violated/i.test(out);
  if (status === 0) return violated ? { kind: "violation-exit-zero", invariant: inv?.[1] ?? null } : { kind: "pass" };
  if (status === 12) return { kind: "safety-violation", invariant: inv?.[1] ?? null };
  if (status === 13) return { kind: "liveness-violation" };
  if (status === 10) return { kind: "assume-false" };
  if (status === 11) return { kind: "deadlock" };
  if (status === 150) return { kind: "parse-semantic" };
  if (status === 151) return { kind: "constant-missing" };
  if (status === 255) return { kind: "oom" };
  if (status === 1) return { kind: "bad-option" };
  if (status === 142) return { kind: "timeout" };
  return { kind: "unknown", status };
}

export function describeOutcome(outcome) {
  switch (outcome.kind) {
    case "pass": return "passed (exit 0)";
    case "violation-exit-zero": return "reported a violation but exited 0";
    case "safety-violation": return `invariant ${outcome.invariant ?? "?"} violated (exit 12)`;
    case "liveness-violation": return "temporal property violated (exit 13)";
    case "assume-false": return "ASSUME evaluated to FALSE (exit 10)";
    case "deadlock": return "deadlock, no enabled next step (exit 11)";
    case "parse-semantic": return "parse or semantic error (exit 150)";
    case "constant-missing": return "constant missing from cfg (exit 151)";
    case "oom": return "out of memory (exit 255)";
    case "bad-option": return "bad TLC option (exit 1)";
    case "timeout": return "timed out";
    case "spawn-error": return `could not run java: ${outcome.message}`;
    case "unknown": return `exited ${outcome.status}`;
    default: return outcome.kind;
  }
}

export const distinctStates = (stdout) => {
  const m = /(\d+)\s+distinct states found/.exec(stdout ?? "");
  return m ? Number(m[1]) : null;
};

export function runTlc(java, jar, spec, { configPath = null, configText = null, timeoutMs = DEFAULT_TIMEOUT_MS, spawnSync: spawnImpl = spawnSync, cwd = ROOT } = {}) {
  const runRoot = join(ROOT, "formal-runs");
  mkdirSync(runRoot, { recursive: true });
  const dir = mkdtempSync(join(runRoot, "run-"));
  const suffix = basename(dir).slice(4);
  let cfg = configPath;
  let ownedCfg = false;
  if (configText) {
    cfg = join(dirname(spec), `Mutant-${suffix}.cfg`);
    writeFileSync(cfg, configText);
    ownedCfg = true;
  }
  const args = ["-cp", jar, "tlc2.TLC"];
  if (cfg) args.push("-config", cfg);
  args.push("-metadir", dir, "-workers", "auto", spec);
  const started = Date.now();
  let r;
  try {
    r = spawnImpl(java, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (ownedCfg) rmSync(cfg, { force: true });
  }
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.status == null && r.signal != null);
  return { status: r.status, signal: r.signal, error: r.error ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", seconds: (Date.now() - started) / 1000, timedOut };
}

function resyncHashes(flow, deps) {
  const manifest = JSON.parse(deps.readFileSync(flow.manifestPath, "utf8"));
  for (const entry of manifest.covered) {
    const h = hashEntry(entry, deps.readFileSync);
    if (!h.found) throw new Error(`cannot resync ${flow.name}: ${entry.file} no longer has a covered function`);
    entry.sha256 = h.sha256;
  }
  deps.writeFileSync(flow.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function runFlow(flow, { java, jar, spawnSync: spawnImpl = spawnSync, readFileSync: read = readFileSync, timeoutMs = DEFAULT_TIMEOUT_MS, resync = false, cwd = ROOT }) {
  const checks = [];
  const errors = [];
  const traces = [];
  const specText = read(flow.specPath, "utf8");
  const cfgText = read(flow.configPath, "utf8");
  const flags = cfgFlags(parseCfg(cfgText));
  if (flags.hasProperty && flags.hasSymmetry) {
    errors.push(`SYMMETRY with a PROPERTY gives false counterexamples; give safety rules their own symmetric cfg`);
    return { checks, errors, traces };
  }
  validateManifest(flow.manifest, { specText, dirName: flow.name });

  if (!resync) {
    const stale = [];
    for (const entry of flow.manifest.covered) {
      const h = hashEntry(entry, read);
      if (!h.found || h.sha256 !== entry.sha256) stale.push(entry.file);
    }
    if (stale.length) {
      errors.push(`covered code changed: ${stale.join(", ")}. Run /maintain-formal-verification-skill on ${flow.name}, then pnpm formal --resync ${flow.name}.`);
      return { checks, errors, traces };
    }
  }

  const main = runTlc(java, jar, flow.specPath, { configPath: flow.configPath, spawnSync: spawnImpl, timeoutMs, cwd });
  const mainOutcome = runOutcome(main);
  if (mainOutcome.kind !== "pass") {
    errors.push(`main config ${describeOutcome(mainOutcome)}`);
    traces.push({ flow: flow.name, check: "main", output: `${main.stdout}\n${main.stderr}` });
    checks.push({ flow: flow.name, check: "main", pass: false, states: distinctStates(main.stdout), seconds: main.seconds });
    return { checks, errors, traces };
  }
  checks.push({ flow: flow.name, check: "main", pass: true, states: distinctStates(main.stdout), seconds: main.seconds });

  for (const mutant of flow.manifest.mutants) {
    const rule = flow.manifest.rules.find((r) => r.id === mutant.breaks);
    const cfg = generateMutantCfg(cfgText, mutant.id, rule);
    const run = runTlc(java, jar, flow.specPath, { configText: cfg, spawnSync: spawnImpl, timeoutMs, cwd });
    const outcome = runOutcome(run);
    const expected = rule.kind === "safety" ? "safety-violation" : "liveness-violation";
    let pass = false;
    let message = null;
    if (outcome.kind === expected) {
      if (rule.kind === "safety" && outcome.invariant !== rule.id) message = `wrong invariant violated: expected ${rule.id}, got ${outcome.invariant ?? "none"}`;
      else pass = true;
    } else if (outcome.kind === "pass" || outcome.kind === "violation-exit-zero") {
      message = `mutant survived: ${mutant.id} did not violate ${rule.id}`;
    } else {
      message = `mutant ${mutant.id} ${describeOutcome(outcome)} (not a killed mutant)`;
    }
    if (!pass) {
      errors.push(message);
      traces.push({ flow: flow.name, check: `mutant ${mutant.id}`, output: `${run.stdout}\n${run.stderr}` });
    }
    checks.push({ flow: flow.name, check: `mutant ${mutant.id}`, pass, states: distinctStates(run.stdout), seconds: run.seconds });
  }

  if (resync && errors.length === 0) resyncHashes(flow, { readFileSync: read, writeFileSync });
  return { checks, errors, traces };
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  const spawnImpl = opts.spawnSync ?? spawnSync;
  const read = opts.readFileSync ?? readFileSync;
  const log = opts.log ?? console.log;
  const err = opts.err ?? console.error;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const flowsDir = args.flows ?? opts.flowsDir ?? join(ROOT, "formal");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let flows;
  try {
    flows = discoverFlows(flowsDir, { readFileSync: read });
  } catch (e) {
    err(`✗ formal: ${e.message}`);
    return { code: 1, checks: [], errors: [e.message] };
  }

  if (args.resync !== undefined) {
    const flow = flows.find((f) => f.name === args.resync);
    if (!flow) {
      err(`✗ formal: no flow named "${args.resync}" under ${flowsDir}`);
      return { code: 1, checks: [], errors: [`no flow named "${args.resync}"`] };
    }
    flows = [flow];
  } else if (flows.length === 0) {
    log(`formal: no flows found under ${flowsDir}`);
    return { code: 0, checks: [], errors: [] };
  }

  const java = (opts.findJava ?? findJava)();
  if (!java) {
    err("✗ formal: no Java found. Set $JAVA, set $JAVA_HOME, install temurin-25 via mise, or put java on PATH.");
    return { code: 1, checks: [], errors: ["no Java found"] };
  }

  let jar;
  try {
    jar = await (opts.ensureJar ?? ensureJar)({ cacheDir });
  } catch (e) {
    err(`✗ formal: ${e.message}`);
    return { code: 1, checks: [], errors: [e.message] };
  }

  const checks = [];
  const errors = [];
  const traces = [];
  for (const flow of flows) {
    try {
      const r = runFlow(flow, { java, jar, spawnSync: spawnImpl, readFileSync: read, timeoutMs, resync: args.resync !== undefined });
      checks.push(...r.checks);
      errors.push(...r.errors);
      traces.push(...r.traces);
    } catch (e) {
      err(`✗ ${flow.name}: ${e.message}`);
      errors.push(`${flow.name}: ${e.message}`);
    }
  }

  for (const c of checks) {
    const states = c.states == null ? "-" : `${c.states}`;
    log(`${c.flow.padEnd(20)}  ${c.check.padEnd(24)}  ${c.pass ? "pass" : "fail"}  ${states.padStart(9)} states  ${c.seconds.toFixed(1)}s`);
  }
  for (const e of errors) err(`✗ ${e}`);
  for (const t of traces) err(`${t.flow} ${t.check} output:\n${t.output}`);

  if (args.resync !== undefined && errors.length === 0) log(`resynced covered hashes for ${args.resync}`);
  const ok = errors.length === 0;
  log(ok ? `formal: ${checks.length} checks passed` : `formal: ${errors.length} error(s)`);
  return { code: ok ? 0 : 1, checks, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((r) => process.exit(r.code))
    .catch((e) => {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    });
}
