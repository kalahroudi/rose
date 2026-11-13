// SPDX-License-Identifier: Apache-2.0
import { signJwtHs256 } from "./crypto";
import type { TenantWorkerEnv } from "./env";
import { misconfigured, notFound } from "./errors";
import type { Actor } from "./modules";
import type { TenantContext } from "./tenancy/context";

// Only these request headers are forwarded. Cookies and Authorization never reach the
// upstream, and the client can not smuggle its own X-Rose-* identity headers.
const FORWARD_REQUEST = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "idempotency-key"];
// The upstream can not set cookies or loosen security headers on the tenant's origin.
const STRIP_RESPONSE = ["set-cookie", "content-security-policy", "strict-transport-security", "access-control-allow-origin", "access-control-allow-credentials"];

/**
 * Forward `/svc/*` to the service being multi-tenanted, with a short-lived signed token
 * that tells it which tenant and user the request is for.
 *
 *  - origin mode:   an existing HTTP service (yours, anywhere). It verifies the token.
 *  - dispatch mode: a per-tenant Worker in a Workers for Platforms dispatch namespace.
 */
/**
 * Put `path` and `search` on `base` without letting the path choose the host. Resolving them
 * with `new URL(path, base)` is unsafe: `//attacker.example/x` is a scheme-relative reference
 * and would replace the origin. Assigning `pathname` can only ever change the path.
 */
function onOrigin(base: string, path: string, search: string): URL {
  const target = new URL(base);
  target.pathname = path;
  target.search = search;
  return target;
}

export async function forwardToUpstream(env: TenantWorkerEnv, request: Request, tenant: TenantContext, actor: Actor): Promise<Response> {
  const mode = env.UPSTREAM_MODE ?? "off";
  if (mode === "off") throw notFound("No upstream service is configured.");
  if (!env.UPSTREAM_SIGNING_SECRET || env.UPSTREAM_SIGNING_SECRET.length < 32) throw misconfigured("UPSTREAM_SIGNING_SECRET must be set (32+ characters).");

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/svc/, "") || "/";
  const iat = Math.floor(Date.now() / 1000);
  const token = await signJwtHs256(env.UPSTREAM_SIGNING_SECRET, {
    iss: "rose", aud: "upstream", iat, exp: iat + 60,
    tid: tenant.id, tslug: tenant.slug, sub: actor.id, sub_type: actor.type, role: actor.role,
  });

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set("X-Rose-Tenant-Token", token);
  headers.set("X-Rose-Tenant-Id", tenant.id);
  const init: RequestInit = { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, redirect: "manual" };

  let res: Response;
  if (mode === "dispatch") {
    if (!env.DISPATCHER) throw misconfigured("Dispatch namespace binding DISPATCHER is missing.");
    res = await env.DISPATCHER.get(`tenant-${tenant.slug}`).fetch(new Request(onOrigin("https://upstream", path, url.search), init));
  } else {
    if (!env.UPSTREAM_ORIGIN) throw misconfigured("UPSTREAM_ORIGIN is not set.");
    // Never resolve the client's path against the origin: `//host/x` or `\host` would
    // replace the host and send the tenant token to it. Set it as a pathname instead and
    // refuse anything that does not stay on the configured origin.
    const upstream = new URL(env.UPSTREAM_ORIGIN);
    const target = new URL(upstream.origin);
    target.pathname = path.replace(/^[/\\]+/, "/");
    target.search = url.search;
    if (target.origin !== upstream.origin) throw notFound();
    res = await fetch(target, init);
  }
  const out = new Response(res.body, res);
  for (const name of STRIP_RESPONSE) out.headers.delete(name);
  out.headers.set("Cache-Control", "no-store");
  return out;
}
