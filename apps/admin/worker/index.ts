// SPDX-License-Identifier: Apache-2.0
//
// Operator console worker. It manages tenants, domains and operators through the control
// plane only. By design it has NO binding to tenant databases and holds no tenant key,
// so even a fully compromised operator session can not read tenant business data.
import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { z } from "zod";
import {
  addDomain, addOperator, clientIp, cloudflare, createAuthRoutes, csrfGuard, currentSession,
  deleteSetting, domainCounts, enqueueJob, errorHandler, getDomain, getOperator, getSetting, getTenant, isOperatorEmail, listDomains, listJobs,
  listMembers, listOperators, listPasskeys, listPlatformAudit, listTenants, markTenantDeleting, normalizeEmail, operatorCount, parse, putSetting,
  readJson, removeDomain, removeOperator, requestContext, retryJob, runDueJobs, runJobMessages, setDomainState, setTenantStatus, sweepExpired, tenantCounts,
  tenantSignupSeries, updateTenant, userCount, validateHostname, writePlatformAudit,
  type AuthRealm, type BaseVars, type JobHandler, type OperatorRole,
} from "@rose/core/platform";
import { forbidden, invalid, isDev, listQuerySchema, notFound, searchTermSchema, unauthorized, type PlatformWorkerEnv } from "@rose/core";
import { setupStatus } from "./setup";

const COOKIE = "rose_admin";
const SCOPE = "platform";

interface Operator {
  userId: string;
  email: string;
  name: string;
  role: OperatorRole;
}
type Env = { Bindings: PlatformWorkerEnv; Variables: BaseVars & { operator: Operator } };
type Ctx = Context<Env>;

const cfConnection = async (env: PlatformWorkerEnv): Promise<cloudflare.CloudflareConnection | null> => {
  const [zoneId, apiToken] = await Promise.all([getSetting(env.DB, env.ROSE_MASTER_KEY, "cloudflare.zone_id"), getSetting(env.DB, env.ROSE_MASTER_KEY, "cloudflare.api_token")]);
  return zoneId && apiToken ? { zoneId, apiToken } : null;
};

// ── Background jobs owned by the operator worker ─────────────────────────────────
const jobHandlers: Record<string, JobHandler<PlatformWorkerEnv>> = {
  /** Registers a custom domain with Cloudflare for SaaS, then polls until its certificate is live. */
  "domain.verify": async (env, job, payload) => {
    const hostname = String(payload.hostname ?? "");
    const row = await getDomain(env.DB, hostname);
    if (!row) return { done: true, result: { skipped: "removed" } };
    const conn = await cfConnection(env);
    if (!conn) {
      if (isDev(env)) {
        await setDomainState(env.DB, hostname, { status: "active", detail: JSON.stringify({ note: "Activated without verification (development)." }) });
        return { done: true };
      }
      await setDomainState(env.DB, hostname, { status: "failed", detail: JSON.stringify({ errors: ["Connect Cloudflare in Setup, then re-check this domain."] }) });
      return { done: true };
    }
    const h = row.provider_id ? await cloudflare.getCustomHostname(conn, row.provider_id) : await cloudflare.createCustomHostname(conn, hostname);
    const detail = JSON.stringify({ records: h.records, errors: h.errors, ssl: h.sslStatus });
    if (h.status === "active" && h.sslStatus === "active") {
      await setDomainState(env.DB, hostname, { status: "active", providerId: h.id, detail });
      return { done: true };
    }
    if (job.attempts >= 120) {
      await setDomainState(env.DB, hostname, { status: "failed", providerId: h.id, detail });
      return { done: true };
    }
    await setDomainState(env.DB, hostname, { status: "pending", providerId: h.id, detail });
    return { done: false, retryInMs: 30_000, note: "Waiting for DNS" };
  },
};

async function tick(env: PlatformWorkerEnv): Promise<void> {
  await runDueJobs(env, jobHandlers);
  await sweepExpired(env.DB);
}

const app = new Hono<Env>();
app.onError(errorHandler);
app.use("*", requestContext as never);
app.use("/api/*", csrfGuard);
app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res.ok) c.res.headers.set("Cache-Control", "private, no-cache");
});
app.use("/api/*", etag());

// The first operator is whoever controls the mailbox named at setup time. After that the
// bootstrap address has no special meaning.
const bootstrapEligible = async (env: PlatformWorkerEnv, email: string) =>
  !!env.BOOTSTRAP_OPERATOR_EMAIL && email === env.BOOTSTRAP_OPERATOR_EMAIL.trim().toLowerCase() && (await operatorCount(env.DB)) === 0;

