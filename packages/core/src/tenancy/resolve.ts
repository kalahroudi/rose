// SPDX-License-Identifier: Apache-2.0
import type { TenantRow } from "../control/tenants";

export type HostResolution =
  | { kind: "root" }
  | { kind: "tenant"; tenant: TenantRow }
  | { kind: "unknown" };

// Host → tenant id rarely changes; cache it per isolate. Status is NOT trusted from this
// cache for authenticated requests: the session query re-checks it against the database.
const TTL = 30_000;
const MAX = 2000;
const cache = new Map<string, { value: HostResolution; expires: number }>();

export function invalidateHostCache(host?: string): void {
  if (host) cache.delete(host);
  else cache.clear();
}

/** Lower-case the host and drop the port. */
export function hostnameOf(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

/**
 * Map a request host to a tenant. This is the single place tenant identity is decided,
 * and it uses only the host the platform routed — never a header, query string, body
 * or token supplied by the client.
 */
export async function resolveHost(db: D1Database, hostname: string, baseDomain: string): Promise<HostResolution> {
  const base = baseDomain.toLowerCase();
  if (hostname === base) return { kind: "root" };
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.value;

  let tenant: TenantRow | null = null;
  if (hostname.endsWith(`.${base}`)) {
    const slug = hostname.slice(0, -(base.length + 1));
    // Exactly one label: "a.b.<base>" is never a tenant.
    if (!slug.includes(".")) tenant = await db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();
  } else {
    tenant = await db
      .prepare("SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.hostname = ? AND d.status = 'active'")
      .bind(hostname)
      .first<TenantRow>();
  }
  const value: HostResolution = tenant ? { kind: "tenant", tenant } : { kind: "unknown" };
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(hostname, { value, expires: Date.now() + TTL });
  return value;
}
