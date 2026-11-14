#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Rose guard: static guardrails that keep the security model intact while people and AI
// agents build on the kit. Dependency-free and fast enough to run on every edit.
//
//   node scripts/guard.mjs                 check the whole repository
//   node scripts/guard.mjs --quick a b     check only these files (used by editor/agent hooks)
//   node scripts/guard.mjs --json          machine-readable output
//
// An exception is possible with a comment on the same or the previous line:
//     // guard-allow: <rule-id> <reason>
// Exceptions are counted and listed on every run so reviewers always see them.
//
// These are tripwires, not proofs. The real guarantees come from the type system
// (modules get no `env`), the per-tenant database, and the isolation test suite.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPDX = "SPDX-License-Identifier: Apache-2.0";

// ── Rule catalogue: every rule explains itself ─────────────────────────────────────
export const RULES = {
  "raw-sql": {
    why: "Control-plane SQL is cross-tenant by nature. It lives only in packages/core, where every query is reviewed and tested for tenant scoping.",
    fix: "Call a function from @rose/core (tenant app) or @rose/core/platform (admin worker). If none fits, propose a new repository function in packages/core (protected: needs human approval).",
  },
  "module-env": {
    why: "Modules must not reach bindings. A module that can touch `env` can open any tenant's database or the control plane, bypassing isolation.",
    fix: "Use only what ModuleContext gives you: ctx.db (this tenant's database), ctx.crypto(), ctx.audit(), ctx.enqueue(), ctx.req.",
  },
  "tenant-binding": {
    why: "Addressing tenant storage directly (TENANT_DO, idFromName, storage.sql) is how one tenant's data gets served to another. Only packages/core may do it.",
    fix: "Use TenantDb via ctx.db inside a module. Outside modules, add the capability to packages/core.",
  },
  "cf-workers-import": {
    why: "`cloudflare:workers` exposes the global env and Durable Object base classes, which sidestep the tenant-bound context.",
    fix: "Import from @rose/core instead. Only packages/core and apps/app/worker/index.ts may import cloudflare:workers.",
  },
  "platform-import": {
    why: "@rose/core/platform is the cross-tenant operator API and core internals are not a public API. The tenant app, its modules and the UI must never import them.",
    fix: 'Import from "@rose/core" only. Operator features belong in apps/admin.',
  },
  "module-structure": {
    why: "Every module must be registered, declare an isolationProbe and have tests, so the tenant-isolation contract covers it automatically.",
    fix: "See docs/adding-a-module.md: defineModule({ …, isolationProbe }), register it in apps/app/worker/modules/index.ts, add <id>.test.ts next to it.",
  },
  "sql-interpolation": {
    why: "Values interpolated into SQL text are SQL injection. Inside a tenant database that still means data loss or a permission bypass.",
    fix: 'Bind values with `?` parameters. For a sort column use orderBy(sort, allowlist, fallback) and name the result `order`. For dynamic filters build constant fragments + bound args and name the result `w` ({ sql, args }). For IN lists use ids.map(() => "?").join(",").',
  },
  "list-limit": {
    why: "No endpoint may return unbounded data: it is a denial-of-service and a data-exfiltration amplifier, and the UI contract is server-side pagination.",
    fix: "Add `LIMIT ? OFFSET ?` using ctx.req.list() (page size is capped at 100 by the platform), or a constant LIMIT of at most 100.",
  },
  "forbidden-api": {
    why: "These APIs execute or inject arbitrary strings (XSS / code injection) and are blocked by the Content-Security-Policy anyway.",
    fix: "Render text through React. Never build HTML or code from strings.",
  },
  "insecure-random": {
    why: "Math.random() is predictable. Ids, tokens and codes generated with it can be guessed.",
    fix: "Use newId(), randomToken() from @rose/core, or crypto.getRandomValues().",
  },
  "log-sensitive": {
    why: "Worker logs are retained and widely readable. Tokens, codes, keys and passwords must never be written to them.",
    fix: "Log an id or a boolean instead of the value. (The only exception is the development mailbox in packages/core/src/email.ts.)",
  },
  "storage-sensitive": {
    why: "Web storage is readable by any script on the page. Sessions live in HttpOnly cookies set by the server; nothing secret is kept in the browser.",
    fix: "Do not store credentials client-side. Keep only UI preferences (theme, nav state) in localStorage.",
  },
  "ui-external-fetch": {
    why: "The UI talks only to its own API (the CSP enforces connect-src 'self'). Third-party calls are made by the worker, where secrets and validation live.",
    fix: "Add an endpoint to the worker and call it through the api client.",
  },
  "target-blank": {
    why: 'A new tab without rel="noopener" can navigate the page that opened it (reverse tabnabbing).',
    fix: 'Use the ExternalLink component, or add rel="noopener noreferrer".',
  },
  "admin-isolation": {
    why: "The operator console must have no path to tenant data: no tenant database binding and no tenant key. A stolen operator session then can not read customer data.",
    fix: "Remove the binding from apps/admin/wrangler.jsonc. Tenant data operations run in the tenant worker (e.g. as a background job).",
  },
  "deployment-values": {
    why: "A public repo that names the production database, domains or bootstrap operator mailbox tells an attacker exactly what to target.",
    fix: "Keep placeholders in apps/*/wrangler.jsonc (database_id all zeros, example.com hosts and addresses). `pnpm setup --production` writes real values to the git-ignored wrangler.production.jsonc.",
  },
  csp: {
    why: "The Content-Security-Policy is the last line of defence against XSS. Inline or eval'd script must stay blocked.",
    fix: "Keep script-src 'self' with no 'unsafe-inline'/'unsafe-eval' in apps/*/public/_headers. Put scripts in files.",
  },
  "secret-in-repo": {
    why: "Anything committed is public forever in an open-source repository.",
    fix: "Remove it, rotate the secret, and keep secrets in .dev.vars (git-ignored) locally and `wrangler secret put` in production.",
  },
  spdx: {
    why: "The project is Apache-2.0; each source file carries the SPDX identifier so reuse stays unambiguous.",
    fix: `Add "// ${SPDX}" (or the -- / # / /* */ equivalent) as the first line.`,
  },
};

