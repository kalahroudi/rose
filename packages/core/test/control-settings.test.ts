// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deleteSetting, getSetting, putSetting } from "../src/control/settings";

const k = env.ROSE_MASTER_KEY;
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const stored = (name: string) => env.DB.prepare("SELECT value, sealed FROM platform_settings WHERE key = ?").bind(name).first<{ value: string; sealed: number }>();

describe("platform settings", () => {
  it("stores a plain value unsealed and reads it back", async () => {
    const name = key();
    await putSetting(env.DB, k, name, "plain-value");
    expect(await getSetting(env.DB, k, name)).toBe("plain-value");
    expect((await stored(name))!.sealed).toBe(0);
    expect((await stored(name))!.value).toBe("plain-value");
  });

  it("encrypts a secret value at rest and decrypts it on read", async () => {
    const name = key();
    await putSetting(env.DB, k, name, "hunter2", true);
    expect(await getSetting(env.DB, k, name)).toBe("hunter2");
    const r = (await stored(name))!;
    expect(r.sealed).toBe(1);
    expect(r.value).not.toContain("hunter2");
  });

  it("upserts by key, flipping between plain and secret", async () => {
    const name = key();
    await putSetting(env.DB, k, name, "first");
    await putSetting(env.DB, k, name, "second");
    expect(await getSetting(env.DB, k, name)).toBe("second");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_settings WHERE key = ?").bind(name).first<{ n: number }>()).toMatchObject({ n: 1 });

    await putSetting(env.DB, k, name, "now-secret", true);
    expect((await stored(name))!.sealed).toBe(1);
    expect(await getSetting(env.DB, k, name)).toBe("now-secret");

    await putSetting(env.DB, k, name, "plain-again", false);
    expect((await stored(name))!.sealed).toBe(0);
    expect(await getSetting(env.DB, k, name)).toBe("plain-again");
  });

  it("returns null for a missing key and deletes cleanly", async () => {
    const name = key();
    expect(await getSetting(env.DB, k, name)).toBeNull();
    await putSetting(env.DB, k, name, "gone");
    await deleteSetting(env.DB, name);
    expect(await getSetting(env.DB, k, name)).toBeNull();
  });
});
