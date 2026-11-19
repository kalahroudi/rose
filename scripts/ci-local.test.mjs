// SPDX-License-Identifier: Apache-2.0
// Drift between .github/workflows/ci.yml and `pnpm ci:local`. If CI gains a command the local
// runner does not run, these tests fail and name it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALLOWED_SKIPS, PENTEST_COMMAND, STEPS } from "./ci-local.mjs";

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
    "pnpm pentest",
    "Attack it: ci-local runs the same harness in strict mode with today's allowed skips instead of shelling out to the bare command.",
  ],
]);

/** Every command ci.yml runs, in file order: `run: <cmd>` and `run: |` blocks. No YAML dependency. */
function ciCommands(text = read(CI)) {
  const lines = text.split("\n");
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
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
      commands.push(block.join(" ").replace(/\s+/g, " "));
    } else {
      commands.push(m[1].trim());
    }
  }
  return commands;
}

const shellCommands = (commands) => commands.filter((c) => !NATIVE.has(c));

test("ci.yml parses to commands, both single-line and a `run: |` block", () => {
  const commands = ciCommands();
  assert.ok(commands.includes("pnpm guard"));
  assert.ok(NATIVE.has(commands.at(-2)), "the start-the-stack block keeps its shape");
  assert.equal(commands.at(-1), "pnpm pentest");
});

test("drift: every ci.yml command runs in ci:local", () => {
  const local = STEPS.filter((s) => s.run).map((s) => s.run);
  for (const command of shellCommands(ciCommands())) assert.ok(local.includes(command), `ci.yml runs a command ci:local does not: ${command}`);
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

test("pentest runs strict and allows exactly today's skips", () => {
  const step = STEPS.find((s) => s.job === "pentest" && s.name === "Attack it");
  assert.equal(step.native, "pentest");
  assert.match(PENTEST_COMMAND, /^node scripts\/pentest\.mjs --strict( --allow-skip \S+)+$/);
  for (const id of ALLOWED_SKIPS) assert.ok(PENTEST_COMMAND.includes(`--allow-skip ${id}`), id);
  assert.ok(ALLOWED_SKIPS.includes("AUTH-09"), "AUTH-09 is a known skip until --slow reaches ci:local");
});

test("a failing step exits non-zero and skips the rest", () => {
  const steps = [
    { job: "verify", name: "Passes", run: 'node -e "process.exit(0)"' },
    { job: "verify", name: "Fails", run: 'node -e "process.exit(1)"' },
    { job: "verify", name: "After", run: 'node -e "process.exit(0)"' },
  ];
  const source = `import { main } from ${JSON.stringify(pathToFileURL(CI_LOCAL).href)};
const code = await main(["--here", "--job", "verify"], { steps: ${JSON.stringify(steps)} });
process.exit(code);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /Fails/);
  const summary = JSON.parse(readFileSync(join(ROOT, SUMMARY), "utf8"));
  assert.deepEqual(summary.steps.map((s) => [s.name, s.status]), [["Passes", "passed"], ["Fails", "failed"], ["After", "skipped"]]);
  assert.equal(summary.ok, false);
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
