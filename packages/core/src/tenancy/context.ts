// SPDX-License-Identifier: Apache-2.0
import { TenantCrypto } from "../crypto";
import type { TenantWorkerEnv } from "../env";
import type { SqlResult, SqlStatement, SqlValue } from "./tenant-do";

declare const tenantBrand: unique symbol;

/**
 * Proof that a request has been bound to exactly one tenant. Values of this type are
 * only minted by `bindTenant`, which the platform calls after resolving the tenant
 * from the request host. Application code can not construct one.
 */
export interface TenantContext {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly [tenantBrand]: true;
}

export function bindTenant(row: { id: string; slug: string; name: string }): TenantContext {
  return Object.freeze({ id: row.id, slug: row.slug, name: row.name }) as TenantContext;
}

/**
 * SQL access to one tenant's private database. Parameters are always bound; the query
 * text must be a constant in your code.
 */
export class TenantDb {
  private readonly stub;
  constructor(env: Pick<TenantWorkerEnv, "TENANT_DO">, private readonly tenant: TenantContext) {
    this.stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(tenant.id));
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return ((await this.stub.exec(this.tenant.id, { sql, params })) as SqlResult).rows as T[];
  }

  async first<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  /** Returns the number of rows inserted, updated or deleted. */
  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    return ((await this.stub.exec(this.tenant.id, { sql, params })) as SqlResult).changes;
  }

  /** All statements commit together or not at all. */
  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    return (await this.stub.batch(this.tenant.id, statements)) as SqlResult[];
  }
}

// Unwrapped keys are cached per isolate for a short time to avoid a round trip per request.
const KEY_TTL = 5 * 60_000;
const MAX_KEYS = 500;
const keyCache = new Map<string, { crypto: TenantCrypto; expires: number }>();

export async function tenantCrypto(env: Pick<TenantWorkerEnv, "TENANT_DO">, tenant: TenantContext): Promise<TenantCrypto> {
  const hit = keyCache.get(tenant.id);
  if (hit && hit.expires > Date.now()) return hit.crypto;
  const stub = env.TENANT_DO.get(env.TENANT_DO.idFromName(tenant.id));
  const dek = new Uint8Array((await stub.dataKey(tenant.id)) as ArrayBuffer);
  const crypto = await TenantCrypto.fromDek(tenant.id, dek);
  if (keyCache.size >= MAX_KEYS) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(tenant.id, { crypto, expires: Date.now() + KEY_TTL });
  return crypto;
}

/** Destroy a tenant's storage. Used only by the purge job. */
export async function purgeTenantStorage(env: Pick<TenantWorkerEnv, "TENANT_DO">, tenantId: string): Promise<void> {
  keyCache.delete(tenantId);
  await env.TENANT_DO.get(env.TENANT_DO.idFromName(tenantId)).purge(tenantId);
}
