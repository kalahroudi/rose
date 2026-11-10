// SPDX-License-Identifier: Apache-2.0
import { deriveHmacKey, hmacHex, timingSafeEqual } from "../crypto";
import { tooMany } from "../errors";
import { newId, now, randomDigits } from "../ids";

const CODE_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 5;
const WINDOW = 15 * 60_000;

const codeHash = async (masterKey: string, scope: string, email: string, code: string) =>
  hmacHex(await deriveHmacKey(masterKey, "login-code/v1"), `${scope}\u0000${email}\u0000${code}`);

/**
 * Issue a one-time sign-in code. Returns the code so the caller can deliver it.
 * The stored hash is keyed (HMAC) and bound to scope + email, so codes can not be
 * brute-forced offline from the database or replayed against another tenant.
 */
export async function issueLoginCode(db: D1Database, masterKey: string, scope: string, email: string): Promise<string> {
  const t = now();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND scope = ? AND created_at > ?")
    .bind(email, scope, t - WINDOW)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_WINDOW) throw tooMany("Too many codes requested. Wait a few minutes and try again.");
  const code = randomDigits(6);
  await db
    .prepare("INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("lc"), email, scope, await codeHash(masterKey, scope, email, code), t + CODE_TTL, t)
    .run();
  return code;
}

/**
 * Check a code. Only the most recent code is valid, each code allows five guesses, and a
 * correct code is consumed atomically so it can not be used twice.
 */
export async function verifyLoginCode(db: D1Database, masterKey: string, scope: string, email: string, code: string): Promise<boolean> {
  const t = now();
  const row = await db
    .prepare("SELECT id, code_hash FROM login_codes WHERE email = ? AND scope = ? ORDER BY created_at DESC LIMIT 1")
    .bind(email, scope)
    .first<{ id: string; code_hash: string }>();
  if (!row) return false;
  // Spend an attempt before comparing, so parallel guesses can not exceed the budget.
  const spent = await db
    .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(row.id, MAX_ATTEMPTS, t)
    .run();
  if (spent.meta.changes === 0) return false;
  if (!(await timingSafeEqual(row.code_hash, await codeHash(masterKey, scope, email, code)))) return false;
  const consumed = await db.prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(t, row.id).run();
  return consumed.meta.changes === 1;
}
