// SPDX-License-Identifier: Apache-2.0
import { Hono, type Context } from "hono";
import { z } from "zod";
import { formatKey, issueLoginCode, normalizeKey, verifyLoginCode, verifyLoginKey } from "../control/otp";
import { assertFreshSession, createSession, listSessions, readSession, revokeSessionById, revokeSessionToken, type SessionInfo } from "../control/sessions";
import { ensureUser, getUserByEmail, normalizeEmail, setUserName, touchLogin, type UserRow } from "../control/users";
import { sendEmail } from "../email";
import { type CoreEnv, isDev } from "../env";
import { unauthorized } from "../errors";
import { clearSessionCookie, clientIp, rateLimit, requesterKey, readJson, readSessionCookie, setSessionCookie, type BaseVars } from "../http/base";
import { beginLogin, beginRegistration, deletePasskey, finishLogin, finishRegistration, listPasskeys, type PasskeySite } from "./passkeys";

export interface AuthRealm {
  scope: string;
  displayName: string;
  cookie: string;
  eligible(email: string): Promise<boolean>;
  admit(user: UserRow): Promise<boolean>;
  audit(event: { actor: string; action: string; ip: string | null }): Promise<void>;
  enforcePasskey?: boolean;
}

type Env = { Bindings: CoreEnv; Variables: BaseVars };
type Ctx = Context<Env>;

const BAD_CODE = "That code is not valid or has expired.";

export async function currentSession(c: Context, realm: Pick<AuthRealm, "scope" | "cookie">): Promise<SessionInfo | null> {
  const token = readSessionCookie(c, realm.cookie);
  return token ? readSession((c.env as CoreEnv).DB, token, realm.scope) : null;
}

export async function startSession(c: Context, realm: AuthRealm, user: UserRow, method: string): Promise<void> {
  const env = c.env as CoreEnv;
  const { token, expiresAt } = await createSession(env.DB, { userId: user.id, scope: realm.scope, method, ip: clientIp(c), ...(c.req.header("User-Agent") !== undefined ? { userAgent: c.req.header("User-Agent") } : {}) });
  setSessionCookie(c, realm.cookie, token, expiresAt);
  await touchLogin(env.DB, user.id);
  await realm.audit({ actor: user.email, action: `auth.login.${method}`, ip: clientIp(c) });
}

export async function requestCode(c: Context, opts: { scope: string; label: string; email: string; eligible: () => Promise<boolean> }): Promise<{ ok: true; devCode?: string; devKey?: string }> {
  const env = c.env as CoreEnv;
  const requester = requesterKey(clientIp(c));
  await rateLimit(c, `code-ip:${requester}`);
  await rateLimit(c, `code:${opts.scope}:${opts.email}:${requester}`);
  const link = `${new URL(c.req.url).origin}/#k=`;
  const work = async (): Promise<{ code: string; key: string } | undefined> => {
    if (!(await opts.eligible())) return undefined;
    const issued = await issueLoginCode(env.DB, env.ROSE_MASTER_KEY, opts.scope, opts.email, requester);
    if (!issued) return undefined;
    const text = `Your sign-in code for ${opts.label} is ${issued.code}\n\nTo sign in on another device, use this long code: ${formatKey(issued.key)}\n\nOr open ${link}${issued.key}\n\nIt expires in 10 minutes. If you did not request it, you can ignore this email.`;
    await sendEmail(env, { to: opts.email, subject: `${issued.code} is your ${opts.label} sign-in code`, text });
    return issued;
  };
  if (isDev(env)) {
    const issued = await work();
    if (issued === undefined) return { ok: true };
    return { ok: true, devCode: issued.code, devKey: issued.key };
  }
  c.executionCtx.waitUntil(work().catch((err) => console.error(JSON.stringify({ level: "error", at: "requestCode", error: String(err) }))));
  return { ok: true };
}

export async function checkCode(c: Context, scope: string, email: string, code: string): Promise<void> {
  const env = c.env as CoreEnv;
  const requester = requesterKey(clientIp(c));
  await rateLimit(c, `verify-ip:${requester}`);
  await rateLimit(c, `verify:${scope}:${email}:${requester}`);
  if (!(await verifyLoginCode(env.DB, env.ROSE_MASTER_KEY, scope, email, code, requester))) throw unauthorized(BAD_CODE);
}

export async function checkLink(c: Context, scope: string, email: string, key: string): Promise<void> {
  const env = c.env as CoreEnv;
  const requester = requesterKey(clientIp(c));
  await rateLimit(c, `verify-ip:${requester}`);
  await rateLimit(c, `verify:${scope}:${email}:${requester}`);
  if (!(await verifyLoginKey(env.DB, env.ROSE_MASTER_KEY, scope, email, key))) throw unauthorized(BAD_CODE);
}

async function codeDisabled(db: D1Database, realm: AuthRealm, email: string): Promise<boolean> {
  if (!realm.enforcePasskey) return false;
  const user = await getUserByEmail(db, email);
  return !!user && (await listPasskeys(db, user.id, realm.scope)).length > 0;
}

