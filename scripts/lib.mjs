// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the Rose scripts. Node builtins only.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = join(ROOT, "apps/app");
export const ADMIN_DIR = join(ROOT, "apps/admin");
export const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
export const DB_NAME = "rose-control";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), magenta: paint(35), cyan: paint(36) };

export const info = (msg) => console.log(`${c.cyan("›")} ${msg}`);
export const ok = (msg) => console.log(`${c.green("✓")} ${msg}`);
export const warn = (msg) => console.log(`${c.yellow("!")} ${msg}`);
export function fail(msg) {
  console.error(`${c.red("✗")} ${msg}`);
  process.exit(1);
}

/** Parse `--flag value`, `--flag=value` and boolean `--flag`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** 32 random bytes, base64: the format ROSE_MASTER_KEY expects. */
export const newMasterKey = () => randomBytes(32).toString("base64");
export const newHexSecret = () => randomBytes(32).toString("hex");

/** Run a command, inherit output unless `capture`. Returns { status, stdout, stderr }. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: "utf8",
    stdio: opts.capture || opts.input !== undefined ? ["pipe", opts.capture ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit"] : "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (r.error) return { status: 1, stdout: "", stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Path of a locally installed binary (wrangler, vite) for a workspace package. */
export function bin(pkgDir, name) {
  const p = join(pkgDir, "node_modules/.bin", name);
  if (!existsSync(p)) fail(`${name} is not installed. Run \`pnpm install\` first.`);
  return p;
}

export function spawnChild(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, FORCE_COLOR: tty ? "1" : "0", ...opts.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
}

function readVars(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export const readDevVars = readVars;

function writeVars(file, vars) {
  writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

/**
 * Make sure both workers have local development variables. Existing values are kept
 * (so local data stays decryptable); only missing keys are added.
 */
export function ensureDevVars({ adminEmail } = {}) {
  const appFile = join(APP_DIR, ".dev.vars");
  const adminFile = join(ADMIN_DIR, ".dev.vars");
  const app = readVars(appFile);
  const admin = readVars(adminFile);
  const created = !existsSync(appFile) || !existsSync(adminFile);
  const nextApp = {
    ENVIRONMENT: "development",
    APP_BASE_DOMAIN: "localhost",
    ROSE_MASTER_KEY: newMasterKey(),
    UPSTREAM_SIGNING_SECRET: newHexSecret(),
    ...app,
  };
  const nextAdmin = {
    ENVIRONMENT: "development",
    APP_BASE_DOMAIN: "localhost",
    APP_URL_TEMPLATE: "http://{host}:5174",
    ROSE_MASTER_KEY: newMasterKey(),
    BOOTSTRAP_OPERATOR_EMAIL: "admin@example.com",
    ...admin,
  };
  if (adminEmail) nextAdmin.BOOTSTRAP_OPERATOR_EMAIL = adminEmail.trim().toLowerCase();
  if (nextApp.APP_NAME && !nextAdmin.APP_NAME) nextAdmin.APP_NAME = nextApp.APP_NAME;
  writeVars(appFile, nextApp);
  writeVars(adminFile, nextAdmin);
  return { created, adminEmail: nextAdmin.BOOTSTRAP_OPERATOR_EMAIL };
}

export function ensureDistDirs() {
  for (const d of [APP_DIR, ADMIN_DIR]) mkdirSync(join(d, "dist/client"), { recursive: true });
}

export function applyLocalMigrations() {
  const r = run(bin(APP_DIR, "wrangler"), ["d1", "migrations", "apply", DB_NAME, "--local", "--persist-to", "../../.wrangler/state"], { cwd: APP_DIR, capture: true, env: { CI: "1" } });
  if (r.status !== 0) fail(`Applying local migrations failed:\n${r.stdout}\n${r.stderr}`);
}

export function installGitHooks() {
  if (!existsSync(join(ROOT, ".git"))) return false;
  return run("git", ["config", "core.hooksPath", ".githooks"], { capture: true }).status === 0;
}

// ── wrangler.jsonc editing that keeps comments ──────────────────────────────────

/** Replace the value of a string property inside the `"vars"` object, or add it. */
export function setVar(text, key, value) {
  const vars = /("vars"\s*:\s*\{)([\s\S]*?)(\n\s*\})/.exec(text);
  if (!vars) throw new Error('No "vars" block found');
  let body = vars[2];
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (re.test(body)) body = body.replace(re, (_, pre) => `${pre}${JSON.stringify(value)}`);
  else body = body.replace(/\s*$/, "") + `,\n    "${key}": ${JSON.stringify(value)}`;
  return text.slice(0, vars.index) + vars[1] + body + vars[3] + text.slice(vars.index + vars[0].length);
}

export function setDatabaseId(text, id) {
  if (!/"database_id"\s*:\s*"[^"]*"/.test(text)) throw new Error("No database_id found");
  return text.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`);
}

/** Insert or replace the top-level `"routes"` array (placed right after `"main"`). */
export function setRoutes(text, routes) {
  const line = `  "routes": ${JSON.stringify(routes).replace(/\{/g, "{ ").replace(/\}/g, " }").replace(/","/g, '", "').replace(/":"/g, '": "').replace(/\},\{/g, "}, {")},`;
  if (/^\s*"routes"\s*:\s*\[.*\],?\s*$/m.test(text)) return text.replace(/^\s*"routes"\s*:\s*\[.*\],?\s*$/m, line);
  if (!/^\s*"main"\s*:.*$/m.test(text)) throw new Error('No "main" line found');
  return text.replace(/^(\s*"main"\s*:.*)$/m, `$1\n${line}`);
}

export const readText = (p) => readFileSync(p, "utf8");
export const writeText = (p, s) => writeFileSync(p, s);