// ── File classification ────────────────────────────────────────────────────────────
const SOURCE_EXT = /\.(ts|tsx|js|mjs|jsx)$/;
const SPDX_EXT = /\.(ts|tsx|js|mjs|jsx|sql|css)$/;
const isTest = (f) => /\.test\.(ts|tsx|mjs|js)$/.test(f) || /(^|\/)test\//.test(f) || /(^|\/)testing\//.test(f);
const inCore = (f) => f.startsWith("packages/core/");
const isGuardFile = (f) => /^scripts\/guard(\.test)?\.mjs$/.test(f) || f.startsWith(".claude/hooks/");
const isModuleFile = (f) => f.startsWith("apps/app/worker/modules/") && f !== "apps/app/worker/modules/index.ts";
const isWorker = (f) => /^apps\/[^/]+\/worker\//.test(f);
const isWeb = (f) => /^apps\/[^/]+\/web\//.test(f) || f.startsWith("packages/ui/");

/** Test fixtures that look like secrets but are public by design. */
const ALLOWED_SECRET_LITERALS = new Set([
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
  "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
]);

// ── A small scanner: separates code, comments and string literals ──────────────────
/**
 * Returns `code` (the source with comments blanked out, line structure preserved) and
 * `literals` (every string/template literal with its interpolated expressions).
 */
