// SPDX-License-Identifier: Apache-2.0
import { openPlatformSecret, sealPlatformSecret } from "../crypto";
import { now } from "../ids";

/** Operator-plane settings. Values flagged `secret` are encrypted before they touch the database. */
export async function putSetting(db: D1Database, masterKey: string, key: string, value: string, secret = false): Promise<void> {
  const stored = secret ? await sealPlatformSecret(masterKey, key, value) : value;
  await db
    .prepare(
      `INSERT INTO platform_settings (key, value, sealed, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, sealed = excluded.sealed, updated_at = excluded.updated_at`,
    )
    .bind(key, stored, secret ? 1 : 0, now())
    .run();
}

export async function getSetting(db: D1Database, masterKey: string, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value, sealed FROM platform_settings WHERE key = ?").bind(key).first<{ value: string; sealed: number }>();
  if (!row) return null;
  return row.sealed ? openPlatformSecret(masterKey, key, row.value) : row.value;
}

export const deleteSetting = (db: D1Database, key: string) => db.prepare("DELETE FROM platform_settings WHERE key = ?").bind(key).run();
