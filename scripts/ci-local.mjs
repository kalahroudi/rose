#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm ci:local` — run both jobs of .github/workflows/ci.yml on this machine, in CI order,
// against a clean checkout of HEAD. GitHub Actions minutes become optional.
//
//   pnpm ci:local                      both jobs, in a throwaway worktree at HEAD
//   pnpm ci:local --job verify         one job
//   pnpm ci:local --here               run in the current tree (may be dirty)
//   pnpm ci:local --keep               keep the worktree for debugging
//   pnpm ci:local --report             post a `local-ci` commit status with gh (opt-in)
//
// scripts/ci-local.test.mjs fails when ci.yml gains a `run:` command that STEPS does not run.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const LOG_DIR = join(ROOT, ".rose", "ci-local");
export const PORTS = [5173, 5174, 8787];

/** Checks that still skip on the local dev stack. Each Q22 change removes its ids from this list. */
export const ALLOWED_SKIPS = ["AUTH-08", "ADM-05", "ADM-05b", "ADM-06", "GW-01", "HARD-01", "HARD-05", "INT-03", "AUTH-09"];
/** ci.yml's `pnpm pentest`, run with the ids above so that an unexpected skip fails the job. */
export const PENTEST_COMMAND = `pnpm pentest --strict${ALLOWED_SKIPS.map((id) => ` --allow-skip ${id}`).join("")}`;

/** One entry per `run:` command in ci.yml, in ci.yml order. `native` steps are implemented here. */
export const STEPS = [
  { job: "verify", name: "Install", run: "pnpm install --frozen-lockfile" },
  { job: "verify", name: "Guardrails", run: "pnpm guard" },
  { job: "verify", name: "Lint", run: "pnpm lint" },
  { job: "verify", name: "Dead code", run: "pnpm knip" },
  { job: "verify", name: "Guard self-tests (with coverage)", run: "pnpm test:scripts:coverage" },
  { job: "verify", name: "Typecheck", run: "pnpm typecheck" },
  { job: "verify", name: "Tests", run: "pnpm test:coverage" },
  { job: "verify", name: "Build", run: "pnpm build" },
  { job: "pentest", name: "Install", run: "pnpm install --frozen-lockfile" },
  { job: "pentest", name: "Start the local stack", native: "dev-stack" },
  { job: "pentest", name: "Attack it", run: PENTEST_COMMAND },
  { job: "pentest", name: "Stop the local stack", native: "dev-stack-stop" },
];

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (a === "--here" || a === "--keep" || a === "--report") out[a.slice(2)] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    }
  }
  if (out.job !== undefined && out.job !== "verify" && out.job !== "pentest") throw new Error("--job takes verify or pentest");
  return out;
}

/** Run a command with inherited output; resolves to its exit code. */
function runStep(command, cwd) {
  console.log(dim(`\n$ ${command}`));
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit", env: { ...process.env, FORCE_COLOR: tty ? "1" : "0" } });
    child.on("error", () => done(1));
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

function git(args, cwd = ROOT) {
  return new Promise((done) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => done({ code: 1, out: "", err: "git is not installed" }));
    child.on("exit", (code) => done({ code: code ?? 1, out, err }));
  });
}

async function headSha() {
  const r = await git(["rev-parse", "HEAD"]);
  if (r.code !== 0) throw new Error(`git rev-parse HEAD failed: ${r.err.trim()}`);
  return r.out.trim();
}

// ── Ports ────────────────────────────────────────────────────────────────────
/** Something listening on the port, with its PID when lsof reports one; null when free. */
function listener(port) {
  return new Promise((done) => {
    const child = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done(null)); // no lsof (Windows): treat as free rather than block the run
    child.on("exit", () => {
      const line = out.split("\n").find((l) => l.trim() && !l.startsWith("COMMAND"));
      done(line ? { pid: line.trim().split(/\s+/)[1] } : null);
    });
  });
}

async function assertPortsFree() {
  const busy = [];
  for (const port of PORTS) {
    const l = await listener(port);
    if (l) busy.push(`port ${port} is already in use${l.pid ? ` by PID ${l.pid}` : ""}`);
  }
  if (busy.length) throw new Error(`${busy.join("; ")}. Stop it before running the pentest job. This runner never kills processes it did not start.`);
}

