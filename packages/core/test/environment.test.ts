// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertEnvironment, isDev } from "../src/env";
import { createTenantApp, createTenantWorker } from "../src";
import { notes } from "./worker";

const bad = [undefined, "", "test", "staging", "Production", "DEVELOPMENT", " development", "development ", "prod"];
const withEnv = (v: unknown) => ({ ...env, ENVIRONMENT: v }) as never;

describe("ENVIRONMENT fails closed", () => {
  it("isDev is true only for the exact value 'development'", () => {
    expect(isDev({ ENVIRONMENT: "development" })).toBe(true);
    expect(isDev({ ENVIRONMENT: "production" })).toBe(false);
    for (const v of bad) expect(isDev({ ENVIRONMENT: v as never })).toBe(false);
  });

  it("assertEnvironment accepts only development and production", () => {
    expect(() => assertEnvironment({ ENVIRONMENT: "development" })).not.toThrow();
    expect(() => assertEnvironment({ ENVIRONMENT: "production" })).not.toThrow();
    for (const v of bad) expect(() => assertEnvironment({ ENVIRONMENT: v as never })).toThrow(/misconfigured/);
  });

  it("every entry point of the tenant worker refuses to run, without leaking the value", async () => {
    const worker = createTenantWorker({ modules: [notes] });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    for (const v of bad) {
      const e = withEnv(v);
      const res = await worker.fetch(new Request("https://x.rose.test/api/bootstrap"), e, ctx);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toMatch(/staging|Production|test"/);
      await expect(worker.queue({ messages: [] }, e)).rejects.toThrow(/misconfigured/);
      await expect(worker.scheduled({}, e, ctx)).rejects.toThrow(/misconfigured/);
    }
  });

  it("the app itself (not only the default export) refuses to serve", async () => {
    const app = createTenantApp({ modules: [notes] });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    for (const v of bad) {
      const res = await app.fetch(new Request("https://x.rose.test/api/bootstrap"), withEnv(v), ctx);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Server misconfigured");
    }
  });

  it("an unknown value never returns a sign-in code", async () => {
    const worker = createTenantWorker({ modules: [notes] });
    const res = await worker.fetch(
      new Request("https://x.rose.test/api/auth/code/request", { method: "POST", headers: { Origin: "https://x.rose.test", "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) }),
      withEnv("staging"), { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/devCode/);
  });
});
