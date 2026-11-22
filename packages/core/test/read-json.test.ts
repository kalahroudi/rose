// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler, MAX_BODY, readJson } from "../src/http/base";

const schema = z.object({ v: z.string() });

const app = new Hono();
app.onError(errorHandler);
app.post("/", async (c) => c.json(await readJson(c, schema)));
app.post("/twice", async (c) => {
  const first = await readJson(c, schema);
  const second = schema.parse(await c.req.json());
  return c.json({ same: first.v === second.v });
});

const jsonOfBytes = (bytes: number, filler = "a") => {
  const room = bytes - new TextEncoder().encode('{"v":""}').byteLength;
  const width = new TextEncoder().encode(filler).byteLength;
  return `{"v":"${filler.repeat(Math.floor(room / width))}${"a".repeat(room % width)}"}`;
};

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  app.request("/", <RequestInit & { duplex: "half" }>{
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  });

const chunkedSource = (chunk: Uint8Array, count: number) => {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        if (state.pulls > count) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, stream };
};

describe("readJson size cap", () => {
  it("cancels a chunked body without a Content-Length once it passes the cap", async () => {
    const { state, stream } = chunkedSource(new Uint8Array(MAX_BODY / 10).fill(97), 1000);
    const res = await post(stream);
    expect(res.status).toBe(413);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("too_large");
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThan(20);
  });

  it("accepts a body of exactly MAX_BODY bytes", async () => {
    const body = jsonOfBytes(MAX_BODY);
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY);
    const res = await post(body);
    expect(res.status).toBe(200);
  });

  it("rejects a body of MAX_BODY + 1 bytes", async () => {
    const body = jsonOfBytes(MAX_BODY) + " ";
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY + 1);
    const res = await post(body);
    expect(res.status).toBe(413);
  });

  it("counts multi-byte UTF-8 in bytes", async () => {
    const fits = jsonOfBytes(MAX_BODY - 1, "€");
    expect(fits.length).toBeLessThan(MAX_BODY);
    expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_BODY - 1);
    expect((await post(fits)).status).toBe(200);

    const over = jsonOfBytes(MAX_BODY + 2, "€");
    expect(over.length).toBeLessThan(MAX_BODY);
    expect(new TextEncoder().encode(over).byteLength).toBe(MAX_BODY + 2);
    expect((await post(over)).status).toBe(413);
  });

  it("refuses an oversized declared Content-Length without reading the body", async () => {
    const { state, stream } = chunkedSource(new Uint8Array(10), 1000);
    const res = await post(stream, { "Content-Length": String(MAX_BODY + 1) });
    expect(res.status).toBe(413);
    expect(state.pulls).toBe(0);
  });

  it("lets the handler read the body again after readJson", async () => {
    const res = await app.request("/twice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"v":"x"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ same: true });
  });

  it("answers an empty body with 400", async () => {
    const res = await post("");
    expect(res.status).toBe(400);
  });
});