const realm = (c: Ctx): AuthRealm => ({
  scope: SCOPE,
  displayName: `${c.env.APP_NAME} Admin`,
  cookie: COOKIE,
  eligible: async (email) => (await isOperatorEmail(c.env.DB, email)) || bootstrapEligible(c.env, email),
  admit: async (user) => {
    if (await getOperator(c.env.DB, user.id)) return true;
    if (!(await bootstrapEligible(c.env, user.email))) return false;
    await addOperator(c.env.DB, user.email, "owner");
    await writePlatformAudit(c.env.DB, { actor: user.email, action: "operator.bootstrap", target: user.id });
    return true;
  },
  audit: (e) => writePlatformAudit(c.env.DB, e),
});

app.get("/api/bootstrap", async (c) => {
  const s = await currentSession(c, { scope: SCOPE, cookie: COOKIE });
  const base = { app: { name: c.env.APP_NAME, baseDomain: c.env.APP_BASE_DOMAIN, appUrlTemplate: c.env.APP_URL_TEMPLATE ?? "https://{host}" }, dev: isDev(c.env) };
  if (!s) return c.json({ ...base, session: null });
  const passkeys = await listPasskeys(c.env.DB, s.userId, SCOPE);
  return c.json({ ...base, session: { user: { id: s.userId, email: s.email, name: s.name }, role: s.role, hasPasskey: passkeys.length > 0, method: s.method } });
});

app.route("/api/auth", createAuthRoutes(async (c) => realm(c as unknown as Ctx)) as never);

// ── Everything below requires an operator session ────────────────────────────────
app.use("/api/*", async (c, next) => {
  const s = await currentSession(c, { scope: SCOPE, cookie: COOKIE });
  if (!s) throw unauthorized();
  c.set("operator", { userId: s.userId, email: s.email, name: s.name, role: s.role as OperatorRole });
  await next();
});

const listQ = (c: Ctx) => parse(listQuerySchema, c.req.query());
const audit = (c: Ctx, action: string, target?: string | null, meta?: unknown) =>
  writePlatformAudit(c.env.DB, { actor: c.get("operator").email, action, target, meta, ip: clientIp(c) });
const ownerOnly = (c: Ctx) => {
  if (c.get("operator").role !== "owner") throw forbidden("Only a platform owner can do that.");
};
const tenantOr404 = async (c: Ctx, id: string) => {
  const t = await getTenant(c.env.DB, id);
  if (!t) throw notFound();
  return t;
};

app.get("/api/overview", async (c) => {
  const [tenants, users, domains, jobs, series] = await Promise.all([
    tenantCounts(c.env.DB), userCount(c.env.DB), domainCounts(c.env.DB),
    listJobs(c.env.DB, null, { page: 1, pageSize: 5, q: "", sort: "", status: "failed" }), tenantSignupSeries(c.env.DB, 14),
  ]);
  const setup = await setupStatus(c.env);
  const attention: { id: string; severity: "high" | "medium"; title: string; detail: string; href: string }[] = [];
  for (const check of setup.checks) {
    if (check.status === "fail") attention.push({ id: `setup:${check.id}`, severity: "high", title: check.label, detail: check.detail, href: "/setup" });
  }
  if (jobs.total > 0) attention.push({ id: "jobs", severity: "high", title: `${jobs.total} background ${jobs.total === 1 ? "task" : "tasks"} failed`, detail: "Open Activity to see the error and retry.", href: "/activity?status=failed" });
  if (domains.failed > 0) attention.push({ id: "domains-failed", severity: "high", title: `${domains.failed} custom ${domains.failed === 1 ? "domain" : "domains"} failed verification`, detail: "Check the DNS records, then re-check.", href: "/domains?status=failed" });
  if (domains.pending > 0) attention.push({ id: "domains-pending", severity: "medium", title: `${domains.pending} custom ${domains.pending === 1 ? "domain is" : "domains are"} waiting for DNS`, detail: "The customer still needs to add the DNS records.", href: "/domains?status=pending" });
  if (tenants.suspended > 0) attention.push({ id: "suspended", severity: "medium", title: `${tenants.suspended} ${tenants.suspended === 1 ? "tenant is" : "tenants are"} suspended`, detail: "Suspended tenants can not sign in. Resume or delete them.", href: "/tenants?status=suspended" });
  return c.json({ tenants, users, domains, failedJobs: jobs.total, series, attention });
});

