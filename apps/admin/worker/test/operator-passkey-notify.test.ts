// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { noneAttestation } from "../../../../packages/core/test/passkey-attestation";
import worker from "../index";

const ORIGIN = "https://admin.rose.test";
const EMAIL = "enrol@example.com";

describe("enrolling a console passkey", () => {
  it("emails the person and every other platform owner, and nobody else", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('us_enrol', 'enrol@example.com', 0), ('us_owner2', 'owner2@example.com', 0), ('us_staff', 'staff@example.com', 0)").run();
    await env.DB.prepare("INSERT INTO operators (user_id, role, created_at) VALUES ('us_enrol', 'owner', 0), ('us_owner2', 'owner', 0), ('us_staff', 'operator', 0)").run();

    const signIn = (path: string, json: unknown) =>
      SELF.fetch(ORIGIN + path, { method: "POST", redirect: "manual", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(json) });
    const { devCode } = await (await signIn("/api/auth/code/request", { email: EMAIL })).json<{ devCode?: string }>();
    const session = await signIn("/api/auth/code/verify", { email: EMAIL, code: devCode });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("Set-Cookie")!.split(";")[0]!;

    const call = async (path: string, json: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(ORIGIN + path, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(json) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const begin = await (await call("/api/auth/passkey/register/options", {})).json<{ id: string; options: { challenge: string } }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call("/api/auth/passkey/register/verify", { id: begin.id, name: "Laptop", response: await noneAttestation("admin.rose.test", ORIGIN, begin.options.challenge) });
    const sent = log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("New passkey for"));
    log.mockRestore();

    expect(res.status).toBe(200);
    expect(sent.map((line) => /To: (\S+)/.exec(line)?.[1] ?? "").sort()).toEqual([EMAIL, "owner2@example.com"]);
  });
});
