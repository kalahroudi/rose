// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardToUpstream } from "../src/gateway";
import { bindTenant } from "../src/tenancy/context";

const ORIGIN = "https://upstream.example";
const env = { UPSTREAM_MODE: "origin", UPSTREAM_ORIGIN: ORIGIN, UPSTREAM_SIGNING_SECRET: "x".repeat(32) } as never;
const tenant = bindTenant({ id: "tn_a", slug: "a", name: "A" });
const actor = { type: "user", id: "u1", label: "u", role: "owner", sessionId: "s", name: "U" } as never;

afterEach(() => vi.restoreAllMocks());

function captureFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
}

// Paths as the client sends them on the wire (already percent-encoded where a browser would).
const HOSTILE = [
  "/svc//attacker.example/x",
  "/svc///attacker.example",
  "/svc////attacker.example/x",
  "/svc/%5Cattacker.example/x",
  "/svc/%5C%5Cattacker.example/x",
  "/svc/..//attacker.example/x",
  "/svc/../..//attacker.example/x",
  "/svc//attacker.example@upstream.example/",
  "/svc//attacker.example:443/x",
  "/svc/@attacker.example/x",
  "/svc/%2F%2Fattacker.example/x",
  "/svc/%09/attacker.example",
];

describe("gateway origin pinning", () => {
  for (const path of HOSTILE) {
    it(`never leaves the configured origin for ${path}`, async () => {
      const spy = captureFetch();
      await forwardToUpstream(env, new Request(`https://a.example.com${path}?q=1`), tenant, actor).catch(() => undefined);
      for (const call of spy.mock.calls) {
        const u = new URL(String((call[0] as URL | string | Request) instanceof Request ? (call[0] as Request).url : call[0]));
        expect(u.origin).toBe(ORIGIN);
        expect(u.username).toBe("");
        expect(u.password).toBe("");
      }
    });
  }

  it("keeps a leading-slash run on the upstream path instead of treating it as a host", async () => {
    const spy = captureFetch();
    await forwardToUpstream(env, new Request("https://a.example.com/svc//attacker.example/x?q=1"), tenant, actor);
    expect(spy).toHaveBeenCalledTimes(1);
    const target = new URL(String(spy.mock.calls[0]![0]));
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/attacker.example/x");
    expect(target.search).toBe("?q=1");
  });

  it("sends the tenant token only to the configured origin", async () => {
    const spy = captureFetch();
    await forwardToUpstream(env, new Request("https://a.example.com/svc//attacker.example/x"), tenant, actor);
    const [target, init] = spy.mock.calls[0]!;
    expect(new URL(String(target)).host).toBe("upstream.example");
    expect(new Headers((init as RequestInit).headers).get("x-rose-tenant-token")).toBeTruthy();
  });

  it("does not follow redirects to another host", async () => {
    const spy = captureFetch();
    await forwardToUpstream(env, new Request("https://a.example.com/svc/x"), tenant, actor);
    expect((spy.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });

  it("still forwards ordinary paths with the query string", async () => {
    const spy = captureFetch();
    await forwardToUpstream(env, new Request("https://a.example.com/svc/api/items?q=1"), tenant, actor);
    expect(String(spy.mock.calls[0]![0])).toBe("https://upstream.example/api/items?q=1");
  });

  it("maps /svc to the upstream root", async () => {
    const spy = captureFetch();
    await forwardToUpstream(env, new Request("https://a.example.com/svc"), tenant, actor);
    expect(String(spy.mock.calls[0]![0])).toBe("https://upstream.example/");
  });

  it("ignores any path component in UPSTREAM_ORIGIN and stays on the origin", async () => {
    const spy = captureFetch();
    const withPath = { ...(env as object), UPSTREAM_ORIGIN: "https://upstream.example/base/" } as never;
    await forwardToUpstream(withPath, new Request("https://a.example.com/svc/a"), tenant, actor);
    expect(new URL(String(spy.mock.calls[0]![0])).origin).toBe(ORIGIN);
  });

  it("respects a non-default port on the configured origin", async () => {
    const spy = captureFetch();
    const withPort = { ...(env as object), UPSTREAM_ORIGIN: "http://127.0.0.1:8788" } as never;
    await forwardToUpstream(withPort, new Request("https://a.example.com/svc//evil.example/x"), tenant, actor);
    expect(new URL(String(spy.mock.calls[0]![0])).origin).toBe("http://127.0.0.1:8788");
  });

  it("does not forward cookies or Authorization", async () => {
    const spy = captureFetch();
    await forwardToUpstream(
      env,
      new Request("https://a.example.com/svc/x", { headers: { cookie: "s=1", authorization: "Bearer z", "x-rose-tenant-id": "tn_other" } }),
      tenant,
      actor,
    );
    const h = new Headers((spy.mock.calls[0]![1] as RequestInit).headers);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-rose-tenant-id")).toBe("tn_a");
  });

  it("fails closed when the upstream is off or unset", async () => {
    const spy = captureFetch();
    await expect(forwardToUpstream({ UPSTREAM_MODE: "off" } as never, new Request("https://a.example.com/svc/x"), tenant, actor)).rejects.toBeTruthy();
    await expect(
      forwardToUpstream({ UPSTREAM_MODE: "origin", UPSTREAM_SIGNING_SECRET: "x".repeat(32) } as never, new Request("https://a.example.com/svc/x"), tenant, actor),
    ).rejects.toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
