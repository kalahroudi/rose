// SPDX-License-Identifier: Apache-2.0
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateDek, TenantCrypto, timingSafeEqual, unwrapDek, verifyJwtHs256, wrapDek } from "../src/crypto";
import { createTestTenant } from "../src/testing";

const K1 = env.ROSE_MASTER_KEY;
const K2 = "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=";

describe("field encryption", () => {
  it("round-trips and never repeats ciphertext", async () => {
    const c = await TenantCrypto.fromDek("tn_a", generateDek());
    const x = await c.encrypt("hello", "t.f");
    const y = await c.encrypt("hello", "t.f");
    expect(x).not.toBe(y);
    expect(x).not.toContain("hello");
    expect(await c.decrypt(x, "t.f")).toBe("hello");
  });

  it("binds ciphertext to the tenant and the field", async () => {
    const dek = generateDek();
    const a = await TenantCrypto.fromDek("tn_a", dek);
    const sealed = await a.encrypt("secret", "contacts.email");
    await expect(a.decrypt(sealed, "contacts.notes")).rejects.toThrow();
    // Same key material but a different tenant id must still fail.
    await expect((await TenantCrypto.fromDek("tn_b", dek)).decrypt(sealed, "contacts.email")).rejects.toThrow();
    await expect((await TenantCrypto.fromDek("tn_a", generateDek())).decrypt(sealed, "contacts.email")).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const c = await TenantCrypto.fromDek("tn_a", generateDek());
    const sealed = await c.encrypt("secret", "f");
    const at = sealed.length - 2;
    const flipped = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    await expect(c.decrypt(flipped, "f")).rejects.toThrow();
  });

  it("blind indexes are stable per tenant and differ across tenants", async () => {
    const a = await TenantCrypto.fromDek("tn_a", generateDek());
    const b = await TenantCrypto.fromDek("tn_b", generateDek());
    expect(await a.blindIndex(" Ada@Example.com ", "f")).toBe(await a.blindIndex("ada@example.com", "f"));
    expect(await a.blindIndex("ada@example.com", "f")).not.toBe(await b.blindIndex("ada@example.com", "f"));
  });
});

describe("envelope keys", () => {
  it("wraps a data key to one tenant", async () => {
    const dek = generateDek();
    const wrapped = await wrapDek(K1, "tn_a", dek);
    expect((await unwrapDek({ ROSE_MASTER_KEY: K1 }, "tn_a", wrapped)).dek).toEqual(dek);
    await expect(unwrapDek({ ROSE_MASTER_KEY: K1 }, "tn_b", wrapped)).rejects.toThrow();
    await expect(unwrapDek({ ROSE_MASTER_KEY: K2 }, "tn_a", wrapped)).rejects.toThrow();
  });

  it("supports master key rotation", async () => {
    const dek = generateDek();
    const wrapped = await wrapDek(K1, "tn_a", dek);
    const r = await unwrapDek({ ROSE_MASTER_KEY: K2, ROSE_MASTER_KEY_PREVIOUS: K1 }, "tn_a", wrapped);
    expect(r.rotated).toBe(true);
    expect(r.dek).toEqual(dek);
  });

  it("refuses malformed master keys", async () => {
    await expect(wrapDek("c2hvcnQ=", "tn_a", generateDek())).rejects.toThrow(/32 bytes/);
    await expect(wrapDek(undefined, "tn_a", generateDek())).rejects.toThrow(/not set/);
  });

  it("stores module secrets encrypted, readable only through the owning tenant", async () => {
    const a = await createTestTenant(env, SELF);
    const created = (await (await a.fetch("/api/m/notes", { body: { title: "t", secret: "p@ss" } })).json()) as { id: string };
    const read = (await (await a.fetch(`/api/m/notes/${created.id}`)).json()) as { secret: string; raw: string };
    expect(read.secret).toBe("p@ss");
    expect(read.raw).toMatch(/^v1\./);
    expect(read.raw).not.toContain("p@ss");
    // Another tenant's key can not open it even if the ciphertext leaked.
    const other = await TenantCrypto.fromDek("tn_other", generateDek());
    await expect(other.decrypt(read.raw, "notes.secret")).rejects.toThrow();
  });
});

describe("primitives", () => {
  it("timingSafeEqual", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("upstream gateway", () => {
  it("forwards a signed tenant token and strips credentials both ways", async () => {
    const a = await createTestTenant(env, SELF);
    let seen: Request | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init);
      return new Response("upstream-ok", { headers: { "Set-Cookie": "evil=1", "X-Kept": "yes" } });
    }) as typeof fetch;
    try {
      const res = await a.fetch("/svc/orders?x=1", { headers: { "X-Rose-Tenant-Id": "tn_forged" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("upstream-ok");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Kept")).toBe("yes");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen!.url).toBe("https://upstream.test/orders?x=1");
    expect(seen!.headers.get("Cookie")).toBeNull();
    expect(seen!.headers.get("Authorization")).toBeNull();
    expect(seen!.headers.get("X-Rose-Tenant-Id")).toBe(a.id);
    const claims = await verifyJwtHs256(env.UPSTREAM_SIGNING_SECRET!, seen!.headers.get("X-Rose-Tenant-Token")!);
    expect(claims).toMatchObject({ tid: a.id, tslug: a.slug, sub: a.userId, role: "owner", aud: "upstream" });
    expect(await verifyJwtHs256("wrong-secret-wrong-secret-wrong-secret", seen!.headers.get("X-Rose-Tenant-Token")!)).toBeNull();
  });

  it("requires authentication", async () => {
    const a = await createTestTenant(env, SELF);
    expect((await a.fetch("/svc/orders", { cookie: null })).status).toBe(401);
  });
});
