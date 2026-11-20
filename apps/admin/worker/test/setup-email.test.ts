// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import type { PlatformWorkerEnv } from "@rose/core";
import { describe, expect, it } from "vitest";
import { setupStatus } from "../setup";

const sender = { send: async () => ({ messageId: "m1" }) };
// Overrides may unset a binding, so `undefined` is allowed explicitly.
const emailCheck = async (extra: { [K in keyof PlatformWorkerEnv]?: PlatformWorkerEnv[K] | undefined }) =>
  (await setupStatus({ ...env, ...extra } as PlatformWorkerEnv)).checks.find((c) => c.id === "email")!;
const prod = { ENVIRONMENT: "production", EMAIL_FROM: "Acme <login@acme.app>" } as const;

describe("Setup page: email delivery check", () => {
  it("cloudflare with the binding is ok and names the provider", async () => {
    const c = await emailCheck({ ...prod, EMAIL_PROVIDER: "cloudflare", EMAIL: sender });
    expect(c.status).toBe("ok");
    expect(c.detail).toBe("Sending with Cloudflare Email as Acme <login@acme.app>.");
  });

  it("cloudflare without the binding is an error that says what is missing", async () => {
    const c = await emailCheck({ ...prod, EMAIL_PROVIDER: "cloudflare", EMAIL: undefined });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Cloudflare Email is selected but not ready");
    expect(c.detail).toContain("send_email binding");
  });

  it("resend with a key is ok, without a key is an error", async () => {
    const ok = await emailCheck({ ...prod, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" });
    expect(ok.status).toBe("ok");
    expect(ok.detail).toBe("Sending with Resend as Acme <login@acme.app>.");
    expect(ok.detail).not.toContain("re_test_key");
    const missing = await emailCheck({ ...prod, EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined });
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("RESEND_API_KEY");
  });

  it("console is an error in production and a warning in development", async () => {
    expect((await emailCheck({ ...prod, EMAIL_PROVIDER: "console" })).status).toBe("fail");
    const dev = await emailCheck({ ENVIRONMENT: "development", EMAIL_PROVIDER: "console" });
    expect(dev.status).toBe("warn");
    expect(dev.detail).toContain("Development mode");
  });
});
