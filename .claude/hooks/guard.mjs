#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code hook. Reads the hook event from stdin and runs the Rose guard.
//   PostToolUse (Edit/Write): checks the edited file; exit 2 feeds the findings back to the agent.
//   Stop: checks the whole repository; exit 2 keeps the agent working until it is clean.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let event = {};
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0); // Never block work because the hook input was unreadable.
}

const guard = (args) => spawnSync(process.execPath, [resolve(root, "scripts/guard.mjs"), ...args], { cwd: root, encoding: "utf8" });

if (event.hook_event_name === "Stop") {
  if (event.stop_hook_active) process.exit(0); // Already continued once because of this hook: do not loop.
  const r = guard([]);
  if (r.status === 0) process.exit(0);
  process.stderr.write(`${r.stderr}\nThe Rose guard is failing. Fix the problems above before finishing. For "protected-file" findings do not run --approve: tell the user which protected files changed and why, and ask them to review and run \`pnpm guard:approve\`.\n`);
  process.exit(2);
}

const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
if (!file) process.exit(0);
const r = guard(["--quick", file]);
if (r.status === 0) process.exit(0);
process.stderr.write(`${r.stderr}\nRose guard: the edit above breaks a project rule. Fix it now using the "Fix" guidance; do not add guard-allow unless the user agreed to the exception.\n`);
process.exit(2);