export function scan(src) {
  const out = src.split("");
  const literals = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const prevSignificant = (pos) => {
    let k = pos - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    return k >= 0 ? src[k] : "";
  };

  function readTemplate(start) {
    // src[start] === "`"
    let k = start + 1;
    let text = "";
    const exprs = [];
    const startLine = line;
    while (k < n && src[k] !== "`") {
      if (src[k] === "\\") {
        text += src.slice(k, k + 2);
        k += 2;
        continue;
      }
      if (src[k] === "$" && src[k + 1] === "{") {
        let depth = 1;
        let e = k + 2;
        while (e < n && depth > 0) {
          const ch = src[e];
          if (ch === "`") {
            const saved = line;
            e = readTemplate(e).end;
            line = saved;
            continue;
          }
          if (ch === '"' || ch === "'") {
            e = skipQuoted(e);
            continue;
          }
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          e++;
        }
        exprs.push(src.slice(k + 2, e - 1).trim());
        text += "${}";
        k = e;
        continue;
      }
      text += src[k];
      k++;
    }
    return { end: k + 1, text, exprs, startLine };
  }
  function skipQuoted(start) {
    const q = src[start];
    let k = start + 1;
    while (k < n && src[k] !== q && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
    return k + 1;
  }

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === "/" && next === "/") {
      let e = i;
      while (e < n && src[e] !== "\n") e++;
      blank(i, e);
      i = e;
    } else if (ch === "/" && next === "*") {
      let e = src.indexOf("*/", i + 2);
      e = e < 0 ? n : e + 2;
      blank(i, e);
      for (let k = i; k < e; k++) if (src[k] === "\n") line++;
      i = e;
    } else if (ch === '"' || ch === "'") {
      const e = skipQuoted(i);
      literals.push({ kind: "string", start: i, line, text: src.slice(i + 1, e - 1), exprs: [] });
      i = e;
    } else if (ch === "`") {
      const t = readTemplate(i);
      literals.push({ kind: "template", start: i, line, text: t.text, exprs: t.exprs });
      for (let k = i; k < t.end; k++) if (src[k] === "\n") line++;
      i = t.end;
    } else if (ch === "/" && "(,=:[!&|?{};\n".includes(prevSignificant(i) || "\n")) {
      // Regular-expression literal: skip it so quotes inside do not start a string.
      let e = i + 1;
      let inClass = false;
      while (e < n && src[e] !== "\n" && (inClass || src[e] !== "/")) {
        if (src[e] === "\\") e++;
        else if (src[e] === "[") inClass = true;
        else if (src[e] === "]") inClass = false;
        e++;
      }
      i = e + 1;
    } else i++;
  }
  return { code: out.join(""), literals };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// ── File-level checks ──────────────────────────────────────────────────────────────
const SQL_WORD = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|ORDER BY|VALUES)\b/;
const SAFE_SQL_EXPR = [
  /^(w|where|filter)\.sql$/, // { sql, args } built from constant fragments
  /^(order|orderSql)$/, // result of orderBy(sort, allowlist, fallback)
  /^(marks|placeholders)$/, // "?,?,?" built from an array length
  /^[\w.?]+\.map\(\(\) => "\?"\)\.join\(", ?"\)$/, // ids.map(() => "?").join(",")
  /^\w+\.join\(" (AND|OR) "\)$/, // parts.join(" AND ") of constant fragments
  /^\w+\.length \? `WHERE \$\{\w+\.join\(" AND "\)\}` : ""$/,
];

function patternRule(violations, file, codeLines, rule, regex, message) {
  codeLines.forEach((l, idx) => {
    if (regex.test(l)) violations.push({ rule, file, line: idx + 1, message: typeof message === "function" ? message(l) : message });
  });
}

