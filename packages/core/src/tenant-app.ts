// SPDX-License-Identifier: Apache-2.0
import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { z } from "zod";
import { createAuthRoutes, checkCode, currentSession, requestCode, startSession, type AuthRealm } from "./auth/routes";
import { listPasskeys } from "./auth/passkeys";
import { writePlatformAudit } from "./control/audit";
import { enqueueJob, listJobs, runDueJobs, runJobMessages, type JobHandler } from "./control/jobs";
import { consumeHandoff, createHandoff, sweepExpired } from "./control/sessions";
import { createTenant, deleteTenantRecords, getTenant, markTenantDeleting, slugAvailable, updateTenant, validateSlug, type TenantRow } from "./control/tenants";
import {
  addMembership, changeMemberRole, createInvitation, ensureUser, getMembership, getPendingInvitation, listInvitations, listMembers,
  listWorkspacesForUser, normalizeEmail, redeemInvitation, removeMember, revokeInvitation, type Role, type UserRow,
} from "./control/users";
import { sendEmail } from "./email";
import { isDev, type TenantWorkerEnv } from "./env";
import { conflict, forbidden, invalid, notFound, unauthorized } from "./errors";
import { forwardToUpstream } from "./gateway";
import { clientIp, csrfGuard, errorHandler, parse, rateLimit, readJson, requestContext, type BaseVars } from "./http/base";
import { listQuerySchema } from "./http/pagination";
import { buildPermissions, permissionsOf, type Actor, type ModuleContext, type ModuleDefinition } from "./modules";
import { bindTenant, purgeTenantStorage, tenantCrypto, TenantDb, type TenantContext } from "./tenancy/context";
import { hostnameOf, invalidateHostCache, resolveHost, type HostResolution } from "./tenancy/resolve";
import { createApiKey, listApiKeys, listTenantAudit, revokeApiKey, verifyApiKey, writeTenantAudit } from "./tenancy/store";
import { CORE_TENANT_MIGRATIONS, type TenantMigration } from "./tenancy/tenant-do";

const SESSION_COOKIE = "rose_session";
const ROOT_SCOPE = "root";

interface Vars extends BaseVars {
  host: HostResolution;
  tenant: TenantContext;
  tenantRow: TenantRow;
  actor: Actor;
  db: TenantDb;
}
type Env = { Bindings: TenantWorkerEnv; Variables: Vars };
type Ctx = Context<Env>;

export interface TenantAppOptions {
  modules: ModuleDefinition[];
}

/** Migrations for every tenant database: platform tables first, then each module's. */
export function tenantMigrations(modules: ModuleDefinition[]): TenantMigration[] {
  return [...CORE_TENANT_MIGRATIONS, ...modules.flatMap((m) => m.migrations)];
}

const JOB_PAYLOAD_FIELD = "jobs.payload";

/** Background work owned by the tenant worker: platform jobs plus every module's jobs. */
export function tenantJobHandlers(modules: ModuleDefinition[]): Record<string, JobHandler<TenantWorkerEnv>> {
  const handlers: Record<string, JobHandler<TenantWorkerEnv>> = {
    // Destroys the tenant's private database (and with it the only copy of its wrapped
    // data key), then removes its identity records. Idempotent, so retries are safe.
    "tenant.purge": async (env, _job, payload) => {
      const tenantId = String(payload.tenantId ?? "");
      const row = await getTenant(env.DB, tenantId);
      if (row && row.status !== "deleting") throw new Error("Tenant is not marked for deletion");
      await purgeTenantStorage(env, tenantId);
      await deleteTenantRecords(env.DB, tenantId);
      invalidateHostCache();
      return { done: true, result: { purged: tenantId } };
    },
  };
  for (const mod of modules) {
    for (const [name, run] of Object.entries(mod.jobs ?? {})) {
      // A module job runs for the tenant recorded on the job row when it was queued by
      // that tenant's own request. The payload can not redirect it to another tenant.
      handlers[`m.${mod.id}.${name}`] = async (env, job, payload) => {
        const row = await getTenant(env.DB, job.scope);
        // The tenant was deleted or suspended after queuing: drop the work instead of retrying it.
        if (!row || row.status === "deleting") return { done: true, result: { skipped: "workspace no longer exists" } };
        if (row.status !== "active") return { done: false, retryInMs: 10 * 60_000, note: "Workspace is suspended" };
        const tenant = bindTenant(row);
        const db = new TenantDb(env, tenant);
        // Module payloads are stored sealed with the tenant key (see `enqueue`), never as plain JSON.
        const crypto = () => tenantCrypto(env, tenant);
        const sealed = typeof payload.enc === "string" ? payload.enc : null;
        const plain = sealed ? (JSON.parse(await (await crypto()).decrypt(sealed, JOB_PAYLOAD_FIELD)) as Record<string, unknown>) : {};
        const result = await run(
          {
            tenant,
            db,
            crypto,
            audit: (action, target, meta) => writeTenantAudit(db, { actor: `job:${job.created_by ?? "system"}`, action: `${mod.id}.${action}`, target, meta }),
          },
          plain,
        );
        return { done: true, result };
      };
    }
  }
  return handlers;
}