// Tenants
const statusFilter = (c: Ctx) => {
  const s = c.req.query("status");
  return s === "active" || s === "suspended" || s === "deleting" ? s : "";
};
app.get("/api/tenants", async (c) => c.json(await listTenants(c.env.DB, { ...listQ(c), status: statusFilter(c) })));

app.get("/api/tenants/:id", async (c) => c.json(await tenantOr404(c, c.req.param("id"))));

app.patch("/api/tenants/:id", async (c) => {
  const body = await readJson(c, z.object({ name: z.string().max(80).optional(), plan: z.string().trim().min(1).max(30).optional() }));
  const row = await updateTenant(c.env.DB, c.req.param("id"), body);
  await audit(c, "tenant.update", row.id, body);
  return c.json(row);
});

app.post("/api/tenants/bulk", async (c) => {
  const body = await readJson(
    c,
    z.object({
      action: z.enum(["suspend", "resume"]),
      ids: z.array(z.string().max(40)).max(100).optional(),
      filter: z.object({ q: searchTermSchema, status: z.enum(["", "active", "suspended", "deleting"]).default("") }).optional(),
    }),
  );
  const target = body.ids?.length ? { ids: body.ids } : body.filter ? { filter: body.filter } : null;
  if (!target) throw invalid("Select at least one tenant.");
  const affected = await setTenantStatus(c.env.DB, target, body.action === "suspend" ? "suspended" : "active");
  await audit(c, `tenant.${body.action}`, null, { affected, ...("ids" in target ? { ids: target.ids } : { filter: target.filter }) });
  return c.json({ affected });
});

app.post("/api/tenants/:id/delete", async (c) => {
  const t = await tenantOr404(c, c.req.param("id"));
  const { confirm } = await readJson(c, z.object({ confirm: z.string().max(80) }));
  if (confirm !== t.slug) throw invalid("Type the tenant address to confirm.", { confirm: "Does not match." });
  await markTenantDeleting(c.env.DB, t.id);
  const job = await enqueueJob(c.env, { type: "tenant.purge", scope: SCOPE, title: `Delete tenant ${t.slug}`, payload: { tenantId: t.id }, createdBy: c.get("operator").email });
  await audit(c, "tenant.delete.requested", t.id, { slug: t.slug });
  return c.json({ jobId: job.id }, 202);
});

app.get("/api/tenants/:id/members", async (c) => {
  await tenantOr404(c, c.req.param("id"));
  return c.json(await listMembers(c.env.DB, c.req.param("id"), { ...listQ(c), role: c.req.query("role") }));
});

// Custom domains (Cloudflare for SaaS)
app.get("/api/domains", async (c) => c.json(await listDomains(c.env.DB, { ...listQ(c), status: c.req.query("status"), tenantId: c.req.query("tenantId") })));

app.post("/api/tenants/:id/domains", async (c) => {
  const t = await tenantOr404(c, c.req.param("id"));
  const body = await readJson(c, z.object({ hostname: z.string().max(253) }));
  const row = await addDomain(c.env.DB, t.id, validateHostname(body.hostname, c.env.APP_BASE_DOMAIN));
  const job = await enqueueJob(c.env, { type: "domain.verify", scope: SCOPE, title: `Verify domain ${row.hostname}`, payload: { hostname: row.hostname }, createdBy: c.get("operator").email });
  await audit(c, "domain.add", row.hostname, { tenant: t.slug });
  return c.json({ ...row, tenant_slug: t.slug, tenant_name: t.name, jobId: job.id }, 202);
});

app.post("/api/domains/:hostname/recheck", async (c) => {
  const row = await getDomain(c.env.DB, c.req.param("hostname"));
  if (!row) throw notFound();
  await setDomainState(c.env.DB, row.hostname, { status: "pending", detail: row.detail });
  const job = await enqueueJob(c.env, { type: "domain.verify", scope: SCOPE, title: `Verify domain ${row.hostname}`, payload: { hostname: row.hostname }, createdBy: c.get("operator").email });
  return c.json({ jobId: job.id }, 202);
});

app.delete("/api/domains/:hostname", async (c) => {
  const row = await removeDomain(c.env.DB, c.req.param("hostname"));
  const conn = await cfConnection(c.env);
  if (conn && row.provider_id) c.executionCtx.waitUntil(cloudflare.deleteCustomHostname(conn, row.provider_id).catch(() => undefined));
  await audit(c, "domain.remove", row.hostname);
  return c.json({ ok: true });
});