/** All per-file rules. `file` is repo-relative with forward slashes. */
export function checkFile(file, text) {
  const v = [];
  const isSource = SOURCE_EXT.test(file);

  if (SPDX_EXT.test(file) && !text.split("\n").slice(0, 3).join("\n").includes(SPDX)) {
    v.push({ rule: "spdx", file, line: 1, message: "Missing SPDX license header." });
  }

  // Secrets: any text file.
  if (!/(^|\/)(pnpm-lock\.yaml|guard\.lock\.json)$/.test(file) && !isGuardFile(file)) {
    const lines = text.split("\n");
    lines.forEach((l, idx) => {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l)) v.push({ rule: "secret-in-repo", file, line: idx + 1, message: "Private key material." });
      for (const m of l.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g)) {
        if (!ALLOWED_SECRET_LITERALS.has(m[0])) v.push({ rule: "secret-in-repo", file, line: idx + 1, message: "Looks like a base64-encoded 256-bit key." });
      }
      if (/\b(re_[A-Za-z0-9]{24,}|sk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(l)) {
        v.push({ rule: "secret-in-repo", file, line: idx + 1, message: "Looks like a live API token." });
      }
      if (/(?:ROSE_MASTER_KEY|UPSTREAM_SIGNING_SECRET|RESEND_API_KEY|API_TOKEN)\s*[=:]\s*["']?[0-9a-f]{64}\b/.test(l)) {
        v.push({ rule: "secret-in-repo", file, line: idx + 1, message: "Looks like a hex secret assigned to a secret variable." });
      }
    });
  }

  if (/^apps\/[^/]+\/public\/_headers$/.test(file)) {
    const csp = /Content-Security-Policy:\s*(.*)/i.exec(text)?.[1];
    if (!csp) v.push({ rule: "csp", file, line: 1, message: "No Content-Security-Policy header." });
    else {
      const line = lineOf(text, text.indexOf(csp));
      const script = /script-src([^;]*)/.exec(csp)?.[1] ?? /default-src([^;]*)/.exec(csp)?.[1] ?? "";
      if (!/script-src/.test(csp)) v.push({ rule: "csp", file, line, message: "CSP has no script-src directive." });
      if (/unsafe-inline|unsafe-eval|\*|https?:|data:/.test(script)) v.push({ rule: "csp", file, line, message: "script-src must be exactly 'self' (no unsafe-inline, unsafe-eval, wildcards or remote hosts)." });
      if (!/frame-ancestors 'none'/.test(csp)) v.push({ rule: "csp", file, line, message: "CSP must keep frame-ancestors 'none' (clickjacking)." });
    }
  }

  if (/^apps\/[^/]+\/wrangler\.jsonc$/.test(file)) {
    const { code } = scan(text);
    const bad = (idx, message) => v.push({ rule: "deployment-values", file, line: idx + 1, message });
    // Match across the whole text so a value on the line after its key is still seen.
    const lineAt = (i) => code.slice(0, i).split("\n").length - 1;
    for (const m of code.matchAll(/"database_id"\s*:\s*"([^"]*)"/g)) {
      if (m[1] !== "00000000-0000-0000-0000-000000000000") bad(lineAt(m.index), "database_id must be the all-zero placeholder.");
    }
    for (const m of code.matchAll(/"(?:APP_BASE_DOMAIN|BOOTSTRAP_OPERATOR_EMAIL|EMAIL_FROM|pattern|zone_name)"\s*:\s*"([^"]*)"/g)) {
      const hosts = m[1].match(/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      if (hosts.some((h) => h !== "example.com" && !h.endsWith(".example.com"))) bad(lineAt(m.index), "Deployment domain or address must use the example.com placeholder.");
    }
  }

  if (file === "apps/admin/wrangler.jsonc") {
    const { code } = scan(text);
    code.split("\n").forEach((l, idx) => {
      if (/durable_objects|TENANT_DO|dispatch_namespaces/.test(l)) v.push({ rule: "admin-isolation", file, line: idx + 1, message: "The operator worker must not bind tenant storage." });
    });
  }

  if (!isSource || isGuardFile(file)) return applyAllows(v, text);

  const { code, literals } = scan(text);
  const codeLines = code.split("\n");
  const test = isTest(file);

  if (!inCore(file) && !test && !file.startsWith("scripts/") && !file.startsWith("examples/")) {
    patternRule(v, file, codeLines, "raw-sql", /\.prepare\s*\(/, "Raw `.prepare(` outside packages/core.");
  }
  if (isModuleFile(file) && !test) {
    patternRule(v, file, codeLines, "module-env", /(^|[^\w.])(c\.)?env\s*[.[]|\bprocess\.env\b|\bglobalThis\s*\.\s*env\b|\bexecutionCtx\b/, "Module code touches `env`/bindings.");
    patternRule(v, file, codeLines, "module-env", /from\s+["']cloudflare:|import\(\s*["']cloudflare:/, "Module imports a cloudflare: runtime module.");
    patternRule(v, file, codeLines, "module-env", /(^|[^\w.])fetch\s*\(/, "Module makes an outbound fetch (SSRF / data exfiltration path). Do it in packages/core behind review, or guard-allow with the fixed destination.");
  }
  if ((file.startsWith("apps/") || file.startsWith("packages/ui/")) && !test) {
    patternRule(v, file, codeLines, "tenant-binding", /\bTENANT_DO\b|\bidFromName\b|\bidFromString\b|\bstorage\s*\.\s*sql\b|\bDISPATCHER\b/, "Direct access to tenant storage bindings.");
  }
  if (!inCore(file) && file !== "apps/app/worker/index.ts" && !file.startsWith("examples/")) {
    patternRule(v, file, codeLines, "cf-workers-import", /["']cloudflare:workers["']/, "Import of cloudflare:workers.");
  }
  if (file.startsWith("apps/app/") || file.startsWith("packages/ui/") || /^apps\/[^/]+\/web\//.test(file)) {
    patternRule(v, file, codeLines, "platform-import", /["']@rose\/core\/platform["']/, "Import of the cross-tenant operator API.");
  }
  if (!inCore(file) && !(test && file.startsWith("apps/admin/"))) {
    patternRule(v, file, codeLines, "platform-import", /["'](@rose\/core\/src\/[^"']*|[^"']*packages\/core\/src\/[^"']*)["']/, "Deep import into packages/core internals.");
  }

  // SQL built from strings.
  if (isWorker(file) && !test) {
    for (const lit of literals) {
      if (lit.kind !== "template" || lit.exprs.length === 0 || !SQL_WORD.test(lit.text)) continue;
      for (const expr of lit.exprs) {
        if (!SAFE_SQL_EXPR.some((re) => re.test(expr))) v.push({ rule: "sql-interpolation", file, line: lit.line, message: `SQL text interpolates \`\${${expr.length > 60 ? `${expr.slice(0, 57)}…` : expr}}\`.` });
      }
    }
    codeLines.forEach((l, idx) => {
      if (/["'`][^"'`]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE)\b[^"'`]*["'`]\s*\+|\+\s*["'`]\s*(WHERE|AND|OR|ORDER BY|LIMIT)\b/.test(l)) {
        v.push({ rule: "sql-interpolation", file, line: idx + 1, message: "SQL text built by string concatenation." });
      }
    });
    // Unbounded lists.
    for (const lit of literals) {
      if (!/^\s*SELECT\b/.test(lit.text)) continue;
      const before = code.slice(Math.max(0, lit.start - 160), lit.start);
      const isList = /\.all\s*(<[^()]*>)?\s*\(\s*$/.test(before) || /\bsql\s*:\s*$/.test(before);
      if (!isList) continue;
      const aggregate = /\bGROUP BY\b/.test(lit.text) || /^\s*SELECT\s+COUNT\s*\(/.test(lit.text);
      const limit = /\bLIMIT\s+(\?|\d+)/.exec(lit.text);
      if (!limit && !aggregate) v.push({ rule: "list-limit", file, line: lit.line, message: "List query without LIMIT." });
      else if (limit && limit[1] !== "?" && Number(limit[1]) > 100) v.push({ rule: "list-limit", file, line: lit.line, message: `LIMIT ${limit[1]} exceeds the maximum page size of 100.` });
    }
  }

  if (!test) {
    patternRule(v, file, codeLines, "forbidden-api", /\bdangerouslySetInnerHTML\b|\.(innerHTML|outerHTML)\s*=[^=]|\binsertAdjacentHTML\s*\(|(^|[^\w.])eval\s*\(|\bnew\s+Function\s*\(|\bdocument\s*\.\s*write(ln)?\s*\(/, "Use of an HTML/code injection API.");
  }
  if ((file.startsWith("packages/core/src/") || isWorker(file)) && !test) {
    patternRule(v, file, codeLines, "insecure-random", /\bMath\s*\.\s*random\s*\(/, "Math.random() in security-relevant code.");
  }
  if ((inCore(file) || isWorker(file)) && !test && file !== "packages/core/src/email.ts") {
    patternRule(v, file, codeLines, "log-sensitive", /\bconsole\s*\.\s*(log|info|debug|warn|error)\s*\((?=[^\n]*\b(\w*[tT]oken\w*|\w*[sS]ecret\w*|\w*[pP]assword\w*|code|devCode|\w*[kK]ey|dek|cookie)\b(?!["'`:]))/, "Possible secret written to logs.");
  }
  if (isWeb(file) && !test) {
    patternRule(v, file, codeLines, "storage-sensitive", /\b(localStorage|sessionStorage)\s*\.\s*(setItem|getItem)\s*\(\s*["'`][^"'`]*(token|session|secret|password|apikey|api[_-]key|credential|jwt)/i, "Credential-like value in web storage.");
    patternRule(v, file, codeLines, "storage-sensitive", /\bdocument\s*\.\s*cookie\b/, "Reading or writing cookies from script. Sessions are HttpOnly and managed by the server.");
    patternRule(v, file, codeLines, "ui-external-fetch", /\b(fetch|EventSource|WebSocket|sendBeacon)\s*\(\s*["'`](https?:|wss?:)?\/\//, "UI calls an absolute URL.");
    for (const m of code.matchAll(/target\s*=\s*(\{\s*)?["']_blank["']/g)) {
      const line = lineOf(code, m.index);
      // Look at the surrounding element (a few lines either side) for rel="…noopener…".
      const around = codeLines.slice(Math.max(0, line - 4), line + 4).join("\n");
      if (!/rel\s*=\s*(\{\s*)?["'][^"']*noopener/.test(around)) v.push({ rule: "target-blank", file, line, message: 'target="_blank" without rel="noopener".' });
    }
  }
  return applyAllows(v, text);
}

function applyAllows(violations, text) {
  const lines = text.split("\n");
  const allowed = [];
  const kept = [];
  for (const viol of violations) {
    const here = lines[viol.line - 1] ?? "";
    const prev = lines[viol.line - 2] ?? "";
    const m = [here, prev].map((l) => /guard-allow:\s*([\w-]+)\s+(\S.*)/.exec(l)).find((x) => x && x[1] === viol.rule);
    if (m) allowed.push({ ...viol, reason: m[2].replace(/\*\/\s*$/, "").trim() });
    else kept.push(viol);
  }
  return { violations: kept, allowed };
}

// ── Repository-level checks ────────────────────────────────────────────────────────
function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter((f) => f && existsSync(join(ROOT, f)));
  } catch {
    const acc = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", "dist", ".git", ".wrangler", ".rose", "coverage"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else acc.push(relative(ROOT, p).split(sep).join("/"));
      }
    };
    walk(ROOT);
    return acc;
  }
}

const isBinary = (f) => /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz|sqlite)$/i.test(f);
const read = (f) => readFileSync(join(ROOT, f), "utf8");

export function checkStructure(files, readFile = read) {
  const v = [];
  const has = (f) => files.includes(f);
  const manifest = "apps/app/worker/modules/index.ts";
  const iso = "apps/app/worker/test/isolation.test.ts";
  if (!has(iso)) v.push({ rule: "module-structure", file: iso, line: 1, message: "The tenant-isolation suite is missing." });
  else {
    const t = scan(readFile(iso)).code;
    if (!/describeTenantIsolation\s*\(\s*env\s*,\s*SELF\s*,\s*modules\s*\)/.test(t)) v.push({ rule: "module-structure", file: iso, line: 1, message: "Must call describeTenantIsolation(env, SELF, modules) on the full module manifest." });
    if (/\.(skip|only|todo)\b/.test(t)) v.push({ rule: "module-structure", file: iso, line: 1, message: "Isolation tests must not be skipped or focused." });
  }
  if (!has(manifest)) {
    v.push({ rule: "module-structure", file: manifest, line: 1, message: "Module manifest is missing." });
    return v;
  }
  const manifestCode = scan(readFile(manifest)).code + readFile(manifest).match(/from\s+["'][^"']+["']/g)?.join("\n");
  const dirs = new Set(files.filter((f) => /^apps\/app\/worker\/modules\/[^/]+\//.test(f)).map((f) => f.split("/")[4]));
  for (const id of dirs) {
    const base = `apps/app/worker/modules/${id}`;
    const index = `${base}/index.ts`;
    if (!has(index)) {
      v.push({ rule: "module-structure", file: base, line: 1, message: "Module folder has no index.ts." });
      continue;
    }
    const code = scan(readFile(index)).code;
    if (!/\bdefineModule\s*\(/.test(code)) v.push({ rule: "module-structure", file: index, line: 1, message: "Module must be created with defineModule()." });
    if (!/\bisolationProbe\s*:/.test(code)) v.push({ rule: "module-structure", file: index, line: 1, message: "Module must declare an isolationProbe." });
    if (!new RegExp(`from\\s+["']\\./${id}(/index)?["']`).test(manifestCode)) v.push({ rule: "module-structure", file: index, line: 1, message: `Module "${id}" is not registered in ${manifest}.` });
    if (!files.some((f) => f.startsWith(`${base}/`) && /\.test\.ts$/.test(f))) v.push({ rule: "module-structure", file: index, line: 1, message: "Module has no test file next to it." });
  }
  // Tests anywhere must not be silently disabled in the security suites.
  for (const f of files.filter((x) => /^packages\/core\/test\/.*\.test\.ts$/.test(x))) {
    const t = scan(readFile(f)).code;
    const m = /\b(it|test|describe)\s*\.\s*(skip|only|todo)\b/.exec(t);
    if (m) v.push({ rule: "module-structure", file: f, line: lineOf(t, m.index), message: "Security tests must not be skipped or focused." });
  }
  return v;
}

function trackedSecretsFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter((f) => /(^|\/)(\.dev\.vars(\..*)?|\.env(\..*)?)$/.test(f) && !/\.example$/.test(f));
  } catch {
    return [];
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────────
function report(violations, allowed, { json, scope }) {
  if (json) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations, allowed }, null, 2));
    return;
  }
  const err = (s) => process.stderr.write(`${s}\n`);
  if (violations.length) {
    const byRule = new Map();
    for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
    err(`\nguard: ${violations.length} problem(s) found${scope ? ` in ${scope}` : ""}\n`);
    for (const [rule, list] of byRule) {
      err(`✗ ${rule}`);
      for (const v of list) err(`    ${v.file}:${v.line}  ${v.message}`);
      err(`  Why: ${RULES[rule].why}`);
      err(`  Fix: ${RULES[rule].fix}\n`);
    }
  }
  if (allowed.length) {
    const out = violations.length ? err : console.log;
    out(`guard: ${allowed.length} explicit exception(s) (guard-allow):`);
    for (const a of allowed) out(`    ${a.file}:${a.line}  ${a.rule}: ${a.reason}`);
  }
  if (!violations.length) console.log(`guard: ok${scope ? ` (${scope})` : ""}`);
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const files = listFiles();

  const violations = [];
  const allowed = [];
  const quickAt = argv.indexOf("--quick");
  if (quickAt >= 0) {
    const targets = argv.slice(quickAt + 1).filter((a) => !a.startsWith("--")).map((a) => relative(ROOT, resolve(a)).split(sep).join("/"));
    for (const f of targets) {
      if (f.startsWith("..") || !existsSync(join(ROOT, f)) || isBinary(f) || /(^|\/)(node_modules|dist|\.wrangler)\//.test(f)) continue;
      const r = checkFile(f, read(f));
      violations.push(...r.violations);
      allowed.push(...r.allowed);
    }
    report(violations, allowed, { json, scope: targets.join(", ") || "no files" });
    process.exit(violations.length ? 1 : 0);
  }

  for (const f of files) {
    if (isBinary(f)) continue;
    const r = checkFile(f, read(f));
    violations.push(...r.violations);
    allowed.push(...r.allowed);
  }
  violations.push(...checkStructure(files));
  for (const f of trackedSecretsFiles()) violations.push({ rule: "secret-in-repo", file: f, line: 1, message: "Secrets file is tracked by git. Run `git rm --cached` and rotate what it contained." });
  report(violations, allowed, { json });
  process.exit(violations.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