export async function tenantTick(env: TenantWorkerEnv, modules: ModuleDefinition[]): Promise<void> {
  await runDueJobs(env, tenantJobHandlers(modules));
  await sweepExpired(env.DB);
}

/** The complete tenant worker: `export default createTenantWorker({ modules })`. */
export function createTenantWorker(options: TenantAppOptions) {
  const app = createTenantApp(options);
  return {
    app,
    fetch: (request: Request, env: TenantWorkerEnv, ctx: ExecutionContext) => app.fetch(request, env, ctx),
    /** Jobs start as soon as they are queued. */
    queue: async (batch: { messages: readonly { body: unknown; ack(): void }[] }, env: TenantWorkerEnv) => runJobMessages(env, tenantJobHandlers(options.modules), batch),
    /** Hourly: expiry sweep, plus a safety net for jobs whose queue message was lost. */
    scheduled: async (_event: unknown, env: TenantWorkerEnv, _ctx: unknown) => tenantTick(env, options.modules),
  };
}

export function createTenantApp(options: TenantAppOptions) {
  const { modules } = options;
  const permissions = buildPermissions(modules);
  const can = (role: Role, permission: string) => permissions[permission]?.includes(role) ?? false;

  const app = new Hono<Env>();
  app.onError(errorHandler);
  app.use("*", requestContext as never);
  app.use("/api/*", csrfGuard);
  app.use("/svc/*", csrfGuard);
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.ok) c.res.headers.set("Cache-Control", "private, no-cache");
  });
  app.use("/api/*", etag());

  // ── Tenant resolution: the request host decides the tenant. Nothing else can. ──
  app.use("*", async (c, next) => {
    c.set("host", await resolveHost(c.env.DB, hostnameOf(c.req.raw), c.env.APP_BASE_DOMAIN));
    await next();
  });

  const tenantUrl = (c: Ctx, slug: string, path = "/"): string => {
    const u = new URL(c.req.url);
    return `${u.protocol}//${slug}.${c.env.APP_BASE_DOMAIN}${u.port ? `:${u.port}` : ""}${path}`;
  };

  /** Audit a new member in the workspace's own log and tell the other owners (only when there are several). */
  const recordJoin = async (c: Ctx, tenant: TenantRow, user: UserRow, role: Role): Promise<void> => {
    await writeTenantAudit(new TenantDb(c.env, bindTenant(tenant)), { actor: user.email, action: "member.join", target: user.id, meta: { role }, ip: clientIp(c) });
    const owners = (await c.env.DB.prepare("SELECT u.email AS email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'owner' AND m.user_id != ? LIMIT 100").bind(tenant.id, user.id).all<{ email: string }>()).results;
    const others = owners.map((o) => o.email);
    if (role !== "owner" && others.length < 2) return;
    if (role === "owner" && others.length < 1) return;
    c.executionCtx.waitUntil(
      Promise.all(
        others.map((to) =>
          sendEmail(c.env, { to, subject: `New ${role} in ${tenant.name}`, text: `${user.email} joined ${tenant.name} as ${role}.\n\nIf this is unexpected, review the member list and audit log at ${tenantUrl(c, tenant.slug)}` }).catch((err) =>
            console.error(JSON.stringify({ level: "error", at: "join-email", error: String(err) })),
          ),
        ),
      ),
    );
  };

  const realmFor = (c: Ctx, tenant: TenantRow): AuthRealm => ({
    scope: tenant.id,
    displayName: tenant.name,
    cookie: SESSION_COOKIE,
    eligible: async (email) => {
      const member = await c.env.DB.prepare("SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND u.email = ?").bind(tenant.id, email).first();
      return !!member || !!(await getPendingInvitation(c.env.DB, tenant.id, email));
    },
    admit: async (user: UserRow) => {
      if (await getMembership(c.env.DB, tenant.id, user.id)) return true;
      const role = await redeemInvitation(c.env.DB, tenant.id, user);
      if (!role) return false;
      await recordJoin(c, tenant, user, role);
      return true;
    },
    audit: (e) => writeTenantAudit(new TenantDb(c.env, bindTenant(tenant)), e),
  });

  /** The active tenant for this host, or 404. Suspended and deleting tenants serve nothing. */
  const activeTenant = (c: Ctx): TenantRow => {
    const host = c.get("host");
    if (host.kind !== "tenant" || host.tenant.status === "deleting") throw notFound();
    if (host.tenant.status !== "active") throw forbidden("This workspace is suspended. Contact support.");
    return host.tenant;
  };

  // ── Bootstrap: one call tells the SPA where it is and who is signed in ─────────
  app.get("/api/bootstrap", async (c) => {
    const host = c.get("host");
    const base = { app: { name: c.env.APP_NAME, baseDomain: c.env.APP_BASE_DOMAIN }, dev: isDev(c.env), modules: modules.map((m) => m.id), upstream: (c.env.UPSTREAM_MODE ?? "off") !== "off" };
    if (host.kind === "root") return c.json({ ...base, host: "root" });
    if (host.kind === "unknown" || host.tenant.status === "deleting") return c.json({ ...base, host: "unknown" });
    const t = host.tenant;
    const tenant = { name: t.name, slug: t.slug, status: t.status };
    if (t.status !== "active") return c.json({ ...base, host: "tenant", tenant, session: null });
    const s = await currentSession(c, realmFor(c, t));
    if (!s) return c.json({ ...base, host: "tenant", tenant, session: null });
    const passkeys = await listPasskeys(c.env.DB, s.userId, t.id);
    return c.json({
      ...base, host: "tenant", tenant,
      session: { user: { id: s.userId, email: s.email, name: s.name }, role: s.role, permissions: permissionsOf(permissions, s.role as Role), hasPasskey: passkeys.length > 0, method: s.method },
    });
  });

  // ── Root host: sign up, or find your workspaces ───────────────────────────────
  const rootOnly = (c: Ctx) => {
    if (c.get("host").kind !== "root") throw notFound();
  };

  app.post("/api/root/code/request", async (c) => {
    rootOnly(c);
    const email = normalizeEmail((await readJson(c, z.object({ email: z.string().max(254) }))).email);
    return c.json(await requestCode(c, { scope: ROOT_SCOPE, label: c.env.APP_NAME, email, eligible: async () => true }));
  });

  app.post("/api/root/code/verify", async (c) => {
    rootOnly(c);
    const body = await readJson(c, z.object({ email: z.string().max(254), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.") }));
    const email = normalizeEmail(body.email);
    await checkCode(c, ROOT_SCOPE, email, body.code);
    const user = await ensureUser(c.env.DB, email);
    // The ticket proves "this browser verified this email" for the next 15 minutes.
    const ticket = await createHandoff(c.env.DB, { purpose: "signup", userId: user.id, scope: ROOT_SCOPE, ttlMs: 15 * 60_000 });
    const workspaces = await listWorkspacesForUser(c.env.DB, user.id);
    return c.json({ ticket, workspaces: workspaces.map((w) => ({ slug: w.slug, name: w.name, role: w.role })) });
  });

  app.get("/api/root/slug", async (c) => {
    rootOnly(c);
    await rateLimit(c, `slug-ip:${clientIp(c) ?? "unknown"}`);
    return c.json({ available: await slugAvailable(c.env.DB, c.req.query("slug") ?? "") });
  });

  /** Spend the ticket to enter an existing workspace, or to create a new one. */
  app.post("/api/root/enter", async (c) => {
    rootOnly(c);
    const body = await readJson(c, z.object({ ticket: z.string().max(100), slug: z.string().max(40).optional(), create: z.object({ name: z.string().max(80), slug: z.string().max(40) }).optional() }));
    // Check the address first: a typo must not cost the person their verified ticket.
    if (body.create && !(await slugAvailable(c.env.DB, validateSlug(body.create.slug)))) {
      throw conflict("That workspace address is taken.", { slug: "Already in use." });
    }
    const userId = await consumeHandoff(c.env.DB, body.ticket, "signup", ROOT_SCOPE);
    if (!userId) throw unauthorized("Your verification expired. Start again.");
    let tenant: TenantRow | null;
    if (body.create) {
      tenant = await createTenant(c.env.DB, body.create);
      await addMembership(c.env.DB, tenant.id, userId, "owner");
      await writeTenantAudit(new TenantDb(c.env, bindTenant(tenant)), { actor: userId, action: "member.join", target: userId, meta: { role: "owner" }, ip: clientIp(c) });
      await writePlatformAudit(c.env.DB, { actor: userId, action: "tenant.signup", target: tenant.id, meta: { slug: tenant.slug }, ip: clientIp(c) });
    } else {
      tenant = body.slug ? await c.env.DB.prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'").bind(body.slug).first<TenantRow>() : null;
      if (!tenant || !(await getMembership(c.env.DB, tenant.id, userId))) throw notFound();
    }
    const handoff = await createHandoff(c.env.DB, { purpose: "session", userId, scope: tenant.id });
    return c.json({ url: tenantUrl(c, tenant.slug, `/auth/handoff?token=${handoff}`) });
  });

  // ── Tenant host: authentication ───────────────────────────────────────────────
  app.get("/auth/handoff", async (c) => {
    const tenant = activeTenant(c);
    const realm = realmFor(c, tenant);
    const userId = await consumeHandoff(c.env.DB, c.req.query("token") ?? "", "session", tenant.id);
    const user = userId ? await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>() : null;
    if (user && (await realm.admit(user))) await startSession(c, realm, user, "code");
    return c.redirect("/", 302);
  });

  app.route("/api/auth", createAuthRoutes(async (c) => realmFor(c as unknown as Ctx, activeTenant(c as unknown as Ctx))) as never);

  // ── Everything below requires an actor that belongs to this host's tenant ─────
  const authenticate = async (c: Ctx, next: () => Promise<void>) => {
    const row = activeTenant(c);
    const tenant = bindTenant(row);
    const db = new TenantDb(c.env, tenant);
    let actor: Actor | null = null;
    const authz = c.req.header("Authorization");
    // Any Authorization header selects the API-key path, even a malformed one. A session
    // cookie never rescues a bad token, so one request has exactly one identity.
    if (authz !== undefined) {
      // API keys bypass the session query, so re-check tenant status against the database here.
      const fresh = await getTenant(c.env.DB, row.id);
      if (fresh?.status !== "active") throw forbidden("This workspace is suspended.");
      const key = /^Bearer\s+\S/.test(authz) ? await verifyApiKey(db, authz.replace(/^Bearer\s+/, "").trim()) : null;
      if (key) actor = { type: "api_key", id: key.id, label: `key:${key.name}`, role: key.role };
      // Only failed attempts spend rate-limit budget, so legitimate API traffic is never throttled by it.
      else await rateLimit(c, `key-fail:${clientIp(c) ?? "unknown"}`);
    } else {
      const s = await currentSession(c, { scope: row.id, cookie: SESSION_COOKIE });
      if (s) actor = { type: "user", id: s.userId, label: s.email, role: s.role as Role, sessionId: s.publicId, name: s.name };
    }
    if (!actor) throw unauthorized();
    c.set("tenantRow", row);
    c.set("tenant", tenant);
    c.set("db", db);
    c.set("actor", actor);
    await next();
  };
  app.use("/api/*", authenticate);
  app.use("/svc/*", authenticate);

  const need = (c: Ctx, permission: string): Actor => {
    const actor = c.get("actor");
    if (!can(actor.role, permission)) throw forbidden();
    return actor;
  };
  const audit = (c: Ctx, action: string, target?: string | null, meta?: unknown) =>
    writeTenantAudit(c.get("db"), { actor: c.get("actor").label, action, target, meta, ip: clientIp(c) });
  const listQ = (c: Ctx) => parse(listQuerySchema, c.req.query());

  app.get("/api/overview", async (c) => {
    const t = c.get("tenant");
    const [members, invites, keys, recent] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ?").bind(t.id).first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM invitations WHERE tenant_id = ?").bind(t.id).first<{ n: number }>(),
      c.get("db").first<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys"),
      can(c.get("actor").role, "audit:read") ? listTenantAudit(c.get("db"), { page: 1, pageSize: 6, q: "", sort: "" }) : null,
    ]);
    return c.json({ members: members?.n ?? 0, invitations: invites?.n ?? 0, apiKeys: keys?.n ?? 0, recent: recent?.items ?? [] });
  });

  // Members & invitations
  app.get("/api/members", async (c) => {
    need(c, "members:read");
    return c.json(await listMembers(c.env.DB, c.get("tenant").id, { ...listQ(c), role: c.req.query("role") }));
  });
  const roleSchema = z.enum(["owner", "admin", "member"]);
  app.patch("/api/members/:userId", async (c) => {
    const actor = need(c, "members:manage");
    const { role } = await readJson(c, z.object({ role: roleSchema }));
    await changeMemberRole(c.env.DB, c.get("tenant").id, actor.role, c.req.param("userId"), role);
    await audit(c, "member.role", c.req.param("userId"), { role });
    return c.json({ ok: true });
  });
  app.delete("/api/members/:userId", async (c) => {
    const actor = need(c, "members:manage");
    await removeMember(c.env.DB, c.get("tenant").id, actor.role, c.req.param("userId"));
    await audit(c, "member.remove", c.req.param("userId"));
    return c.json({ ok: true });
  });
  app.get("/api/invitations", async (c) => {
    need(c, "members:read");
    return c.json(await listInvitations(c.env.DB, c.get("tenant").id, listQ(c)));
  });
  app.post("/api/invitations", async (c) => {
    const actor = need(c, "members:manage");
    const body = await readJson(c, z.object({ email: z.string().max(254), role: roleSchema.default("member") }));
    const t = c.get("tenant");
    const inv = await createInvitation(c.env.DB, t.id, { email: body.email, role: body.role, invitedBy: actor.label, actorRole: actor.role });
    await audit(c, "invitation.create", inv.email, { role: inv.role });
    const link = tenantUrl(c, t.slug);
    c.executionCtx.waitUntil(
      sendEmail(c.env, { to: inv.email, subject: `You're invited to ${t.name}`, text: `${actor.label} invited you to ${t.name}.\n\nSign in with this email address at ${link}` }).catch((err) =>
        console.error(JSON.stringify({ level: "error", at: "invite-email", error: String(err) })),
      ),
    );
    return c.json(inv, 201);
  });
  app.delete("/api/invitations/:id", async (c) => {
    need(c, "members:manage");
    await revokeInvitation(c.env.DB, c.get("tenant").id, c.req.param("id"));
    await audit(c, "invitation.revoke", c.req.param("id"));
    return c.json({ ok: true });
  });

  // API keys
  app.get("/api/api-keys", async (c) => {
    need(c, "apikeys:manage");
    return c.json(await listApiKeys(c.get("db"), listQ(c)));
  });
  app.post("/api/api-keys", async (c) => {
    const actor = need(c, "apikeys:manage");
    if (actor.type !== "user") throw forbidden("API keys can only be created by a signed-in person.");
    const body = await readJson(c, z.object({ name: z.string().trim().min(1, "Give the key a name.").max(80), role: z.enum(["admin", "member"]).default("member"), expiresInDays: z.number().int().min(1).max(3650).nullable().default(null) }));
    if (body.role === "admin" && actor.role === "member") throw forbidden();
    const created = await createApiKey(c.get("db"), { ...body, createdBy: actor.label });
    await audit(c, "apikey.create", created.item.id, { name: created.item.name, role: created.item.role });
    return c.json(created, 201);
  });
  app.delete("/api/api-keys/:id", async (c) => {
    need(c, "apikeys:manage");
    await revokeApiKey(c.get("db"), c.req.param("id"));
    await audit(c, "apikey.revoke", c.req.param("id"));
    return c.json({ ok: true });
  });

  // Audit & background activity
  app.get("/api/audit", async (c) => {
    need(c, "audit:read");
    return c.json(await listTenantAudit(c.get("db"), { ...listQ(c), action: c.req.query("action") }));
  });
  app.get("/api/jobs", async (c) => c.json(await listJobs(c.env.DB, c.get("tenant").id, { ...listQ(c), status: c.req.query("status") })));

  // Workspace settings
  app.patch("/api/workspace", async (c) => {
    need(c, "workspace:update");
    const body = await readJson(c, z.object({ name: z.string().max(80) }));
    const row = await updateTenant(c.env.DB, c.get("tenant").id, { name: body.name });
    invalidateHostCache();
    await audit(c, "workspace.rename", null, { name: row.name });
    return c.json({ name: row.name, slug: row.slug });
  });
  app.post("/api/workspace/delete", async (c) => {
    const actor = need(c, "workspace:delete");
    if (actor.type !== "user") throw forbidden("Only a signed-in owner can delete a workspace.");
    const t = c.get("tenant");
    const { confirm } = await readJson(c, z.object({ confirm: z.string().max(80) }));
    if (confirm !== t.slug) throw invalid("Type the workspace address to confirm.", { confirm: "Does not match." });
    await markTenantDeleting(c.env.DB, t.id);
    invalidateHostCache();
    await enqueueJob(c.env, { type: "tenant.purge", scope: "platform", title: `Delete workspace ${t.slug}`, payload: { tenantId: t.id }, createdBy: actor.label });
    await writePlatformAudit(c.env.DB, { actor: actor.label, action: "tenant.delete.requested", target: t.id, meta: { slug: t.slug, by: "owner" }, ip: clientIp(c) });
    return c.json({ ok: true }, 202);
  });

  // ── Modules ───────────────────────────────────────────────────────────────────
  for (const mod of modules) {
    for (const route of mod.routes) {
      app.on(route.method, `/api/m/${mod.id}${route.path === "/" ? "" : route.path}`, async (c) => {
        need(c, route.permission);
        const tenant = c.get("tenant");
        const ctx: ModuleContext = {
          tenant,
          actor: c.get("actor"),
          db: c.get("db"),
          crypto: () => tenantCrypto(c.env, tenant),
          audit: (action, target, meta) => audit(c, `${mod.id}.${action}`, target, meta),
          enqueue: async (job, title, payload) => {
            if (!mod.jobs?.[job]) throw new Error(`Module ${mod.id} has no job "${job}"`);
            // Tenant business data must not sit in the shared control-plane database in clear text.
            const sealed = { enc: await (await tenantCrypto(c.env, tenant)).encrypt(JSON.stringify(payload ?? {}), JOB_PAYLOAD_FIELD) };
            const row = await enqueueJob(c.env, { type: `m.${mod.id}.${job}`, scope: tenant.id, title, payload: sealed, createdBy: c.get("actor").label });
            return row.id;
          },
          req: {
            param: (name) => c.req.param(name) ?? "",
            query: (name) => c.req.query(name),
            list: () => listQ(c),
            body: (schema) => readJson(c, schema),
          },
        };
        const result = await route.handler(ctx);
        return c.json(result ?? { ok: true }, route.method === "POST" ? 201 : 200);
      });
    }
  }

  // ── Gateway to the service being multi-tenanted ───────────────────────────────
  app.all("/svc/*", async (c) => {
    const actor = need(c, "service:use");
    return forwardToUpstream(c.env, c.req.raw, c.get("tenant"), actor);
  });

  // Development only: lets `pnpm dev` drive background jobs without a cron trigger.
  app.post("/__dev/tick", async (c) => {
    if (c.env.ENVIRONMENT !== "development") throw notFound();
    await tenantTick(c.env, modules);
    return c.json({ ok: true });
  });

  app.all("/api/*", () => {
    throw notFound();
  });

  return app;
}
