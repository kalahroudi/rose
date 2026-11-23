// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createTenantWorker } from "../src";
import { createSession } from "../src/control/sessions";
import { addMembership, ensureUser } from "../src/control/users";
import { fromB64Url, toB64Url, utf8 } from "../src/encoding";
import { createTestTenant, type TestTenant } from "../src/testing";
import { notes } from "./worker";

const P256_GX = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY";
const P256_GY = "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const byText =(a: string, b: string) => a.localeCompare(b);

type Cbor =number | string | Uint8Array | Map<Cbor, Cbor>;

const cbor = (v: Cbor): Uint8Array => {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 0xff];
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") return new Uint8Array([...head(3, utf8(v).length), ...utf8(v)]);
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  return new Uint8Array([...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])]);
};

const noneAttestation = async (rpId: string, origin: string, challenge: string) => {
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64Url(P256_GX)], [-3, fromB64Url(P256_GY)]]));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(rpId)));
  const authData = new Uint8Array([...rpIdHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, credentialId.length, ...credentialId, ...cose]);
  const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  const id = toB64Url(credentialId);
  return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: toB64Url(clientDataJSON), attestationObject: toB64Url(attestationObject), transports: ["internal"] } };
};

const addPasskey = (t: TestTenant, credentialId: string, rpId: string) =>
  env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, created_at) VALUES (?, ?, ?, ?, 'k', ?)").bind(credentialId, t.userId, t.id, rpId, Date.now()).run();

const addDomain = (t: TestTenant, hostname: string, status: string) =>
  env.DB.prepare("INSERT INTO tenant_domains (hostname, tenant_id, status, created_at, updated_at) VALUES (?, ?, ?, 0, 0)").bind(hostname, t.id, status).run();

const freshCodeCookie = async (t: TestTenant) => `__Host-rose_session=${(await createSession(env.DB, { userId: t.userId, scope: t.id, method: "code" })).token}`;

describe("passkeys on a host the workspace no longer serves", () => {
  it("do not count: a fresh code session can enrol, remove, invite an owner and delete the workspace", async () => {
    const t = await createTestTenant(env, SELF);
    await addDomain(t, "pending.custom.example", "pending");
    await addPasskey(t, "cred-gone", "gone.custom.example");
    await addPasskey(t, "cred-pending", "pending.custom.example");
    const cookie = await freshCodeCookie(t);

    const list = await (await t.fetch("/api/auth/passkeys", { cookie })).json<{ items: { id: string; host: string; usable: boolean }[] }>();
    expect(list.items.map(({ id, host, usable }) => ({ id, host, usable }))).toEqual([
      { id: "cred-gone", host: "gone.custom.example", usable: false },
      { id: "cred-pending", host: "pending.custom.example", usable: false },
    ]);
    const boot = await (await t.fetch("/api/bootstrap", { cookie })).json<{ session: { hasPasskey: boolean } }>();
    expect(boot.session.hasPasskey).toBe(false);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(200);
    expect((await t.fetch("/api/invitations", { cookie, body: { email: "co-owner@x.example", role: "owner" } })).status).toBe(201);
    expect((await t.fetch("/api/auth/passkeys/cred-gone", { cookie, method: "DELETE" })).status).toBe(200);
    expect((await t.fetch("/api/workspace/delete", { cookie, body: { confirm: t.slug } })).status).toBe(202);
  });

  it("still count while their host is an active domain of the workspace", async () => {
    const t = await createTestTenant(env, SELF);
    await addDomain(t, "live.custom.example", "active");
    await addPasskey(t, "cred-live", "live.custom.example");
    const cookie = await freshCodeCookie(t);

    const list = await (await t.fetch("/api/auth/passkeys", { cookie })).json<{ items: { id: string; host: string; usable: boolean }[] }>();
    expect(list.items.map(({ id, host, usable }) => ({ id, host, usable }))).toEqual([{ id: "cred-live", host: "live.custom.example", usable: true }]);
    const boot = await (await t.fetch("/api/bootstrap", { cookie })).json<{ session: { hasPasskey: boolean } }>();
    expect(boot.session.hasPasskey).toBe(true);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(403);
    expect((await t.fetch("/api/invitations", { cookie, body: { email: "co-owner@x.example", role: "owner" } })).status).toBe(403);
    expect((await t.fetch("/api/auth/passkeys/cred-live", { cookie, method: "DELETE" })).status).toBe(403);
    expect((await t.fetch("/api/workspace/delete", { cookie, body: { confirm: t.slug } })).status).toBe(403);
  });

  it("enrolling one after the move emails the person and the workspace admins", async () => {
    const t = await createTestTenant(env, SELF);
    const admin = await ensureUser(env.DB, `admin@${t.slug}.example`);
    const member = await ensureUser(env.DB, `member@${t.slug}.example`);
    await addMembership(env.DB, t.id, admin.id, "admin");
    await addMembership(env.DB, t.id, member.id, "member");
    await addPasskey(t, "cred-gone", "gone.custom.example");
    const cookie = await freshCodeCookie(t);
    const worker = createTenantWorker({ modules: [notes] });
    const call = async (path: string, body: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(t.origin + path, { method: "POST", headers: { Origin: t.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const begin = await (await call("/api/auth/passkey/register/options", {})).json<{ id: string; options: { challenge: string } }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call("/api/auth/passkey/register/verify", { id: begin.id, name: "Laptop", response: await noneAttestation(t.host, t.origin, begin.options.challenge) });
    const sent = log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("New passkey for"));
    log.mockRestore();

    expect(res.status).toBe(200);
    expect(sent.map((line) => /To: (\S+)/.exec(line)?.[1] ?? "").sort(byText)).toEqual([`admin@${t.slug}.example`, t.email].sort(byText));
    const list = await (await t.fetch("/api/auth/passkeys", { cookie })).json<{ items: { name: string; host: string; usable: boolean }[] }>();
    expect(list.items.map(({ name, host, usable }) => ({ name, host, usable }))).toEqual([
      { name: "Passkey", host: "gone.custom.example", usable: false },
      { name: "Laptop", host: t.host, usable: true },
    ]);
  });

  it("an active domain of another workspace does not make a passkey usable here", async () => {
    const t = await createTestTenant(env, SELF);
    const other = await createTestTenant(env, SELF);
    await addDomain(other, "theirs.custom.example", "active");
    await addPasskey(t, "cred-theirs", "theirs.custom.example");
    const cookie = await freshCodeCookie(t);

    expect((await t.fetch("/api/auth/passkey/register/options", { cookie, body: {} })).status).toBe(200);
  });
});
