// SPDX-License-Identifier: Apache-2.0
import type { TenantDurableObject } from "./tenancy/tenant-do";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Bindings shared by every Rose worker. */
export interface CoreEnv {
  /** Control-plane database: tenants, identities, sessions. Never holds tenant business data. */
  DB: D1Database;
  ENVIRONMENT: "development" | "test" | "production";
  /** base64 of 32 random bytes. Root of all key derivation for this worker. */
  ROSE_MASTER_KEY: string;
  /** Set during rotation so data wrapped under the old key can still be opened. */
  ROSE_MASTER_KEY_PREVIOUS?: string;
  APP_NAME: string;
  /** Domain tenants live under: `<slug>.<APP_BASE_DOMAIN>`. */
  APP_BASE_DOMAIN: string;
  EMAIL_PROVIDER?: "console" | "resend";
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RL_AUTH?: RateLimiter;
}

/** Bindings of the tenant-facing app worker. */
export interface TenantWorkerEnv extends CoreEnv {
  TENANT_DO: DurableObjectNamespace<TenantDurableObject>;
  UPSTREAM_MODE?: "off" | "origin" | "dispatch";
  UPSTREAM_ORIGIN?: string;
  UPSTREAM_SIGNING_SECRET?: string;
  DISPATCHER?: { get(name: string): Fetcher };
}

/** Bindings of the operator (admin) worker. It has no path to tenant data or tenant keys. */
export interface PlatformWorkerEnv extends CoreEnv {
  BOOTSTRAP_OPERATOR_EMAIL?: string;
  /** Public URL scheme+port hint for links to tenant apps, e.g. `http://{host}:5174` in dev. */
  APP_URL_TEMPLATE?: string;
}

export const isDev = (env: Pick<CoreEnv, "ENVIRONMENT">): boolean => env.ENVIRONMENT !== "production";
