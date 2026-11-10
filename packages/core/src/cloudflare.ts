// SPDX-License-Identifier: Apache-2.0
// Minimal Cloudflare for SaaS client: custom hostnames let each tenant bring a domain,
// with certificates issued and renewed by Cloudflare.

export interface CloudflareConnection {
  zoneId: string;
  apiToken: string;
}

export interface CustomHostname {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  records: { type: string; name: string; value: string }[];
  errors: string[];
}

interface CfHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[]; validation_errors?: { message: string }[] };
  ownership_verification?: { type: string; name: string; value: string };
  verification_errors?: string[];
}

async function cf<T>(conn: CloudflareConnection, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(conn.zoneId)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${conn.apiToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !json?.success) throw new Error(`Cloudflare API: ${json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
  return json.result as T;
}

function shape(h: CfHostname): CustomHostname {
  const records: CustomHostname["records"] = [];
  if (h.ownership_verification) records.push({ type: h.ownership_verification.type.toUpperCase(), name: h.ownership_verification.name, value: h.ownership_verification.value });
  for (const r of h.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) records.push({ type: "TXT", name: r.txt_name, value: r.txt_value });
  return {
    id: h.id, hostname: h.hostname, status: h.status, sslStatus: h.ssl?.status ?? "unknown", records,
    errors: [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e.message)],
  };
}

export const verifyZone = (conn: CloudflareConnection) => cf<{ id: string; name: string; status: string }>(conn, "GET", "");

export async function createCustomHostname(conn: CloudflareConnection, hostname: string): Promise<CustomHostname> {
  return shape(await cf<CfHostname>(conn, "POST", "/custom_hostnames", { hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }));
}

export async function getCustomHostname(conn: CloudflareConnection, id: string): Promise<CustomHostname> {
  return shape(await cf<CfHostname>(conn, "GET", `/custom_hostnames/${encodeURIComponent(id)}`));
}

export async function deleteCustomHostname(conn: CloudflareConnection, id: string): Promise<void> {
  await cf(conn, "DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
}
