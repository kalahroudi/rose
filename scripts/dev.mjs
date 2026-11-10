#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm dev` — run the whole kit locally with no configuration.
//
//   one local Workers runtime (both workers + dev router, shared database)  :8787
//   Vite for the operator console (hot reload)                              :5173
//   Vite for the tenant app (hot reload)                                    :5174
//
import http from "node:http";
import { ADMIN_DIR, APP_DIR, ROOT, applyLocalMigrations, bin, c, ensureDevVars, ensureDistDirs, info, installGitHooks, ok, spawnChild } from "./lib.mjs";

const WORKERS_PORT = 8787;

const { created, adminEmail } = ensureDevVars({ adminEmail: process.env.ROSE_ADMIN_EMAIL });
if (created) ok("Generated local secrets in apps/*/.dev.vars (git-ignored)");
ensureDistDirs();
installGitHooks();
info("Applying local database migrations…");
applyLocalMigrations();

const children = [];
let stopping = false;

function start(name, color, cmd, args, cwd) {
  const child = spawnChild(cmd, args, { cwd });
  const tag = color(name.padEnd(8));
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`${tag} exited with code ${code}. Stopping everything.`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  // Children are process-group leaders, so signalling -pid also stops workerd/esbuild.
  for (const ch of children) {
    try {
      process.kill(-ch.pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const ch of children) {
      try {
        process.kill(-ch.pid, "SIGKILL");
      } catch {}
    }
    process.exit(code);
  }, 1500).unref();
  let left = children.length;
  if (left === 0) process.exit(code);
  for (const ch of children) {
    if (ch.exitCode !== null || ch.signalCode !== null) {
      if (--left === 0) process.exit(code);
    } else ch.once("exit", () => --left === 0 && process.exit(code));
  }
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

start("workers", c.magenta, bin(APP_DIR, "wrangler"), [
  "dev", "-c", "scripts/dev/wrangler.jsonc", "-c", "apps/app/wrangler.jsonc", "-c", "apps/admin/wrangler.jsonc",
  "--persist-to", ".wrangler/state", "--port", String(WORKERS_PORT), "--show-interactive-dev-session=false",
], ROOT);
start("admin", c.blue, bin(ADMIN_DIR, "vite"), ["dev"], ADMIN_DIR);
start("app", c.green, bin(APP_DIR, "vite"), ["dev"], APP_DIR);

// Cron triggers do not fire locally; this drives background jobs in both workers.
function tick(host) {
  const req = http.request({ host: "127.0.0.1", port: WORKERS_PORT, path: "/__dev/tick", method: "POST", headers: { Host: host, "Content-Length": 0 }, timeout: 2500 }, (res) => res.resume());
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end();
}
const ticker = setInterval(() => {
  tick("localhost:5174");
  tick("localhost:5173");
}, 3000);

function waitForWorkers(tries = 60) {
  const req = http.request({ host: "127.0.0.1", port: WORKERS_PORT, path: "/api/bootstrap", headers: { Host: "localhost:5174" }, timeout: 1000 }, (res) => {
    res.resume();
    banner();
  });
  const retry = () => (tries > 0 && !stopping ? setTimeout(() => waitForWorkers(tries - 1), 500) : null);
  req.on("error", retry);
  req.on("timeout", () => req.destroy());
  req.end();
}

function banner() {
  const line = c.dim("─".repeat(66));
  console.log(`
${line}
  ${c.bold("Rose is running")}

  Operator console   ${c.cyan("http://localhost:5173")}
                     sign in as ${c.bold(adminEmail)}
  Tenant app         ${c.cyan("http://localhost:5174")}   ${c.dim("(sign up / find your workspace)")}
  A tenant           ${c.cyan("http://<slug>.localhost:5174")}

  Sign-in codes are shown on the sign-in screen and printed here
  in development. No email is sent.

  ${c.dim("Ctrl-C stops everything.   pnpm verify  runs guard + types + tests.")}
${line}
`);
}
waitForWorkers();