// Operators
app.get("/api/operators", async (c) => c.json(await listOperators(c.env.DB, listQ(c))));
app.post("/api/operators", async (c) => {
  ownerOnly(c);
  const body = await readJson(c, z.object({ email: z.string().max(254), role: z.enum(["owner", "operator"]).default("operator") }));
  await addOperator(c.env.DB, body.email, body.role);
  await audit(c, "operator.add", normalizeEmail(body.email), { role: body.role });
  return c.json({ ok: true }, 201);
});
app.delete("/api/operators/:userId", async (c) => {
  ownerOnly(c);
  await removeOperator(c.env.DB, c.req.param("userId"));
  await audit(c, "operator.remove", c.req.param("userId"));
  return c.json({ ok: true });
});

// Audit & activity
app.get("/api/audit", async (c) => c.json(await listPlatformAudit(c.env.DB, { ...listQ(c), action: c.req.query("action") })));
app.get("/api/jobs", async (c) => c.json(await listJobs(c.env.DB, null, { ...listQ(c), status: c.req.query("status") })));
app.post("/api/jobs/:id/retry", async (c) => {
  await retryJob(c.env, c.req.param("id"));
  await audit(c, "job.retry", c.req.param("id"));
  return c.json({ ok: true });
});

// Setup & connections
app.get("/api/setup", async (c) => c.json(await setupStatus(c.env)));

app.put("/api/setup/cloudflare", async (c) => {
  ownerOnly(c);
  const body = await readJson(c, z.object({ zoneId: z.string().trim().regex(/^[0-9a-f]{32}$/, "A zone ID is 32 hex characters."), apiToken: z.string().trim().min(20, "Paste the full API token.").max(200) }));
  let zone;
  try {
    zone = await cloudflare.verifyZone(body);
  } catch (err) {
    throw invalid("Cloudflare rejected these details.", { apiToken: err instanceof Error ? err.message : "Verification failed." });
  }
  await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "cloudflare.zone_id", body.zoneId);
  await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "cloudflare.zone_name", zone.name);
  await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "cloudflare.api_token", body.apiToken, true);
  await audit(c, "setup.cloudflare.connect", zone.name);
  return c.json({ ok: true, zone: zone.name });
});
app.delete("/api/setup/cloudflare", async (c) => {
  ownerOnly(c);
  for (const k of ["cloudflare.zone_id", "cloudflare.zone_name", "cloudflare.api_token"]) await deleteSetting(c.env.DB, k);
  await audit(c, "setup.cloudflare.disconnect");
  return c.json({ ok: true });
});

app.put("/api/setup/github", async (c) => {
  ownerOnly(c);
  const body = await readJson(c, z.object({ repo: z.string().trim().regex(/^[\w.-]{1,39}\/[\w.-]{1,100}$/, "Use the form owner/repository."), token: z.string().trim().max(300).default("") }));
  const res = await fetch(`https://api.github.com/repos/${body.repo}`, {
    headers: { "User-Agent": "rose-starter-kit", Accept: "application/vnd.github+json", ...(body.token ? { Authorization: `Bearer ${body.token}` } : {}) },
  });
  if (!res.ok) throw invalid("GitHub could not find that repository.", { repo: res.status === 404 ? "Not found. For a private repository, add a token with read access." : `GitHub responded ${res.status}.` });
  const info = (await res.json()) as { full_name: string; default_branch: string; private: boolean };
  await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "github.repo", info.full_name);
  await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "github.branch", info.default_branch);
  if (body.token) await putSetting(c.env.DB, c.env.ROSE_MASTER_KEY, "github.token", body.token, true);
  else await deleteSetting(c.env.DB, "github.token");
  await audit(c, "setup.github.connect", info.full_name);
  return c.json({ ok: true, repo: info.full_name });
});
app.delete("/api/setup/github", async (c) => {
  ownerOnly(c);
  for (const k of ["github.repo", "github.branch", "github.token"]) await deleteSetting(c.env.DB, k);
  await audit(c, "setup.github.disconnect");
  return c.json({ ok: true });
});

app.post("/__dev/tick", async (c) => {
  if (c.env.ENVIRONMENT !== "development") throw notFound();
  await tick(c.env);
  return c.json({ ok: true });
});

app.all("/api/*", () => {
  throw notFound();
});

export default {
  fetch: (request: Request, env: PlatformWorkerEnv, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  /** Jobs start as soon as they are queued. */
  queue: async (batch: { messages: readonly { body: unknown; ack(): void }[] }, env: PlatformWorkerEnv) => runJobMessages(env, jobHandlers, batch),
  /** Hourly: expiry sweep, plus a safety net for jobs whose queue message was lost. */
  scheduled: async (_event: unknown, env: PlatformWorkerEnv) => tick(env),
};
