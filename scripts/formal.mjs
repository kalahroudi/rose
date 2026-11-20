// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, parseArgs } from "./lib.mjs";
import { tokenize } from "./route-authz-scan.mjs";

export const TLA_TOOLS_VERSION = "1.7.4";
export const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar`;
export const TLA_TOOLS_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_SECONDS = 3600;
export const MISE_TIMEOUT_MS = 5_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_JAR_BYTES = 32 * 1024 * 1024;
export const MUTANTS = "MUTANTS";

export const TLC_EXIT_TABLE = [
  { code: 0, kind: "pass", description: "passed (exit 0)" },
  { code: 10, kind: "assume-false", description: "ASSUME evaluated to FALSE (exit 10)" },
  { code: 11, kind: "deadlock", description: "deadlock, no enabled next step (exit 11)" },
  { code: 12, kind: "safety-violation", description: "safety invariant violated (exit 12)" },
  { code: 13, kind: "liveness-violation", description: "temporal property violated (exit 13)" },
  { code: 150, kind: "parse-semantic", description: "parse or semantic error (exit 150)" },
  { code: 151, kind: "constant-missing", description: "constant missing from cfg (exit 151)" },
  { code: 255, kind: "oom", description: "out of memory (exit 255)" },
  { code: 1, kind: "bad-option", description: "bad TLC option (exit 1)" },
  { code: 142, kind: "timeout", description: "timed out" },
];
const EXIT_BY_CODE = new Map(TLC_EXIT_TABLE.map((e) => [e.code, e]));
const EXIT_BY_KIND = new Map(TLC_EXIT_TABLE.map((e) => [e.kind, e]));

const TLC_CFG_KEYWORDS = new Set([
  "SPECIFICATION",
  "INIT",
  "NEXT",
  "CONSTANT",
  "CONSTANTS",
  "CONSTRAINT",
  "CONSTRAINTS",
  "ACTION_CONSTRAINT",
  "ACTION_CONSTRAINTS",
  "INVARIANT",
  "INVARIANTS",
  "PROPERTY",
  "PROPERTIES",
  "SYMMETRY",
  "VIEW",
  "TYPE",
  "TYPE_CONSTRAINT",
  "CHECK_DEADLOCK",
  "ALIAS",
  "POSTCONDITION",
]);
const INVARIANT_KEYWORDS = new Set(["INVARIANT", "INVARIANTS"]);
const PROPERTY_KEYWORDS = new Set(["PROPERTY", "PROPERTIES"]);
const RULE_KEYWORDS = new Set([...INVARIANT_KEYWORDS, ...PROPERTY_KEYWORDS]);
const CONST_KEYWORDS = new Set(["CONSTANT", "CONSTANTS"]);

export const defaultCacheDir = () => process.env.ROSE_FORMAL_CACHE ?? join(homedir(), ".cache", "rose-formal");

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function findJava({ env = process.env, existsSync: exists = existsSync, spawnSync: spawnImpl = spawnSync } = {}) {
  if (env.JAVA && exists(env.JAVA)) return env.JAVA;
  if (env.JAVA_HOME) {
    const jh = join(env.JAVA_HOME, "bin", "java");
    if (exists(jh)) return jh;
  }
  const mise = spawnImpl("mise", ["where", "java@temurin-25"], { encoding: "utf8", env, timeout: MISE_TIMEOUT_MS });
  if (!mise.error && mise.status === 0 && mise.stdout) {
    const line = mise.stdout.trim().split(/\r?\n/)[0];
    if (line) {
      const mj = join(line, "bin", "java");
      if (exists(mj)) return mj;
    }
  }
  if (env.PATH) {
    for (const dir of env.PATH.split(delimiter)) {
      if (!dir) continue;
      const pj = join(dir, "java");
      if (exists(pj)) return pj;
    }
  }
  return null;
}

export async function downloadJar(url, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_JAR_BYTES } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  const lenHeader = res.headers?.get?.("content-length");
  if (lenHeader != null) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      await res.body?.cancel?.();
      throw new Error(`download refused: ${url} exceeds ${maxBytes} bytes (Content-Length: ${len})`);
    }
  }
  if (res.body) {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`download refused: ${url} exceeded ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`download refused: ${url} exceeded ${maxBytes} bytes`);
  return buf;
}

