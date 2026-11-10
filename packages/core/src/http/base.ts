// SPDX-License-Identifier: Apache-2.0
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ZodType } from "zod";
import { type CoreEnv, isDev } from "../env";
import { AppError, badRequest, forbidden, invalid, misconfigured, tooMany } from "../errors";
import { newId } from "../ids";

export interface BaseVars {
  requestId: string;
}
type AnyCtx = Context<{ Bindings: CoreEnv; Variables: BaseVars }>;

const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Request id + security headers on every worker response. API responses are never cached by intermediaries. */
export const requestContext: MiddlewareHandler<{ Bindings: CoreEnv; Variables: BaseVars }> = async (c, next) => {
  c.set("requestId", newId("req"));
  await next();
  const h = c.res.headers;
  h.set("X-Request-Id", c.get("requestId"));
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", API_CSP);
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  if (c.env.ENVIRONMENT === "production") h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
};

/**
 * CSRF defence for cookie-authenticated requests: a state-changing request must come
 * from this exact origin. Bearer-token requests are exempt because browsers never attach
 * those automatically (and cookies are ignored whenever a bearer token is present).
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (c.req.header("Authorization")?.startsWith("Bearer ")) return next();
  const origin = c.req.header("Origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === new URL(c.req.url).host;
    } catch {
      ok = false;
    }
    if (!ok) throw forbidden("Cross-site request blocked.");
  } else if (c.req.header("Sec-Fetch-Site") !== "same-origin") {
    throw forbidden("Cross-site request blocked.");
  }
  return next();
};

/** Converts errors to a stable JSON shape. Unknown errors are logged with the request id and never echoed. */
export function errorHandler(err: unknown, c: Context): Response {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, fields: err.fields, requestId } }, err.status);
  }
  console.error(JSON.stringify({ level: "error", requestId, path: new URL(c.req.url).pathname, error: err instanceof Error ? err.stack ?? err.message : String(err) }));
  return c.json({ error: { code: "internal", message: "Something went wrong on our side. Try again.", requestId } }, 500);
}

const MAX_BODY = 100_000;

/** Parse and validate a JSON body. Unknown keys are dropped by the schema; size is capped. */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw badRequest("Send JSON with Content-Type: application/json.");
  }
  // Refuse an oversized body from its declared length, before spending time reading it.
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_BODY * 4) throw new AppError(413, "too_large", "Request body is too large.");
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new AppError(413, "too_large", "Request body is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }
  return parse(schema, raw);
}

export function parse<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  throw invalid("Some fields need attention.", fields);
}

export const clientIp = (c: Context): string | null => c.req.header("CF-Connecting-IP") ?? null;

/** Fails closed in production if the limiter binding is missing. */
export async function rateLimit(c: AnyCtx | Context, key: string): Promise<void> {
  const env = c.env as CoreEnv;
  if (!env.RL_AUTH) {
    if (!isDev(env)) throw misconfigured("Rate limiter binding RL_AUTH is missing.");
    return;
  }
  const { success } = await env.RL_AUTH.limit({ key });
  if (!success) throw tooMany();
}

// ── Session cookie ─────────────────────────────────────────────────────────────

/**
 * `__Host-` cookies are bound to the exact host (no Domain attribute, Secure, Path=/), so a
 * tenant on one subdomain can never read or overwrite another tenant's session cookie.
 * Plain-HTTP localhost development can not use the prefix, so it is dropped there only.
 */
function cookieSpec(c: Context, base: string): { name: string; secure: boolean } {
  const secure = new URL(c.req.url).protocol === "https:";
  if (!secure && !isDev(c.env as CoreEnv)) throw misconfigured("Sessions require HTTPS.");
  return { name: secure ? `__Host-${base}` : base, secure };
}

export function setSessionCookie(c: Context, base: string, token: string, expiresAt: number): void {
  const { name, secure } = cookieSpec(c, base);
  setCookie(c, name, token, { path: "/", httpOnly: true, secure, sameSite: "Lax", expires: new Date(expiresAt) });
}

export function readSessionCookie(c: Context, base: string): string | undefined {
  return getCookie(c, cookieSpec(c, base).name);
}

export function clearSessionCookie(c: Context, base: string): void {
  const { name, secure } = cookieSpec(c, base);
  deleteCookie(c, name, { path: "/", secure });
}
