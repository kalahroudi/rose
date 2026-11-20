// SPDX-License-Identifier: Apache-2.0
// Drift between .github/workflows/ci.yml and `pnpm ci:local`. If CI gains a command the local
// runner does not run, these tests fail and name it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALLOWED_SKIPS, PENTEST_COMMAND, STEPS, pentestEnv } from "./ci-local.mjs";

const CI = ".github/workflows/ci.yml";
const SUMMARY = ".rose/ci-local/last-run.json";
const ROOT = resolve(import.meta.dirname, "..");
const CI_LOCAL = fileURLToPath(new URL("./ci-local.mjs", import.meta.url));
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Commands ci.yml runs that the runner implements itself instead of shelling out to. */
const NATIVE = new Map([
  [
    "nohup node scripts/dev.mjs > dev.log 2>&1 & for i in $(seq 1 90); do curl -sf http://localhost:5174/api/bootstrap | grep -q '\"root\"' && curl -sf http://localhost:5173/api/bootstrap > /dev/null && exit 0 sleep 1 done cat dev.log; exit 1",
    "Start the local stack: ci.yml backgrounds scripts/dev.mjs and polls it with curl; ci-local.mjs does that natively (fetch) and stops the process group afterwards, so there is no `run:` for it.",
  ],
  [
    "node --input-type=module -e \"import('./scripts/formal.mjs').then(m=>console.log('sha='+m.TLA_TOOLS_SHA256))\" >> \"$GITHUB_OUTPUT\"",
    "TLA tools sha: ci.yml reads TLA_TOOLS_SHA256 from scripts/formal.mjs to key the actions/cache step; setup-java and cache are CI-only, and ci:local runs pnpm formal directly without a cache, so there is no `run:` for it.",
  ],
]);

/** Every command ci.yml runs, in file order, with the job that runs it. No YAML dependency. */
function ciRecords(text = read(CI)) {
  const lines = text.split("\n");
  const records = [];
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(lines[i]);
    if (header) job = header[1];
    const m = /^\s*-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1] === "|" || m[1] === ">") {
      const indent = /^(\s*)/.exec(lines[i])[1].length;
      const block = [];
      for (i++; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() && line.length - line.trimStart().length <= indent) {
          i--;
          break;
        }
        if (line.trim()) block.push(line.trim());
      }
      records.push({ job, command: block.join(" ").replace(/\s+/g, " ") });
    } else {
      records.push({ job, command: m[1].trim() });
    }
  }
  return records;
}

const ciCommands = (text = read(CI)) => ciRecords(text).map((r) => r.command);

const shellCommands = (commands) => commands.filter((c) => !NATIVE.has(c));