export async function ensureJar({ cacheDir = defaultCacheDir(), url = TLA_TOOLS_URL, sha = TLA_TOOLS_SHA256, download = downloadJar } = {}) {
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

// ── Drift detection (reuses tokenize from scripts/route-authz-scan.mjs) ───────────

const isP = (t, v) => t?.type === "punct" && (v === undefined || t.value === v);
const isId = (t, v) => t?.type === "id" && (v === undefined || t.value === v);
const isPropAccess = (toks, i) => isP(toks[i - 1], ".") || isP(toks[i - 1], "?.") || isP(toks[i - 1], "#");

const TYPE_EXPECTS_BRACE_PUNCT = new Set([":", "|", "&", "=>", "?"]);
const TYPE_EXPECTS_BRACE_KW = new Set(["is", "extends", "keyof"]);
const STMT_START_KW = new Set(["export", "import", "function", "const", "let", "var", "class", "interface", "type", "return", "if", "for", "while", "switch", "try"]);

function matchDelim(toks, openIdx, openVal, closeVal) {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    if (isP(toks[i], openVal)) depth++;
    else if (isP(toks[i], closeVal) && --depth === 0) return i;
  }
  return -1;
}

function skipBalanced(toks, i) {
  if (isP(toks[i], "(")) { const c = matchDelim(toks, i, "(", ")"); return c < 0 ? -1 : c + 1; }
  if (isP(toks[i], "[")) { const c = matchDelim(toks, i, "[", "]"); return c < 0 ? -1 : c + 1; }
  if (isP(toks[i], "{")) { const c = matchDelim(toks, i, "{", "}"); return c < 0 ? -1 : c + 1; }
  return i;
}

