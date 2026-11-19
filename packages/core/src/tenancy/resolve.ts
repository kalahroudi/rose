// SPDX-License-Identifier: Apache-2.0
import type { TenantRow } from "../control/tenants";

export type HostResolution =
  | { kind: "root" }
  | { kind: "tenant"; tenant: TenantRow }
  | { kind: "unknown" };

export const HOST_CACHE_TTL_MS = 5_000;
const MAX = 2000;
const cache = new Map<string, { value: HostResolution; expires: number }>();

export function invalidateHostCache(host?: string): void {
  if (host) cache.delete(host);
  else cache.clear();
}

export function hostnameOf(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

export async function resolveHost(db: D1Database, hostname: string, baseDomain: string): Promise<HostResolution> {
  const base = baseDomain.toLowerCase();
  if (hostname === base) return { kind: "root" };
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.value;

  let tenant: TenantRow | null = null;
  if (hostname.endsWith(`.${base}`)) {
    const slug = hostname.slice(0, -(base.length + 1));
    if (!slug.includes(".")) tenant = await db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();
  } else {
    tenant = await db
      .prepare("SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.hostname = ? AND d.status = 'active'")
      .bind(hostname)
      .first<TenantRow>();
  }
  const value: HostResolution = tenant ? { kind: "tenant", tenant } : { kind: "unknown" };
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(hostname, { value, expires: Date.now() + HOST_CACHE_TTL_MS });
  return value;
}
