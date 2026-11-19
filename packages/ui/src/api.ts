// SPDX-License-Identifier: Apache-2.0
// The only way the UI talks to anything: same-origin JSON calls to its own worker.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  if (!path.startsWith("/")) throw new Error("api() only accepts same-origin paths");
  let res: Response;
  try {
    const init: RequestInit = { method: opts.method ?? (opts.body === undefined ? "GET" : "POST"), credentials: "same-origin" };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal !== undefined) init.signal = opts.signal;
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; fields?: Record<string, string>; requestId?: string } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status}).`, e?.fields ?? {}, e?.requestId ?? res.headers.get("X-Request-Id") ?? undefined);
  }
  return data as T;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : "Something went wrong.");
