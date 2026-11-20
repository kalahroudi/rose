// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/email";
import type { CoreEnv } from "../src/env";

const mail = { to: "someone@acme.app", subject: "123456 is your code", text: "Your code is 123456" };
const reserved = ["a@pentest.example", "A@Foo.EXAMPLE.", "b@x.test", "c@nope.invalid", "d@localhost", "e@example.com", "f@update.example.org", "g@EXAMPLE.NET"];
const deliverable = ["a@acme.app", "b@example.co", "c@myexample.com", "d@example.com.au", "e@testing.dev", "f@example.comx"];

type Sender = NonNullable<CoreEnv["EMAIL"]>;
type Message = Parameters<Sender["send"]>[0];
function fakeSender(impl?: () => Promise<{ messageId: string }>) {
  const send = vi.fn<(m: Message) => Promise<{ messageId: string }>>(impl ?? (async () => ({ messageId: "m1" })));
  const sent = (): Message[] => send.mock.calls.map((c) => c[0]);
  return { send, sent };
}
const cf = (EMAIL: CoreEnv["EMAIL"], extra: Partial<CoreEnv> = {}) =>
  ({ ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: '"Acme Team" <login@acme.app>', EMAIL, ...extra }) as CoreEnv;

afterEach(() => vi.restoreAllMocks());

describe("sendEmail: cloudflare provider", () => {
  it("sends through the binding with a parsed sender", async () => {
    const sender = fakeSender();
    await sendEmail(cf(sender), mail);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.sent()[0]).toEqual({ from: { email: "login@acme.app", name: "Acme Team" }, ...mail });
  });

  it("passes a bare EMAIL_FROM through unchanged", async () => {
    const sender = fakeSender();
    await sendEmail(cf(sender, { EMAIL_FROM: "login@acme.app" }), mail);
    expect(sender.sent()[0]?.from).toBe("login@acme.app");
  });

  it("refuses to run without the binding or a sender address", async () => {
    await expect(sendEmail(cf(undefined), mail)).rejects.toMatchObject({ code: "misconfigured" });
    await expect(sendEmail(cf(fakeSender(), { EMAIL_FROM: "" }), mail)).rejects.toMatchObject({ code: "misconfigured" });
  });

  it("reports only the provider error code, never the recipient", async () => {
    const sender = fakeSender(async () => {
      throw Object.assign(new Error(`recipient ${mail.to} is not allowed`), { code: "E_RECIPIENT_NOT_ALLOWED" });
    });
    const err = await sendEmail(cf(sender), mail).then(
      () => new Error("did not throw"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("E_RECIPIENT_NOT_ALLOWED");
    expect(err.message).not.toContain(mail.to);
  });
});

describe("sendEmail: reserved recipient domains are never sent", () => {
  it("skips them on cloudflare without calling the binding or logging the address", async () => {
    const sender = fakeSender();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const to of reserved) await sendEmail(cf(sender), { ...mail, to });
    expect(sender.send).not.toHaveBeenCalled();
    const logged = log.mock.calls.flat().join("\n");
    for (const to of reserved) expect(logged.toLowerCase()).not.toContain(to.toLowerCase());
    expect(logged).not.toContain("123456");
  });

  it("skips them on resend without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const e = { ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "resend", EMAIL_FROM: "x@acme.app", RESEND_API_KEY: "re_test_key" } as CoreEnv;
    for (const to of reserved) await sendEmail(e, { ...mail, to });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still sends to look-alike real domains", async () => {
    const sender = fakeSender();
    for (const to of deliverable) await sendEmail(cf(sender), { ...mail, to });
    expect(sender.sent().map((m) => m.to)).toEqual(deliverable);
  });

  it("does not hide a missing provider configuration", async () => {
    await expect(sendEmail(cf(undefined), { ...mail, to: "a@pentest.example" })).rejects.toMatchObject({ code: "misconfigured" });
  });
});