// ── Dev stack (native form of ci.yml's "Start the local stack") ───────────────
let devStack = null;

function startDevStack(cwd, logDir) {
  const devLog = join(logDir, "dev.log");
  console.log(dim(`\n$ node scripts/dev.mjs > ${devLog} 2>&1 &`));
  rmSync(devLog, { force: true });
  mkdirSync(logDir, { recursive: true });
  devStack = spawn(process.execPath, ["scripts/dev.mjs"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = (d) => appendFileSync(devLog, d);
  devStack.stdout.on("data", log);
  devStack.stderr.on("data", log);
  devStack.on("exit", () => (devStack = null));
}

async function stopDevStack() {
  const child = devStack;
  if (!child) return;
  devStack = null;
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal); // process group: also stops workerd/esbuild
    } catch {}
  };
  kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  kill("SIGKILL");
  child.unref();
}

/** ci.yml's readiness check: the tenant app serves `"root"` and the console answers 2xx. */
async function waitForStack(logDir) {
  const deadline = Date.now() + 90_000;
  const get = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { status: res.status, body: await res.text() };
    } catch {
      return null;
    }
  };
  while (Date.now() < deadline) {
    if (!devStack) throw new Error(`the local stack exited early:\n${readLog(logDir)}`);
    const app = await get("http://localhost:5174/api/bootstrap");
    if (app && app.body.includes('"root"')) {
      const admin = await get("http://localhost:5173/api/bootstrap");
      if (admin && admin.status >= 200 && admin.status < 300) {
        console.log(green("✓ the local stack is up"));
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the local stack did not come up within 90s:\n${readLog(logDir)}`);
}

function readLog(logDir) {
  try {
    return readFileSync(join(logDir, "dev.log"), "utf8").slice(-2000);
  } catch {
    return "(no log)";
  }
}

// ── Report (opt-in) ──────────────────────────────────────────────────────────
async function report(sha, ok, result) {
  const statusPath = `repos/{owner}/{repo}/statuses/${sha}`;
  const repo = await new Promise((done) => {
    const child = spawn("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done(null));
    child.on("exit", (code) => done(code === 0 ? out.trim() : null));
  });
  if (!repo) return console.log(yellow("! --report skipped: gh is missing or not signed in"));
  const elapsed = Math.round(result.reduce((s, r) => s + r.seconds, 0));
  const args = ["api", statusPath.replace("{owner}/{repo}", repo), "-f", `state=${ok ? "success" : "failure"}`, "-f", "context=local-ci", "-f", `description=${result.length} steps, ${elapsed}s`];
  const code = await new Promise((done) => {
    const child = spawn("gh", args, { stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (c) => done(c ?? 1));
  });
  if (code !== 0) console.log(yellow(`! --report could not post the status (gh exited ${code})`));
}

// ── Summary ──────────────────────────────────────────────────────────────────
function writeSummary({ sha, ok, steps, error, leftovers }, logDir) {
  mkdirSync(logDir, { recursive: true });
  const run = { sha, ok, at: new Date().toISOString(), steps, ...(error ? { error } : {}), leftoverWorktrees: leftovers };
  const summary = join(logDir, "last-run.json");
  writeFileSync(summary, `${JSON.stringify(run, null, 2)}\n`);
  return summary;
}

/** The temp worktrees this run created that are still registered; a leftover means cleanup failed. */
async function leftoverWorktrees(trees) {
  const list = await git(["worktree", "list"]);
  return trees.filter((tree) => list.out.includes(tree));
}

function printSummary(result) {
  const jobWidth = Math.max(6, ...result.map((r) => r.job.length));
  const nameWidth = Math.max(4, ...result.map((r) => r.name.length));
  const line = dim(`─`.repeat(jobWidth + nameWidth + 22));
  console.log(`\n${line}`);
  for (const r of result) {
    const status = r.status === "passed" ? green("passed".padEnd(8)) : r.status === "failed" ? red("failed".padEnd(8)) : dim(r.status.padEnd(8));
    console.log(`  ${r.job.padEnd(jobWidth)}  ${r.name.padEnd(nameWidth)}  ${status}  ${r.seconds.toFixed(1).padStart(6)}s`);
  }
  console.log(line);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runStepOrNative(step, dir, logDir) {
  if (!step.native) return runStep(step.run, dir);
  if (step.native === "dev-stack") {
    return nativeStep(async () => {
      startDevStack(dir, logDir);
      await waitForStack(logDir);
    });
  }
  if (step.native === "dev-stack-stop") return nativeStep(stopDevStack);
  return nativeStep(() => {
    throw new Error(`unknown native step: ${step.native}`);
  });
}

export async function main(argv = process.argv.slice(2), { steps = STEPS, logDir = LOG_DIR } = {}) {
  const opts = parseArgs(argv);
  const sha = await headSha();
  const jobs = opts.job ? [opts.job] : ["verify", "pentest"];
  const cwd = opts.here ? ROOT : null;

  if (!cwd) {
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0) throw new Error(`git status failed: ${dirty.err.trim()}`);
    if (dirty.out.trim()) return refuse(sha, "the tree has uncommitted tracked changes; commit them or pass --here. CI only sees commits, so a clean checkout is the default.", logDir);
  }

  const worktrees = [];
  if (!cwd) {
    const tree = join(tmpdir(), `rose-ci-${sha.slice(0, 7)}`);
    await git(["worktree", "remove", "--force", tree]); // stale leftover from an interrupted run
    const add = await git(["worktree", "add", "--detach", tree, "HEAD"]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.err.trim()}`);
    worktrees.push(tree);
    console.log(`Running at HEAD ${sha.slice(0, 7)} in ${tree}`);
  } else {
    console.log(`Running at HEAD ${sha.slice(0, 7)} in ${cwd} (--here)`);
  }
  const dir = cwd ?? worktrees[0];

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const result = [];
  let ok = true;
  let error = null;
  try {
    for (const job of jobs) {
      const jobSteps = steps.filter((s) => s.job === job);
      if (job === "pentest") await assertPortsFree();
      for (const step of jobSteps) {
        if (!ok) {
          result.push({ job, name: step.name, status: "skipped", seconds: 0 });
          continue;
        }
        if (interrupted) throw new Error("interrupted");
        const started = Date.now();
        const code = await runStepOrNative(step, dir, logDir);
        const seconds = (Date.now() - started) / 1000;
        const passed = code === 0;
        result.push({ job, name: step.name, status: passed ? "passed" : "failed", seconds: Math.round(seconds * 10) / 10 });
        if (!passed) {
          ok = false;
          console.log(red(`\n✗ ${job} / ${step.name} failed`));
        }
      }
    }
  } catch (e) {
    ok = false;
    error = e.message;
    console.log(red(`\n✗ ${e.message}`));
  } finally {
    await stopDevStack();
    if (opts.keep) console.log(`Worktree kept: ${dir}`);
    else if (!cwd && !(await removeWorktrees(worktrees))) {
      ok = false;
      console.log(red(`✗ could not remove the worktree at ${dir}`));
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  // A run that refused to start writes last-run.json too, with no steps and the reason: one path,
  // and a stale green summary from an earlier run cannot stand in for it.
  const summary = writeSummary({ sha, ok, steps: result, error, leftovers: await leftoverWorktrees(worktrees) }, logDir);
  if (result.length) printSummary(result);
  console.log(`${ok ? green("ci:local passed") : red("ci:local failed")}  ${dim(`summary: ${summary}`)}`);
  if (opts.report) await report(sha, ok, result);
  return ok ? 0 : 1;
}

/** Stop before creating anything, and leave a last-run.json that says so. */
async function refuse(sha, reason, logDir) {
  console.log(red(`\n✗ ${reason}`));
  writeSummary({ sha, ok: false, steps: [], error: reason, leftovers: [] }, logDir);
  return 1;
}

async function removeWorktrees(trees) {
  for (const tree of trees) await git(["worktree", "remove", "--force", tree]);
  return (await leftoverWorktrees(trees)).length === 0;
}

/** A thrown error from a native step is a failed step, not a crash. */
async function nativeStep(fn) {
  try {
    await fn();
    return 0;
  } catch (e) {
    console.log(red(e.message));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(red(`✗ ${e.message}`));
      process.exit(1);
    });
}
