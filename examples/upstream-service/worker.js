// SPDX-License-Identifier: Apache-2.0
//
// Example upstream: an existing service that Rose makes multi-tenant.
//
// Rose authenticates the user, works out the tenant from the request host, and forwards
// /svc/* here with a short-lived signed token. This service trusts ONLY that token:
// it never reads a tenant id from a path, query string, body or any other header.
//
// Dependency-free. Runs on Cloudflare Workers, and the verify function works unchanged
// in Node 20+, Deno and Bun (WebCrypto).

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/**
 * Verify the token Rose sends in `X-Rose-Tenant-Token`.
 * Returns the claims, or null if the token is missing, forged, expired or not meant for us.
 */
export async function verifyRoseToken(token, secret) {
  if (!token || !secret) return null;
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(head)));
    claims = JSON.parse(new TextDecoder().decode(b64url(body)));
  } catch {
    return null;
  }
  // Pin the algorithm: never let the token choose how it is verified.
  if (header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", key, b64url(sig), new TextEncoder().encode(`${head}.${body}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) return null; // tokens live 60 seconds
  if (claims.iss !== "rose" || claims.aud !== "upstream") return null;
  if (typeof claims.tid !== "string" || !claims.tid) return null;
  return claims; // { tid, tslug, sub, sub_type: "user" | "api_key", role: "owner" | "admin" | "member", iat, exp }
}

// Stand-in for your database. The point: every read and write is keyed by the VERIFIED tenant id.
const ordersByTenant = new Map();

export default {
  async fetch(request, env) {
    const claims = await verifyRoseToken(request.headers.get("X-Rose-Tenant-Token"), env.UPSTREAM_SIGNING_SECRET);
    if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const orders = ordersByTenant.get(claims.tid) ?? [];

    if (url.pathname === "/orders" && request.method === "GET") {
      return Response.json({ tenant: claims.tslug, orders: orders.slice(0, 50) });
    }
    if (url.pathname === "/orders" && request.method === "POST") {
      if (claims.role === "member") return Response.json({ error: "forbidden" }, { status: 403 });
      const body = await request.json().catch(() => null);
      if (!body || typeof body.item !== "string" || body.item.length > 200) return Response.json({ error: "invalid" }, { status: 422 });
      const order = { id: crypto.randomUUID(), item: body.item, createdBy: claims.sub };
      ordersByTenant.set(claims.tid, [order, ...orders]);
      return Response.json(order, { status: 201 });
    }
    if (url.pathname === "/whoami") {
      return Response.json({ tenantId: claims.tid, tenant: claims.tslug, subject: claims.sub, subjectType: claims.sub_type, role: claims.role });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