function ciPentestEnv(text = read(CI)) {
  const lines = text.split("\n");
  const start = lines.indexOf("  pentest:");
  assert.ok(start !== -1, "ci.yml must keep a pentest job");
  const env = {};
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (inEnv && line.trim() && !line.startsWith("      ")) break;
    if (/^    env:$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (!inEnv) continue;
    const m = /^      (\S+):\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

/** The literal list CI and ci-local share. A change here must change the commands in both files. */
const EXPECTED_ALLOWED_SKIPS = ["ADM-05", "ADM-05b", "ADM-06", "GW-01", "HARD-01", "HARD-05", "AUTH-09"];

test("ci.yml parses to commands, both single-line and a `run: |` block", () => {
  const commands = ciCommands();
  assert.ok(commands.includes("pnpm guard"));
  assert.ok(NATIVE.has(commands.at(-2)), "the start-the-stack block keeps its shape");
  assert.equal(commands.at(-1), PENTEST_COMMAND);
});

test("drift: every ci.yml command runs in ci:local", () => {
  const local = STEPS.filter((s) => s.run).map((s) => s.run);
  for (const command of shellCommands(ciCommands())) assert.ok(local.includes(command), `ci.yml runs a command ci:local does not: ${command}`);
});

test("drift: every ci.yml command runs in the same ci:local job", () => {
  const local = (job) => STEPS.filter((s) => s.job === job && s.run).map((s) => s.run);
  for (const { job, command } of ciRecords()) {
    if (NATIVE.has(command)) continue;
    assert.ok(local(job).includes(command), `ci.yml's ${job} job runs "${command}"; ci:local does not run it in that job`);
  }
});

test("reverse drift: every ci:local command exists in ci.yml", () => {
  const ci = ciCommands();
  for (const step of STEPS.filter((s) => s.run)) assert.ok(ci.includes(step.run), `ci:local runs a command ci.yml does not: ${step.run}`);
});

test("order: verify steps keep ci.yml's relative order", () => {
  const local = STEPS.filter((s) => s.job === "verify" && s.run).map((s) => s.run);
  const positions = local.map((command) => ciCommands().indexOf(command));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "a verify step is out of ci.yml order");
  assert.equal(positions.length, new Set(positions).size, "a verify command runs twice in ci.yml");
});

test("no ci.yml command, ci:local step, or verify script runs pnpm formal --resync (owner constraint)", () => {
  for (const command of ciCommands()) assert.ok(!command.includes("--resync"), `ci.yml must never run --resync: ${command}`);
  for (const step of STEPS.filter((s) => s.run)) assert.ok(!step.run.includes("--resync"), `ci:local must never run --resync: ${step.run}`);
  const { scripts } = JSON.parse(read("package.json"));
  assert.ok(!scripts.verify.includes("--resync"), "the verify script must never run --resync");
  assert.ok(!scripts.formal.includes("--resync"), "the formal script must never run --resync (verify calls it)");
});

test("ci.yml and ci:local both run a formal step", () => {
  assert.ok(ciCommands().includes("pnpm formal"), "ci.yml must run pnpm formal");
  assert.ok(STEPS.some((s) => s.run === "pnpm formal"), "ci:local must run pnpm formal");
});

test("pentest runs strict and allows exactly today's skips", () => {
  const step = STEPS.find((s) => s.job === "pentest" && s.name === "Attack it");
  assert.equal(step.run, PENTEST_COMMAND);
  assert.deepEqual(ALLOWED_SKIPS, EXPECTED_ALLOWED_SKIPS, "ALLOWED_SKIPS changed; update this literal and both pentest commands");
  assert.equal(PENTEST_COMMAND, `pnpm pentest --strict${EXPECTED_ALLOWED_SKIPS.map((id) => ` --allow-skip ${id}`).join("")}`);
  assert.ok(ciCommands().includes(PENTEST_COMMAND), "ci.yml runs the same strict command");
  assert.ok(EXPECTED_ALLOWED_SKIPS.includes("AUTH-09"), "AUTH-09 is a known skip until --slow reaches ci:local");
  assert.ok(!ALLOWED_SKIPS.includes("AUTH-08") && !ALLOWED_SKIPS.includes("INT-03"), "AUTH-08 and INT-03 must run (not skip) against the local stack");
});

test("pentestEnv points the dev stack and the harness at one state dir under .rose/ci-local", () => {
  assert.deepEqual(pentestEnv("/repo/.rose/ci-local"), {
    ROSE_PERSIST_TO: "/repo/.rose/ci-local/state",
    ROSE_PENTEST_STATE: "/repo/.rose/ci-local/state",
  });
});

test("ci.yml pentest job sets both state env vars to one directory, like pentestEnv", () => {
  const env = ciPentestEnv();
  assert.ok(env.ROSE_PERSIST_TO, "ci.yml pentest job must set ROSE_PERSIST_TO");
  assert.ok(env.ROSE_PENTEST_STATE, "ci.yml pentest job must set ROSE_PENTEST_STATE");
  assert.equal(env.ROSE_PERSIST_TO, env.ROSE_PENTEST_STATE, "both must point at one throwaway database, matching pentestEnv");
});

test("a failing step exits non-zero and skips the rest", () => {
  const steps = [
    { job: "verify", name: "Passes", run: 'node -e "process.exit(0)"' },
    { job: "verify", name: "Fails", run: 'node -e "process.exit(1)"' },
    { job: "verify", name: "After", run: 'node -e "process.exit(0)"' },
  ];
  const logDir = mkdtempSync(join(tmpdir(), "rose-ci-local-"));
  const before = statSync(join(ROOT, SUMMARY), { throwIfNoEntry: false })?.mtimeMs;
  try {
    const source = `import { main } from ${JSON.stringify(pathToFileURL(CI_LOCAL).href)};
const code = await main(["--here", "--job", "verify"], { steps: ${JSON.stringify(steps)}, logDir: ${JSON.stringify(logDir)} });
process.exit(code);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /Fails/);
    const summary = JSON.parse(readFileSync(join(logDir, "last-run.json"), "utf8"));
    assert.deepEqual(summary.steps.map((s) => [s.name, s.status]), [["Passes", "passed"], ["Fails", "failed"], ["After", "skipped"]]);
    assert.equal(summary.ok, false);
    assert.equal(statSync(join(ROOT, SUMMARY), { throwIfNoEntry: false })?.mtimeMs, before, "the test must not overwrite the real last-run.json");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("STEPS mirror both jobs, verify first", () => {
  assert.deepEqual([...new Set(STEPS.map((s) => s.job))], ["verify", "pentest"]);
  for (const job of ["verify", "pentest"]) {
    assert.ok(STEPS.some((s) => s.job === job && (s.run || s.native)), job);
  }
});

test("importing the module runs nothing", async () => {
  const before = statSync(SUMMARY, { throwIfNoEntry: false })?.mtimeMs;
  await import("./ci-local.mjs");
  assert.equal(statSync(SUMMARY, { throwIfNoEntry: false })?.mtimeMs, before);
});

test("--report is the only path that posts a commit status", () => {
  const source = read("scripts/ci-local.mjs");
  assert.equal(source.match(/statuses\//g)?.length, 1);
  const report = /async function report\(([\s\S]*?)\n}\n/.exec(source);
  assert.ok(report, "the report function exists");
  assert.ok(report[0].includes("statuses/"), "the only statuses/ call is inside report()");
});
