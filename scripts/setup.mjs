#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm setup`               local development setup (default)
// `pnpm setup --production`  guided production setup on Cloudflare
//
// Every production answer can be passed as a flag or environment variable, so this also
// runs unattended:  --domain --admin-host --operator-email --app-name
//                   --email-provider resend|console --email-from --resend-api-key (or RESEND_API_KEY)
//                   --dry-run (print the plan and commands, change nothing)  --skip-deploy  --yes
import { createInterface } from "node:readline/promises";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ADMIN_DIR, APP_DIR, DB_NAME, PLACEHOLDER_DB_ID, PROD_CONFIG, applyLocalMigrations, bin, c, ensureDevVars, ensureDistDirs, fail, info, installGitHooks,
  newHexSecret, newMasterKey, ok, parseArgs, readText, run, setDatabaseId, setRoutes, setVar, warn, writeText,
} from "./lib.mjs";

const args = parseArgs();
if (args.help) {
  console.log(readText(new URL(import.meta.url).pathname).split("\n").slice(2, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

if (!args.production) {
  const { created, adminEmail } = ensureDevVars({ adminEmail: typeof args["operator-email"] === "string" ? args["operator-email"] : process.env.ROSE_ADMIN_EMAIL });
  ok(created ? "Generated local secrets in apps/app/.dev.vars and apps/admin/.dev.vars (git-ignored)" : "Local secrets already present (kept, so existing local data stays readable)");
  ensureDistDirs();
  ok(installGitHooks() ? "Git hooks enabled (.githooks: pre-commit runs guard + typecheck, pre-push runs pnpm verify)" : "Not a git checkout: skipped git hooks");
  applyLocalMigrations();
  ok("Local control-plane database is up to date");
  console.log(`\nNext:  ${c.bold("pnpm dev")}   then open http://localhost:5173 and sign in as ${c.bold(adminEmail)}\n`);
  process.exit(0);
}

// ── Production ───────────────────────────────────────────────────────────────────
const dry = !!args["dry-run"];
const rl = createInterface({ input: process.stdin, output: process.stdout });
const interactive = process.stdin.isTTY && !args.yes && !dry;

async function ask(flag, envName, question, { def, validate, secret } = {}) {
  let v = typeof args[flag] === "string" ? args[flag] : process.env[envName];
  while (true) {
    if (v === undefined || v === "") {
      if (!interactive) {
        if (def !== undefined) v = def;
        else fail(`Missing --${flag} (or ${envName}). Required when not running interactively.`);
      } else {
        v = (await rl.question(`${c.cyan("?")} ${question}${def ? c.dim(` (${def})`) : ""}: `)).trim() || def || "";
      }
    }
    const err = validate ? validate(v) : null;
    if (!err) return v;
    if (!interactive) fail(`--${flag}: ${err}`);
    warn(err);
    v = undefined;
    void secret;
  }
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const wranglerApp = bin(APP_DIR, "wrangler");
const wranglerAdmin = bin(ADMIN_DIR, "wrangler");

/** Run (or, in a dry run, only print) a command. Secrets go through stdin and are never echoed. */
function step(label, cmd, cmdArgs, opts = {}) {
  const shown = `${cmd.includes("wrangler") ? "wrangler" : cmd} ${cmdArgs.join(" ")}${opts.input !== undefined ? "   < (secret via stdin)" : ""}`;
  console.log(`${c.dim(dry ? "[dry-run]" : "  $")} ${shown}  ${c.dim(`(${opts.cwd === ADMIN_DIR ? "apps/admin" : opts.cwd === APP_DIR ? "apps/app" : "."})`)}`);
  if (dry) return { status: 0, stdout: "", stderr: "" };
  const r = run(cmd, cmdArgs, opts);
  if (r.status !== 0 && !opts.allowFail) fail(`${label} failed.${opts.capture ? `\n${r.stdout}\n${r.stderr}` : ""}`);
  return r;
}

console.log(`\n${c.bold("Rose production setup")}${dry ? c.yellow("  — dry run, nothing will be changed") : ""}\n`);

// 1. Cloudflare login
if (!dry) {
  const who = run(wranglerApp, ["whoami"], { cwd: APP_DIR, capture: true });
  if (who.status !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) fail("Wrangler is not logged in. Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN) and re-run.");
  ok("Wrangler is authenticated");
} else console.log(`${c.dim("[dry-run]")} wrangler whoami`);

// 2. Answers
const domain = (await ask("domain", "ROSE_DOMAIN", "Base domain for tenants (a zone on your Cloudflare account, e.g. acme.app)", { validate: (v) => (HOST.test(v.toLowerCase()) ? null : "Enter a domain such as acme.app") })).toLowerCase();
const adminHost = (await ask("admin-host", "ROSE_ADMIN_HOST", "Hostname of the operator console", { def: `admin.${domain}`, validate: (v) => (HOST.test(v.toLowerCase()) ? null : "Enter a hostname such as admin.acme.app") })).toLowerCase();
const zone = typeof args.zone === "string" ? args.zone : domain;
const operatorEmail = (await ask("operator-email", "ROSE_OPERATOR_EMAIL", "Email of the first platform owner (must be able to receive mail)", { validate: (v) => (EMAIL.test(v) ? null : "Enter an email address") })).toLowerCase();
const appName = await ask("app-name", "ROSE_APP_NAME", "Product name", { def: "Rose" });
const emailProvider = await ask("email-provider", "ROSE_EMAIL_PROVIDER", "Email provider: resend or console", { def: "resend", validate: (v) => (["resend", "console"].includes(v) ? null : "Choose resend or console") });
let emailFrom = "";
let resendKey = "";
if (emailProvider === "resend") {
  emailFrom = await ask("email-from", "ROSE_EMAIL_FROM", 'From address, e.g. "Acme <login@acme.app>"', { def: `${appName} <login@${domain}>` });
  resendKey = await ask("resend-api-key", "RESEND_API_KEY", "Resend API key (input is visible; or set RESEND_API_KEY)", { def: dry ? "re_dry_run_placeholder" : undefined, secret: true, validate: (v) => (v.length >= 8 ? null : "Paste the API key") });
} else {
  warn("EMAIL_PROVIDER=console can not deliver mail in production: nobody will be able to sign in. Use it only to stage the deployment.");
}
rl.close();

if (!adminHost.endsWith(`.${domain}`) && adminHost !== domain) warn(`${adminHost} is outside ${domain}; make sure it is on a zone in the same Cloudflare account and pass --zone-admin if its zone differs.`);
if (adminHost.endsWith(`.${domain}`)) info(`Note: "${adminHost.slice(0, -domain.length - 1)}" is a reserved workspace address, so no tenant can claim the console's hostname.`);
const adminZone = typeof args["zone-admin"] === "string" ? args["zone-admin"] : adminHost.endsWith(`.${domain}`) ? zone : adminHost.split(".").slice(-2).join(".");

console.log(`
${c.bold("Plan")}
  Tenants            https://<workspace>.${domain}   (signup at https://${domain})
  Operator console   https://${adminHost}
  First owner        ${operatorEmail}
  Product name       ${appName}
  Email              ${emailProvider}${emailFrom ? `, from ${emailFrom}` : ""}
`);

// 3. Queues that start background jobs. Creating one that already exists is not an error here.
for (const queue of ["rose-app-jobs", "rose-admin-jobs"]) {
  const r = step(`Creating queue ${queue}`, wranglerApp, ["queues", "create", queue], { cwd: APP_DIR, capture: true, allowFail: true });
  if (!dry && r.status !== 0 && !/already (exists|taken)|11009/i.test(`${r.stdout}${r.stderr}`)) fail(`Could not create queue ${queue}.\n${r.stdout}\n${r.stderr}`);
}

// 4. Database
let dbId = null;
const appCfgPath = join(APP_DIR, PROD_CONFIG);
const adminCfgPath = join(ADMIN_DIR, PROD_CONFIG);
for (const dir of [APP_DIR, ADMIN_DIR]) if (!existsSync(join(dir, PROD_CONFIG)) && !dry) copyFileSync(join(dir, "wrangler.jsonc"), join(dir, PROD_CONFIG));
const current = /"database_id"\s*:\s*"([^"]+)"/.exec(readText(existsSync(appCfgPath) ? appCfgPath : join(APP_DIR, "wrangler.jsonc")))?.[1];
if (dry) {
  console.log(`${c.dim("[dry-run]")} wrangler d1 list --json   ${c.dim("(reuse rose-control if it exists)")}`);
  console.log(`${c.dim("[dry-run]")} wrangler d1 create ${DB_NAME}   ${c.dim("(only if missing)")}`);
  dbId = current && current !== PLACEHOLDER_DB_ID ? current : "<new database id>";
} else {
  const list = run(wranglerApp, ["d1", "list", "--json"], { cwd: APP_DIR, capture: true });
  try {
    dbId = JSON.parse(list.stdout.slice(list.stdout.indexOf("["))).find((d) => d.name === DB_NAME)?.uuid ?? null;
  } catch {
    dbId = null;
  }
  if (dbId) ok(`Using existing D1 database ${DB_NAME} (${dbId})`);
  else {
    const created = step("Creating the database", wranglerApp, ["d1", "create", DB_NAME], { cwd: APP_DIR, capture: true });
    dbId = /"database_id"\s*:\s*"([0-9a-f-]{36})"/.exec(created.stdout)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(created.stdout)?.[1];
    if (!dbId) fail(`Could not read the new database id from wrangler's output:\n${created.stdout}`);
    ok(`Created D1 database ${DB_NAME} (${dbId})`);
  }
}

// 4. Config files
function configure(path, edit) {
  const before = readText(existsSync(path) ? path : join(dirname(path), "wrangler.jsonc"));
  const after = edit(before);
  if (dry) console.log(`${c.dim("[dry-run]")} update ${path.replace(/^.*\/apps\//, "apps/")}  ${c.dim(after === before ? "(no change)" : "(database_id, vars, routes)")}`);
  else if (after !== before) writeText(path, after);
}
const common = (t) => {
  let s = dbId && !dbId.startsWith("<") ? setDatabaseId(t, dbId) : t;
  s = setVar(s, "ENVIRONMENT", "production");
  s = setVar(s, "APP_NAME", appName);
  s = setVar(s, "APP_BASE_DOMAIN", domain);
  s = setVar(s, "EMAIL_PROVIDER", emailProvider);
  if (emailFrom) s = setVar(s, "EMAIL_FROM", emailFrom);
  return s;
};
configure(appCfgPath, (t) => setRoutes(common(t), [{ pattern: `${domain}/*`, zone_name: zone }, { pattern: `*.${domain}/*`, zone_name: zone }]));
configure(adminCfgPath, (t) => {
  let s = common(t);
  s = setVar(s, "APP_URL_TEMPLATE", "https://{host}");
  s = setVar(s, "BOOTSTRAP_OPERATOR_EMAIL", operatorEmail);
  return setRoutes(s, [{ pattern: `${adminHost}/*`, zone_name: adminZone }]);
});
if (!dry) ok(`Wrote database id, vars and routes to apps/app/${PROD_CONFIG} and apps/admin/${PROD_CONFIG} (git-ignored: do not commit)`);

// 5. Migrations
step("Applying migrations", wranglerApp, ["d1", "migrations", "apply", DB_NAME, "--remote", "-c", PROD_CONFIG], { cwd: APP_DIR, env: { CI: "1" } });

// 6. Build
if (!args["skip-deploy"]) {
  step("Building", "pnpm", ["--filter", "@rose/app", "--filter", "@rose/admin", "build"]);
}

// 7. Deploy. Until the secrets below are attached the workers fail closed (HTTP 503), never open.
if (!args["skip-deploy"]) {
  step("Deploying the tenant app", wranglerApp, ["deploy", "-c", PROD_CONFIG], { cwd: APP_DIR });
  step("Deploying the operator console", wranglerAdmin, ["deploy", "-c", PROD_CONFIG], { cwd: ADMIN_DIR });
}

// 8. Secrets. Generated here, piped straight to Cloudflare, never printed or written to disk.
//    An existing ROSE_MASTER_KEY is never replaced: doing so would make stored data unreadable.
function existingSecrets(wrangler, cwd) {
  if (dry) return new Set();
  const r = run(wrangler, ["secret", "list", "--format", "json", "-c", PROD_CONFIG], { cwd, capture: true });
  try {
    return new Set(JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).map((s) => s.name));
  } catch {
    return new Set();
  }
}
function putSecret(wrangler, cwd, name, value, have, { keepExisting }) {
  if (keepExisting && have.has(name)) {
    ok(`${name} already set on ${cwd === APP_DIR ? "rose-app" : "rose-admin"} (kept)`);
    return;
  }
  step(`Setting ${name}`, wrangler, ["secret", "put", name, "-c", PROD_CONFIG], { cwd, input: value, capture: true });
}
const haveApp = existingSecrets(wranglerApp, APP_DIR);
const haveAdmin = existingSecrets(wranglerAdmin, ADMIN_DIR);
putSecret(wranglerApp, APP_DIR, "ROSE_MASTER_KEY", newMasterKey(), haveApp, { keepExisting: true });
putSecret(wranglerApp, APP_DIR, "UPSTREAM_SIGNING_SECRET", newHexSecret(), haveApp, { keepExisting: true });
putSecret(wranglerAdmin, ADMIN_DIR, "ROSE_MASTER_KEY", newMasterKey(), haveAdmin, { keepExisting: true });
if (resendKey) {
  putSecret(wranglerApp, APP_DIR, "RESEND_API_KEY", resendKey, haveApp, { keepExisting: false });
  putSecret(wranglerAdmin, ADMIN_DIR, "RESEND_API_KEY", resendKey, haveAdmin, { keepExisting: false });
}

console.log(`
${c.bold(dry ? "What would happen next" : "Almost there")}

${c.bold("DNS")} — this script does not create DNS records. In the Cloudflare dashboard for ${c.bold(zone)}, make sure these exist and are ${c.bold("proxied")} (orange cloud):

  Type   Name   Content   Purpose
  AAAA   ${domain}      100::     signup and workspace finder
  AAAA   *.${domain}    100::     every tenant
  AAAA   ${adminHost}   100::     operator console

  (100:: is a placeholder; the Worker routes answer the requests. If you already have records for these names, keep them proxied.)
  ${domain === zone ? `Certificates for *.${domain} are covered by Universal SSL.` : `${c.bold("Certificate needed")}: ${domain} is a subdomain of ${zone}, so Universal SSL does not cover *.${domain}. Order an Advanced Certificate Manager pack for it, or tenant addresses will fail with a TLS error.`}
  Deeper levels (a.b.${domain}) are intentionally never tenants.

${c.bold("Then")}
  1. Open https://${adminHost} and sign in as ${operatorEmail} (a 6-digit code is emailed).
  2. Add a passkey when prompted, then add a second owner under Operators.
  3. Open Setup: every item should be green. Connect Cloudflare there if tenants will bring their own domains.
  4. Recommended: put Cloudflare Access in front of ${adminHost} as a second lock (docs/deployment.md).
  5. Keep the generated wrangler.production.jsonc files out of git (they are git-ignored); they hold your database id, domains and operator email. Back them up privately.

${c.bold("Not automated")}: DNS records, Cloudflare Access, the Resend domain verification, and (for custom customer domains) enabling Cloudflare for SaaS with a fallback origin on the zone.
${c.dim("This production path is exercised by --dry-run only in this repository; read docs/deployment.md before the first real run.")}
`);