const emailBody = z.object({ email: z.string().max(254) });
const verifyBody = z.object({ email: z.string().max(254), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.") });
const linkBody = z.object({ email: z.string().max(254), key: z.string().trim().min(1).max(60) });

export function createAuthRoutes(getRealm: (c: Ctx) => Promise<AuthRealm>) {
  const app = new Hono<Env>();

  const site = (c: Ctx, realm: AuthRealm): PasskeySite => {
    const url = new URL(c.req.url);
    return { scope: realm.scope, rpId: url.hostname, origin: url.origin, rpName: realm.displayName };
  };
  const requireSession = async (c: Ctx, realm: AuthRealm): Promise<SessionInfo> => {
    const s = await currentSession(c, realm);
    if (!s) throw unauthorized();
    return s;
  };

  app.post("/code/request", async (c) => {
    const realm = await getRealm(c);
    const email = normalizeEmail((await readJson(c, emailBody)).email);
    return c.json(await requestCode(c, { scope: realm.scope, label: realm.displayName, email, eligible: async () => (await realm.eligible(email)) && !(await codeDisabled(c.env.DB, realm, email)) }));
  });

  app.post("/code/verify", async (c) => {
    const realm = await getRealm(c);
    const body = await readJson(c, verifyBody);
    const email = normalizeEmail(body.email);
    await checkCode(c, realm.scope, email, body.code);
    if (await codeDisabled(c.env.DB, realm, email)) throw unauthorized(BAD_CODE);
    const user = await ensureUser(c.env.DB, email);
    if (!(await realm.admit(user))) throw unauthorized(BAD_CODE);
    await startSession(c, realm, user, "code");
    return c.json({ ok: true });
  });

  app.post("/code/link", async (c) => {
    const realm = await getRealm(c);
    const body = await readJson(c, linkBody);
    const email = normalizeEmail(body.email);
    await checkLink(c, realm.scope, email, normalizeKey(body.key));
    if (await codeDisabled(c.env.DB, realm, email)) throw unauthorized(BAD_CODE);
    const user = await ensureUser(c.env.DB, email);
    if (!(await realm.admit(user))) throw unauthorized(BAD_CODE);
    await startSession(c, realm, user, "link");
    return c.json({ ok: true });
  });

  app.post("/passkey/login/options", async (c) => {
    const realm = await getRealm(c);
    await rateLimit(c, `pk-ip:${requesterKey(clientIp(c))}`);
    return c.json(await beginLogin(c.env.DB, site(c, realm)));
  });

  app.post("/passkey/login/verify", async (c) => {
    const realm = await getRealm(c);
    const body = await readJson(c, z.object({ id: z.string().max(64), response: z.looseObject({ id: z.string().max(1024) }) }));
    const userId = await finishLogin(c.env.DB, site(c, realm), body.id, body.response as never);
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
    if (!user || !(await realm.admit(user))) throw unauthorized("That passkey could not be verified.");
    await startSession(c, realm, user, "passkey");
    return c.json({ ok: true });
  });

  app.post("/passkey/register/options", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    await assertFreshForPasskeys(c, realm, s);
    return c.json(await beginRegistration(c.env.DB, site(c, realm), { id: s.userId, email: s.email, name: s.name }));
  });

  app.post("/passkey/register/verify", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    await assertFreshForPasskeys(c, realm, s);
    const body = await readJson(c, z.object({ id: z.string().max(64), name: z.string().max(60).default("Passkey"), response: z.looseObject({ id: z.string().max(1024) }) }));
    await finishRegistration(c.env.DB, site(c, realm), s.userId, body.id, body.response as never, body.name);
    await realm.audit({ actor: s.email, action: "auth.passkey.add", ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.get("/passkeys", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    return c.json({ items: await listPasskeys(c.env.DB, s.userId, realm.scope) });
  });

  app.delete("/passkeys/:id", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    await assertFreshForPasskeys(c, realm, s);
    await deletePasskey(c.env.DB, s.userId, realm.scope, c.req.param("id"));
    await realm.audit({ actor: s.email, action: "auth.passkey.remove", ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.get("/sessions", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    const items = await listSessions(c.env.DB, s.userId, realm.scope);
    return c.json({ items: items.map((i) => ({ ...i, current: i.id === s.publicId })) });
  });

  app.delete("/sessions/:id", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    await revokeSessionById(c.env.DB, s.userId, realm.scope, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.patch("/profile", async (c) => {
    const realm = await getRealm(c);
    const s = await requireSession(c, realm);
    const body = await readJson(c, z.object({ name: z.string().trim().max(80) }));
    await setUserName(c.env.DB, s.userId, body.name);
    return c.json({ ok: true });
  });

  app.post("/logout", async (c) => {
    const realm = await getRealm(c);
    const token = readSessionCookie(c, realm.cookie);
    if (token) await revokeSessionToken(c.env.DB, token);
    clearSessionCookie(c, realm.cookie);
    return c.json({ ok: true });
  });

  return app;
}

async function assertFreshForPasskeys(c: Context, realm: AuthRealm, s: SessionInfo): Promise<void> {
  const has = (await listPasskeys((c.env as CoreEnv).DB, s.userId, realm.scope)).length > 0;
  assertFreshSession(s, { passkey: has });
}
