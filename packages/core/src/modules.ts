// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from "zod";
import type { Role } from "./control/users";
import type { TenantCrypto } from "./crypto";
import type { ListQuery } from "./http/pagination";
import type { TenantContext, TenantDb } from "./tenancy/context";
import type { TenantMigration } from "./tenancy/tenant-do";

/** Who is making the request. Always belongs to the current tenant. */
export type Actor =
  | { type: "user"; id: string; label: string; role: Role; sessionId: string; name: string }
  | { type: "api_key"; id: string; label: string; role: Role };

/**
 * Everything a module handler may touch. There is deliberately no `env`, no raw
 * database binding and no way to name another tenant: the context is already bound to
 * the tenant that owns this request.
 */
export interface ModuleContext {
  readonly tenant: TenantContext;
  readonly actor: Actor;
  /** This tenant's private database. */
  readonly db: TenantDb;
  /** Field encryption with this tenant's key. */
  crypto(): Promise<TenantCrypto>;
  /** Append to this tenant's audit log. Call it for every change. */
  audit(action: string, target?: string | null, meta?: unknown): Promise<void>;
  /** Queue background work for this tenant (see `jobs` on the module). Returns the job id. */
  enqueue(job: string, title: string, payload?: Record<string, unknown>): Promise<string>;
  readonly req: {
    param(name: string): string;
    query(name: string): string | undefined;
    /** Validated pagination/search/sort. Page size is capped by the platform. */
    list(): ListQuery;
    /** Validated JSON body. */
    body<T>(schema: ZodType<T>): Promise<T>;
  };
}

/** Context for background jobs: bound to the tenant that queued the job, with no request. */
export type ModuleJobContext = Pick<ModuleContext, "tenant" | "db" | "crypto" | "audit">;

export interface ModuleRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Relative to `/api/m/<module id>`. */
  path: string;
  /** Required. There is no such thing as a module route without an authorisation check. */
  permission: string;
  handler(ctx: ModuleContext): Promise<unknown>;
}

/**
 * How the shared isolation suite exercises this module. Declaring it is mandatory: it is
 * what proves, for every module in the repo, that tenant B can not see or touch what
 * tenant A created.
 */
export interface IsolationProbe {
  /** Create one record. `marker` is a unique string that must be stored in a visible field. */
  create(marker: string): { path: string; body: unknown };
  /** Path that lists records and would show the marker. */
  listPath: string;
  /** Path of a single record, given the JSON returned by create. */
  itemPath(created: Record<string, unknown>): string;
}

export interface ModuleDefinition {
  /** Lowercase id; becomes the URL prefix and the permission prefix. */
  id: string;
  /** Permission → roles that hold it. Every permission must start with `<id>:`. */
  permissions: Record<string, Role[]>;
  /** Tables in each tenant's private database. Append new entries; never edit shipped ones. */
  migrations: TenantMigration[];
  routes: ModuleRoute[];
  /** Long-running work, run off the request path with retries. Queue with `ctx.enqueue(name, …)`. */
  jobs?: Record<string, (ctx: ModuleJobContext, payload: Record<string, unknown>) => Promise<unknown>>;
  isolationProbe: IsolationProbe;
}

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(def.id)) throw new Error(`Invalid module id "${def.id}"`);
  for (const p of Object.keys(def.permissions)) {
    if (!p.startsWith(`${def.id}:`)) throw new Error(`Permission "${p}" must start with "${def.id}:"`);
  }
  for (const r of def.routes) {
    if (!(r.permission in def.permissions)) throw new Error(`Route ${r.method} ${r.path} uses undeclared permission "${r.permission}"`);
    if (!r.path.startsWith("/")) throw new Error(`Route path "${r.path}" must start with "/"`);
  }
  for (const m of def.migrations) {
    if (!m.id.startsWith(`${def.id}_`)) throw new Error(`Migration "${m.id}" must start with "${def.id}_"`);
  }
  return def;
}

/** Built-in permissions of the tenant app. */
export const CORE_PERMISSIONS: Record<string, Role[]> = {
  "members:read": ["owner", "admin", "member"],
  "members:manage": ["owner", "admin"],
  "apikeys:manage": ["owner", "admin"],
  "audit:read": ["owner", "admin"],
  "workspace:update": ["owner", "admin"],
  "workspace:delete": ["owner"],
  "service:use": ["owner", "admin", "member"],
};

export function buildPermissions(modules: ModuleDefinition[]): Record<string, Role[]> {
  const all: Record<string, Role[]> = { ...CORE_PERMISSIONS };
  const ids = new Set<string>();
  for (const m of modules) {
    if (ids.has(m.id)) throw new Error(`Duplicate module id "${m.id}"`);
    ids.add(m.id);
    Object.assign(all, m.permissions);
  }
  return all;
}

export const permissionsOf = (table: Record<string, Role[]>, role: Role): string[] =>
  Object.keys(table).filter((p) => table[p]!.includes(role));
