// SPDX-License-Identifier: Apache-2.0
import { deriveHmacKey, hmacHex } from "../crypto";
import { now } from "../ids";

export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export async function consumeRateLimit(
  db: D1Database,
  masterKey: string,
  key: string,
  opts?: { limit?: number; windowMs?: number },
): Promise<boolean> {
  const limit = opts?.limit ?? RATE_LIMIT_MAX;
  const windowMs = opts?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  if (limit <= 0) return false;
  const keyHash = await hmacHex(await deriveHmacKey(masterKey, "rate-limit/v1"), key);
  const t = now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT (key_hash) DO UPDATE SET
         count = CASE WHEN excluded.window_start - rate_limits.window_start >= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN excluded.window_start - rate_limits.window_start >= ? THEN excluded.window_start ELSE rate_limits.window_start END
       WHERE excluded.window_start - rate_limits.window_start >= ? OR rate_limits.count < ?
       RETURNING count`,
    )
    .bind(keyHash, t, windowMs, windowMs, windowMs, limit)
    .first<{ count: number }>();
  return row !== null;
}
