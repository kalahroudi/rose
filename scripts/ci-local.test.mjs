// SPDX-License-Identifier: Apache-2.0
// Drift between .github/workflows/ci.yml and `pnpm ci:local`. If CI gains a command the local
// runner does not run, these tests fail and name it.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { STEPS } from "./ci-local.mjs";

const CI = ".github/workflows/ci.yml";
const SUMMARY = ".rose/ci-local/last-run.json";
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Commands ci.yml runs that the runner implements itself instead of shelling out to. */
const NATIVE = new Map([
  [
    "nohup node scripts/dev.mjs > dev.log 2>&1 & for i in $(seq 1 90); do curl -sf http://localhost:5174/api/bootstrap | grep -q '\"root\"' && curl -sf http://localhost:5173/api/bootstrap > /dev/null && exit 0 sleep 1 done cat dev.log; exit 1",
    "Start the local stack: ci.yml backgrounds scripts/dev.mjs and polls it with curl; ci-local.mjs does that natively (fetch) and stops the process group afterwards, so there is no `run:` for it.",
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