function skipAngle(toks, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < toks.length) {
    if (isP(toks[i], "(") || isP(toks[i], "[") || isP(toks[i], "{")) {
      i = skipBalanced(toks, i);
      if (i < 0) return -1;
      continue;
    }
    if (isP(toks[i], "<")) depth++;
    else if (isP(toks[i], ">") && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

const expectsTypeAfter = (prev) =>
  (prev.type === "punct" && TYPE_EXPECTS_BRACE_PUNCT.has(prev.value))
  || (prev.type === "id" && TYPE_EXPECTS_BRACE_KW.has(prev.value));

/** Skip `: ReturnType` after a function's `)`. Returns body `{` index, -2 for overload/ambient `;`, or -1 on error. */
function skipReturnTypeToBrace(toks, colonIdx) {
  let i = colonIdx + 1;
  let prev = toks[colonIdx];
  while (i < toks.length) {
    const t = toks[i];
    if (isP(t, "(") || isP(t, "[")) {
      const next = skipBalanced(toks, i);
      if (next < 0) return -1;
      prev = toks[next - 1];
      i = next;
      continue;
    }
    if (isP(t, "<")) {
      const next = skipAngle(toks, i);
      if (next < 0) return -1;
      prev = toks[next - 1];
      i = next;
      continue;
    }
    if (isP(t, "{")) {
      if (expectsTypeAfter(prev)) {
        const next = skipBalanced(toks, i);
        if (next < 0) return -1;
        prev = toks[next - 1];
        i = next;
        continue;
      }
      return i;
    }
    if (isP(t, ";")) return -2;
    if (t.line > prev.line && isId(t) && STMT_START_KW.has(t.value) && !expectsTypeAfter(prev)) return -2;
    prev = t;
    i++;
  }
  return -1;
}

/** Skip a TypeScript type annotation starting at `:` until `stopPunct` (`=` or `=>`) at top level. */
function skipTypeUntil(toks, colonIdx, stopPunct) {
  let i = colonIdx + 1;
  let prev = toks[colonIdx];
  while (i < toks.length) {
    const t = toks[i];
    if (isP(t, "(") || isP(t, "[") || isP(t, "{")) {
      const next = skipBalanced(toks, i);
      if (next < 0) return -1;
      prev = toks[next - 1];
      i = next;
      continue;
    }
    if (isP(t, "<")) {
      const next = skipAngle(toks, i);
      if (next < 0) return -1;
      prev = toks[next - 1];
      i = next;
      continue;
    }
    if (isP(t, stopPunct)) return i;
    if (isP(t, ";") || isP(t, ",") || (stopPunct === "=>" && isP(t, "="))) return -1;
    if (t.line > prev.line && isId(t) && STMT_START_KW.has(t.value) && !expectsTypeAfter(prev)) return -1;
    prev = t;
    i++;
  }
  return -1;
}

/** Starting at `function`, return body `{` index, -2 for overload/ambient declaration, or -1 if malformed. */
function findFunctionBody(toks, fnKwIdx) {
  let i = fnKwIdx + 1;
  if (isP(toks[i], "*")) i++;
  if (isId(toks[i])) i++;
  if (isP(toks[i], "<")) {
    i = skipAngle(toks, i);
    if (i < 0) return -1;
  }
  if (!isP(toks[i], "(")) return -1;
  const closeParen = matchDelim(toks, i, "(", ")");
  if (closeParen < 0) return -1;
  i = closeParen + 1;
  if (isP(toks[i], "{")) return i;
  if (isP(toks[i], ";")) return -2;
  if (isP(toks[i], ":")) return skipReturnTypeToBrace(toks, i);
  return -1;
}

/** Parse RHS of `const name [: Type] = <rhs>` or `"name": <rhs>` as a function expression or arrow function. */
function parseRhsFunction(toks, start) {
  let i = start;
  if (isId(toks[i], "async")) i++;
  if (isId(toks[i], "function")) {
    const open = findFunctionBody(toks, i);
    return open >= 0 ? { kind: "body", open } : { kind: "not-fn" };
  }
  if (isP(toks[i], "<")) {
    i = skipAngle(toks, i);
    if (i < 0) return { kind: "not-fn" };
  }
  if (isP(toks[i], "(")) {
    const closeParen = matchDelim(toks, i, "(", ")");
    if (closeParen < 0) return { kind: "not-fn" };
    i = closeParen + 1;
    if (isP(toks[i], ":")) {
      i = skipTypeUntil(toks, i, "=>");
      if (i < 0) return { kind: "not-fn" };
    }
    if (!isP(toks[i], "=>")) return { kind: "not-fn" };
  } else if (isId(toks[i]) && isP(toks[i + 1], "=>")) {
    i += 1;
  } else {
    return { kind: "not-fn" };
  }
  const bodyIdx = i + 1;
  if (isP(toks[bodyIdx], "{")) return { kind: "body", open: bodyIdx };
  return { kind: "expr-arrow" };
}

export function extractDefinitions(src, name) {
  const toks = tokenize(src);
  const bodies = [];
  const seenOpen = new Set();

  const recordBody = (open) => {
    if (seenOpen.has(open)) return;
    seenOpen.add(open);
    const close = matchDelim(toks, open, "{", "}");
    if (close < 0) throw new Error(`unbalanced braces in "${name}"`);
    bodies.push(src.slice(toks[open].pos, toks[close].pos + 1));
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isId(t, "function") && !isPropAccess(toks, i)) {
      const nameIdx = isP(toks[i + 1], "*") ? i + 2 : i + 1;
      if (!isId(toks[nameIdx], name)) continue;
      const open = findFunctionBody(toks, i);
      if (open === -2) continue; // TypeScript overload or ambient signature
      if (open < 0) throw new Error(`cannot find a brace-delimited body for "${name}"`);
      recordBody(open);
    } else if (isId(t) && (t.value === "const" || t.value === "let" || t.value === "var") && !isPropAccess(toks, i)) {
      const nameIdx = i + 1;
      if (!isId(toks[nameIdx], name)) continue;
      let eqIdx = nameIdx + 1;
      if (isP(toks[eqIdx], "!")) eqIdx++;
      if (isP(toks[eqIdx], ":")) {
        eqIdx = skipTypeUntil(toks, eqIdx, "=");
        if (eqIdx < 0) continue;
      }
      if (!isP(toks[eqIdx], "=")) continue;
      const rhs = parseRhsFunction(toks, eqIdx + 1);
      if (rhs.kind === "expr-arrow") {
        throw new Error(`cannot find a brace-delimited body for "${name}" (expression-bodied arrow functions must use { ... })`);
      }
      if (rhs.kind !== "body") throw new Error(`cannot find a brace-delimited body for "${name}"`);
      recordBody(rhs.open);
    } else if (t.type === "str" && t.value === name && isP(toks[i + 1], ":")) {
      const rhs = parseRhsFunction(toks, i + 2);
      if (rhs.kind === "expr-arrow") {
        throw new Error(`cannot find a brace-delimited body for "${name}" (expression-bodied arrow functions must use { ... })`);
      }
      if (rhs.kind === "body") recordBody(rhs.open);
    }
  }
  return bodies;
}

export function normalize(src) {
  const toks = tokenize(src);
  const parts = [];
  const tmplStarts = [];
  for (const t of toks) {
    if (t.type === "template") {
      tmplStarts.push(t.pos + 1);
      parts.push("`");
    } else if (t.type === "tmplOpen") {
      const start = tmplStarts.pop();
      parts.push(src.slice(start, t.pos));
      parts.push("${");
    } else if (t.type === "tmplClose") {
      parts.push("}");
      tmplStarts.push(t.pos + 1);
    } else if (t.type === "templateEnd") {
      const start = tmplStarts.pop();
      parts.push(src.slice(start, t.pos - 1));
      parts.push("`");
    } else if (t.type === "str") {
      const q = src[t.pos];
      parts.push(`${q}${t.value}${q}`);
    } else {
      parts.push(t.value);
    }
  }
  return parts.join(" ");
}

// ── TLC .cfg parsing and mutant generation ────────────────────────────────────────

function stripCfgComments(text) {
  let out = "";
  let i = 0;
  let blockDepth = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (blockDepth > 0) {
      if (c === "(" && n === "*") { blockDepth++; i += 2; continue; }
      if (c === "*" && n === ")") { blockDepth--; i += 2; continue; }
      if (c === "\n") out += "\n";
      i++;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "(" && n === "*") { blockDepth = 1; i += 2; continue; }
    if (c === "\\" && n === "*") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function parseCfg(text) {
  const cleaned = stripCfgComments(text.replace(/\r\n?/g, "\n"));
  const sections = [];
  let current = null;
  for (const rawLine of cleaned.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const m = /^([A-Z][A-Z0-9_]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
    const isConstAssign = current && CONST_KEYWORDS.has(current.keyword) && /^(?:=|<-)/.test(m?.[2] ?? "");
    if (m && TLC_CFG_KEYWORDS.has(m[1]) && !isConstAssign) {
      current = { keyword: m[1], args: [] };
      const rest = m[2]?.trim();
      if (rest) current.args.push(rest);
      sections.push(current);
    } else if (current) {
      current.args.push(trimmed);
    } else {
      throw new Error(`unexpected cfg line before any TLC keyword: "${trimmed}"`);
    }
  }
  return sections;
}

export function cfgFlags(sections) {
  const invariants = new Set();
  const properties = new Set();
  let hasSymmetry = false;
  for (const s of sections) {
    if (s.keyword === "SYMMETRY") hasSymmetry = true;
    else if (INVARIANT_KEYWORDS.has(s.keyword)) {
      for (const a of s.args) for (const name of a.split(/\s+/)) if (name) invariants.add(name);
    } else if (PROPERTY_KEYWORDS.has(s.keyword)) {
      for (const a of s.args) for (const name of a.split(/\s+/)) if (name) properties.add(name);
    }
  }
  return {
    hasSymmetry,
    hasProperty: sections.some((s) => PROPERTY_KEYWORDS.has(s.keyword)),
    invariants,
    properties,
  };
}

export function generateMutantCfg(text, mutantId, rule) {
  const out = [];
  const constants = [];
  for (const s of parseCfg(text)) {
    if (RULE_KEYWORDS.has(s.keyword)) continue;
    if (rule.kind === "liveness" && s.keyword === "SYMMETRY") continue;
    if (CONST_KEYWORDS.has(s.keyword)) {
      for (const a of s.args) if (!/^MUTANTS\s*=/.test(a)) constants.push(a);
      continue;
    }
    if (s.args.length === 0) out.push(s.keyword);
    else if (s.args.length === 1) out.push(`${s.keyword} ${s.args[0]}`);
    else out.push(`${s.keyword}\n${s.args.map((a) => `  ${a}`).join("\n")}`);
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

// ── Manifest and config validation ────────────────────────────────────────────────

const MANIFEST_KEYS = new Set(["flow", "spec", "config", "configs", "rules", "mutants", "covered", "bounds", "notModelled", "traceTest", "timeoutSeconds"]);
const CONFIG_KEYS = new Set(["file", "rules"]);
const RULE_KEYS = new Set(["id", "kind", "sentence", "harm"]);
const MUTANT_KEYS = new Set(["id", "breaks", "code"]);
const COVERED_KEYS = new Set(["file", "functions", "sha256"]);

export function normalizeConfigs(manifest) {
  if (manifest.configs !== undefined) return manifest.configs;
  return [{ file: manifest.config, rules: manifest.rules.map((r) => r.id) }];
}

export function validateManifest(manifest, { specText = null, cfgTexts = null, dirName = null } = {}) {
  const bad = (msg) => {
    throw new Error(`${dirName ?? manifest?.flow ?? "flow"}: ${msg}`);
  };
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) bad("formal.json must be an object");
  for (const k of Object.keys(manifest)) if (!MANIFEST_KEYS.has(k)) bad(`unknown manifest key "${k}"`);
  for (const k of ["flow", "spec", "rules", "mutants", "covered", "bounds", "notModelled"]) {
    if (manifest[k] === undefined) bad(`missing key "${k}"`);
  }
  if (typeof manifest.flow !== "string" || !manifest.flow) bad('"flow" must be a string');
  if (dirName && manifest.flow !== dirName) bad(`"flow" (${manifest.flow}) must equal its directory name (${dirName})`);
  if (typeof manifest.spec !== "string" || !manifest.spec) bad('"spec" must be a file name');
  if (manifest.config !== undefined && manifest.configs !== undefined) bad('cannot specify both "config" and "configs"');
  if (manifest.config === undefined && manifest.configs === undefined) bad('must specify "config" or "configs"');
  if (manifest.config !== undefined && (typeof manifest.config !== "string" || !manifest.config)) bad('"config" must be a file name');
  if (typeof manifest.bounds !== "string" || !manifest.bounds) bad('"bounds" must be a string');
  if (!Array.isArray(manifest.notModelled)) bad('"notModelled" must be an array');
  if (manifest.traceTest !== undefined && (typeof manifest.traceTest !== "string" || !manifest.traceTest)) bad('"traceTest" must be a string');
  if (manifest.timeoutSeconds !== undefined) {
    if (typeof manifest.timeoutSeconds !== "number" || !Number.isFinite(manifest.timeoutSeconds) || manifest.timeoutSeconds <= 0 || manifest.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      bad(`"timeoutSeconds" must be a finite number greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
    }
  }

  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) bad('"rules" must be a non-empty array');
  const ruleById = new Map();
  for (const r of manifest.rules) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) bad("each rule must be an object");
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) bad(`unknown rule key "${k}"`);
    if (typeof r.id !== "string" || !r.id) bad("each rule needs a string id");
    if (ruleById.has(r.id)) bad(`duplicate rule id "${r.id}"`);
    if (r.kind !== "safety" && r.kind !== "liveness") bad(`rule ${r.id}: "kind" must be "safety" or "liveness"`);
    if (typeof r.sentence !== "string" || !r.sentence) bad(`rule ${r.id}: "sentence" is required`);
    if (typeof r.harm !== "string" || !r.harm) bad(`rule ${r.id}: "harm" is required`);
    ruleById.set(r.id, r);
  }

  if (manifest.configs !== undefined) {
    if (!Array.isArray(manifest.configs) || manifest.configs.length === 0) bad('"configs" must be a non-empty array');
    const seenFiles = new Set();
    const seenRules = new Set();
    for (const c of manifest.configs) {
      if (typeof c !== "object" || c === null || Array.isArray(c)) bad("each config entry must be an object");
      for (const k of Object.keys(c)) if (!CONFIG_KEYS.has(k)) bad(`unknown config key "${k}"`);
      if (typeof c.file !== "string" || !c.file) bad('each config entry needs a string "file"');
      if (seenFiles.has(c.file)) bad(`duplicate config file "${c.file}"`);
      seenFiles.add(c.file);
      if (!Array.isArray(c.rules) || c.rules.length === 0) bad(`config ${c.file}: "rules" must be a non-empty array`);
      for (const id of c.rules) {
        if (typeof id !== "string" || !id) bad(`config ${c.file}: each rule id must be a string`);
        if (!ruleById.has(id)) bad(`config ${c.file}: unknown rule "${id}"`);
        if (seenRules.has(id)) bad(`rule "${id}" must be listed in exactly one config`);
        seenRules.add(id);
      }
    }
    for (const id of ruleById.keys()) {
      if (!seenRules.has(id)) bad(`rule "${id}" is not assigned to any config`);
    }
  }

  if (!Array.isArray(manifest.mutants) || manifest.mutants.length === 0) bad('"mutants" must be a non-empty array');
  const mutantIds = new Set();
  for (const m of manifest.mutants) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) bad("each mutant must be an object");
    for (const k of Object.keys(m)) if (!MUTANT_KEYS.has(k)) bad(`unknown mutant key "${k}"`);
    if (typeof m.id !== "string" || !m.id) bad("each mutant needs a string id");
    if (mutantIds.has(m.id)) bad(`duplicate mutant id "${m.id}"`);
    mutantIds.add(m.id);
    if (!ruleById.has(m.breaks)) bad(`mutant ${m.id}: "breaks" (${m.breaks}) is not a rule id`);
    if (m.code !== undefined && typeof m.code !== "string") bad(`mutant ${m.id}: "code" must be a string`);
  }
  for (const id of ruleById.keys()) if (!manifest.mutants.some((m) => m.breaks === id)) bad(`rule ${id} has no mutant`);

  if (!Array.isArray(manifest.covered) || manifest.covered.length === 0) bad('"covered" must be a non-empty array');
  for (const c of manifest.covered) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) bad("each covered entry must be an object");
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

  if (cfgTexts != null) {
    for (const cfg of normalizeConfigs(manifest)) {
      const text = cfgTexts[cfg.file];
      if (typeof text !== "string") bad(`missing cfg text for "${cfg.file}"`);
      const flags = cfgFlags(parseCfg(text));
      const hasLivenessRule = cfg.rules.some((id) => ruleById.get(id).kind === "liveness");
      if (flags.hasSymmetry && (flags.hasProperty || hasLivenessRule)) {
        bad(`${cfg.file}: SYMMETRY is refused in any config holding a liveness rule or PROPERTY; give safety rules their own symmetric cfg`);
      }
      for (const id of cfg.rules) {
        const rule = ruleById.get(id);
        if (rule.kind === "safety" && !flags.invariants.has(id)) {
          bad(`${cfg.file}: safety rule "${id}" must be declared under INVARIANT or INVARIANTS`);
        }
        if (rule.kind === "liveness" && !flags.properties.has(id)) {
          bad(`${cfg.file}: liveness rule "${id}" must be declared under PROPERTY or PROPERTIES`);
        }
      }
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
    const specPath = typeof manifest.spec === "string" && manifest.spec ? join(dir, manifest.spec) : null;
    out.push({ name, dir, manifestPath, manifest, specPath });
  }
  return out;
}

// ── TLC execution and outcome classification ──────────────────────────────────────

export function runOutcome({ status, signal, error, stdout, stderr, timedOut }) {
  if (timedOut) return { kind: "timeout" };
  if (error) return { kind: "spawn-error", message: error.message };
  if (signal) return { kind: "signal", signal };
  const out = `${stdout}\n${stderr}`;
  const inv = /Invariant\s+(\S+)\s+is violated/.exec(out);
  const violated = /is violated|properties were violated/i.test(out);
  const entry = EXIT_BY_CODE.get(status);
  if (!entry) return { kind: "unknown", status };
  if (entry.kind === "pass") return violated ? { kind: "violation-exit-zero", invariant: inv?.[1] ?? null } : { kind: "pass" };
  if (entry.kind === "safety-violation") return { kind: "safety-violation", invariant: inv?.[1] ?? null };
  return { kind: entry.kind };
}

export function describeOutcome(outcome) {
  if (outcome.kind === "safety-violation") return `invariant ${outcome.invariant ?? "?"} violated (exit 12)`;
  if (outcome.kind === "violation-exit-zero") return "reported a violation but exited 0";
  if (outcome.kind === "signal") return `killed by signal ${outcome.signal}`;
  if (outcome.kind === "spawn-error") return `could not run java: ${outcome.message}`;
  if (outcome.kind === "unknown") return `exited ${outcome.status}`;
  return EXIT_BY_KIND.get(outcome.kind).description;
}

export const distinctStates = (stdout) => {
  const m = /(\d+)\s+distinct states found/.exec(stdout ?? "");
  return m ? Number(m[1]) : null;
};

export function runTlc(java, jar, spec, { configPath = null, configText = null, timeoutMs = DEFAULT_TIMEOUT_MS, spawnSync: spawnImpl = spawnSync } = {}) {
  if (configText === null && configPath === null) throw new Error("runTlc requires configPath or configText");
  const runRoot = join(ROOT, "formal-runs");
  mkdirSync(runRoot, { recursive: true });
  const dir = mkdtempSync(join(runRoot, "run-"));
  const metadir = join(dir, "meta");
  const specDir = resolve(dirname(spec));
  let cfg;
  if (configText !== null) {
    cfg = join(dir, "mutant.cfg");
    writeFileSync(cfg, configText);
  } else {
    cfg = resolve(configPath);
  }
  const args = [
    `-DTLA-Library=${specDir}`,
    "-cp",
    jar,
    "tlc2.TLC",
    "-config",
    cfg,
    "-metadir",
    metadir,
    "-workers",
    "auto",
    basename(spec),
  ];
  const started = Date.now();
  let r;
  try {
    r = spawnImpl(java, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const timedOut = r.error?.code === "ETIMEDOUT";
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

export function runFlow(flow, { java, jar, spawnSync: spawnImpl = spawnSync, readFileSync: read = readFileSync, timeoutMs = DEFAULT_TIMEOUT_MS, resync = false }) {
  const checks = [];
  const errors = [];
  const traces = [];
  validateManifest(flow.manifest, { dirName: flow.name });
  const specText = read(flow.specPath, "utf8");
  const configs = normalizeConfigs(flow.manifest);
  const cfgTexts = Object.create(null);
  for (const cfg of configs) cfgTexts[cfg.file] = read(join(flow.dir, cfg.file), "utf8");
  validateManifest(flow.manifest, { specText, cfgTexts, dirName: flow.name });

  if (!resync) {
    const stale = [];
    for (const entry of flow.manifest.covered) {
      const h = hashEntry(entry, read);
      if (!h.found || h.sha256 !== entry.sha256) stale.push(entry.file);
    }
    if (stale.length) {
      errors.push(`covered code changed: ${stale.join(", ")}. Run /maintain-formal-verification-skill on ${flow.name}, then pnpm formal --resync ${flow.name} (see docs/internals/formal-harness.md).`);
      return { checks, errors, traces };
    }
  }

  const flowTimeoutMs = flow.manifest.timeoutSeconds !== undefined
    ? Math.round(flow.manifest.timeoutSeconds * 1000)
    : timeoutMs;

  const multiConfig = flow.manifest.configs !== undefined;
  for (const cfg of configs) {
    const label = multiConfig ? `main (${cfg.file})` : "main";
    const main = runTlc(java, jar, flow.specPath, { configPath: join(flow.dir, cfg.file), spawnSync: spawnImpl, timeoutMs: flowTimeoutMs });
    const mainOutcome = runOutcome(main);
    if (mainOutcome.kind !== "pass") {
      errors.push(`${label} ${describeOutcome(mainOutcome)}`);
      traces.push({ flow: flow.name, check: label, output: `${main.stdout}\n${main.stderr}` });
      checks.push({ flow: flow.name, check: label, pass: false, states: distinctStates(main.stdout), seconds: main.seconds });
    } else {
      checks.push({ flow: flow.name, check: label, pass: true, states: distinctStates(main.stdout), seconds: main.seconds });
    }
  }
  if (errors.length > 0) return { checks, errors, traces };

  const cfgForRule = new Map();
  for (const cfg of configs) for (const id of cfg.rules) cfgForRule.set(id, cfg.file);

  for (const mutant of flow.manifest.mutants) {
    const rule = flow.manifest.rules.find((r) => r.id === mutant.breaks);
    const ownerFile = cfgForRule.get(rule.id);
    const cfg = generateMutantCfg(cfgTexts[ownerFile], mutant.id, rule);
    const run = runTlc(java, jar, flow.specPath, { configText: cfg, spawnSync: spawnImpl, timeoutMs: flowTimeoutMs });
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (args.flows !== undefined && (typeof args.flows !== "string" || !args.flows.trim())) {
    const msg = "--flows requires a directory path";
    err(`✗ formal: ${msg}`);
    return { code: 1, checks: [], errors: [msg] };
  }
  if (args.resync !== undefined && (typeof args.resync !== "string" || !args.resync.trim())) {
    const msg = "--resync requires a flow name";
    err(`✗ formal: ${msg}`);
    return { code: 1, checks: [], errors: [msg] };
  }

  const flowsDir = args.flows ?? opts.flowsDir ?? join(ROOT, "formal");

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
      const msg = e.message.startsWith(`${flow.name}:`) ? e.message : `${flow.name}: ${e.message}`;
      errors.push(msg);
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
