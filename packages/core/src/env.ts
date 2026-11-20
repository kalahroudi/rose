// SPDX-License-Identifier: Apache-2.0
import type { JobQueue } from "./control/jobs";
import type { TenantDurableObject } from "./tenancy/tenant-do";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The part of Cloudflare's `send_email` binding Rose uses. */
interface EmailSender {
  send(message: { from: string | { email: string; name: string }; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

/** Bindings shared by every Rose worker. */
export interface CoreEnv {
  /** Control-plane database: tenants, identities, sessions. Never holds tenant business data. */
  DB: D1Database;
  ENVIRONMENT: "development" | "production";
  /** base64 of 32 random bytes. Root of all key derivation for this worker. */
  ROSE_MASTER_KEY: string;
  /** Set during rotation so data wrapped under the old key can still be opened. */
  ROSE_MASTER_KEY_PREVIOUS?: string;
  APP_NAME: string;
  /** Domain tenants live under: `<slug>.<APP_BASE_DOMAIN>`. */
  APP_BASE_DOMAIN: string;
  EMAIL_PROVIDER?: "console" | "resend" | "cloudflare";
  EMAIL_FROM?: string;
  /** Cloudflare Email Service `send_email` binding, used when EMAIL_PROVIDER is "cloudflare". */
  EMAIL?: EmailSender;
  RESEND_API_KEY?: string;
  RL_AUTH?: RateLimiter;
  /** Queue that wakes the tenant worker to run a job. Producer binding in both workers. */
  APP_JOBS?: JobQueue;
  /** Queue that wakes the operator worker. Bound in the operator worker only. */
  ADMIN_JOBS?: JobQueue;
}

/** Bindings of the tenant-facing app worker. */
export interface TenantWorkerEnv extends CoreEnv {
  TENANT_DO: DurableObjectNamespace<TenantDurableObject>;
  UPSTREAM_MODE?: "off" | "origin" | "dispatch";
  UPSTREAM_ORIGIN?: string;
  UPSTREAM_SIGNING_SECRET?: string;
  DISPATCHER?: { get(name: string): Fetcher };
  /** Most workspaces one person may own via self-service signup. Any positive integer string; anything else means 5. */
  MAX_WORKSPACES_PER_USER?: string;
}

export const DEFAULT_MAX_WORKSPACES_PER_USER = 5;

/** Parse `MAX_WORKSPACES_PER_USER`: digits only, value >= 1 (large values are fine); everything else falls back to the default. */
export function maxWorkspacesPerUser(env: Pick<TenantWorkerEnv, "MAX_WORKSPACES_PER_USER">): number {
  const v: unknown = env.MAX_WORKSPACES_PER_USER;
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return DEFAULT_MAX_WORKSPACES_PER_USER;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_WORKSPACES_PER_USER;
}

/** Bindings of the operator (admin) worker. It has no path to tenant data or tenant keys. */
export interface PlatformWorkerEnv extends CoreEnv {
  BOOTSTRAP_OPERATOR_EMAIL?: string;
  /** Public URL scheme+port hint for links to tenant apps, e.g. `http://{host}:5174` in dev. */
  APP_URL_TEMPLATE?: string;
}

/** Development behaviour (on-screen sign-in codes, optional rate limiter, HTTP sessions) only for the exact value. */
export const isDev = (env: Pick<CoreEnv, "ENVIRONMENT">): boolean => env.ENVIRONMENT === "development";

/**
 * Fail closed: the only accepted values are exactly "development" and "production".
 * Call at every worker entry point (fetch, queue, scheduled). The message never echoes the value.
 */
export function assertEnvironment(env: Pick<CoreEnv, "ENVIRONMENT">): void {
  const v: unknown = env?.ENVIRONMENT;
  if (v !== "development" && v !== "production") throw new EnvironmentMisconfigured();
}

class EnvironmentMisconfigured extends Error {
  constructor() {
    super("Server misconfigured: ENVIRONMENT must be exactly 'development' or 'production'.");
  }
}

/** Wraps a worker's fetch so a bad ENVIRONMENT returns a generic 500 and does nothing else. */
export const guardFetch = <E extends Pick<CoreEnv, "ENVIRONMENT">, A extends unknown[], R>(
  fn: (request: Request, env: E, ...rest: A) => R | Promise<R>,
) => async (request: Request, env: E, ...rest: A): Promise<R | Response> => {
  try { assertEnvironment(env); } catch { return new Response("Server misconfigured", { status: 500, headers: { "Cache-Control": "no-store" } }); }
  return fn(request, env, ...rest);
};
