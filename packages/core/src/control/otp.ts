// SPDX-License-Identifier: Apache-2.0
import { deriveHmacKey, hmacHex, timingSafeEqual } from "../crypto";
import { tooMany } from "../errors";
import { newId, now, randomDigits } from "../ids";

const CODE_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
/** Per (scope, email, requester): the limit a real user can hit. */
const MAX_CODES_PER_REQUESTER = 5;
/** Per (scope, email) across all requesters: anti mail-bomb cap, well above what one requester can reach. */
const MAX_CODES_PER_EMAIL = 20;
const WINDOW = 15 * 60_000;

const codeHash = async (masterKey: string, scope: string, email: string, code: string) =>
  hmacHex(await deriveHmacKey(masterKey, "login-code/v1"), `${scope}\u0000${email}\u0000${code}`);

/** Requester identity is stored as a keyed hash so the control plane holds no raw client addresses. */
const requesterHash = async (masterKey: string, requester: string) =>
  hmacHex(await deriveHmacKey(masterKey, "login-code-requester/v1"), requester);

/**
 * Issue a one-time sign-in code. Returns the code so the caller can deliver it.
 * The stored hash is keyed (HMAC) and bound to scope + email, so codes can not be
 * brute-forced offline from the database or replayed against another tenant.
 */
export async function issueLoginCode(db: D1Database, masterKey: string, scope: string, email: string, requester: string): Promise<string> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  const code = randomDigits(6);
  // Check and insert in one statement so parallel requests can not all pass the cap check.
  const res = await db
    .prepare(
      `INSERT INTO login_codes (id, email, scope, code_hash, expires_at, created_at, requester)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM login_codes WHERE email = ? AND scope = ? AND created_at > ?) < ?
         AND (SELECT COUNT(*) FROM login_codes WHERE email = ? AND scope = ? AND requester = ? AND created_at > ?) < ?`,
    )
    .bind(
      newId("lc"), email, scope, await codeHash(masterKey, scope, email, code), t + CODE_TTL, t, who,
      email, scope, t - WINDOW, MAX_CODES_PER_EMAIL,
      email, scope, who, t - WINDOW, MAX_CODES_PER_REQUESTER,
    )
    .run();
  if (res.meta.changes === 0) throw tooMany("Too many codes requested. Wait a few minutes and try again.");
  return code;
}

/**
 * Check a code. Only the most recent code issued to the same requester is valid (another
 * requester's request never supersedes it); a requester with no code of their own falls back
 * to the most recent code for the address, each code allows five guesses, and a
 * correct code is consumed atomically so it can not be used twice.
 */
export async function verifyLoginCode(db: D1Database, masterKey: string, scope: string, email: string, code: string, requester: string): Promise<boolean> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  const row =
    (await db
      .prepare("SELECT id, code_hash FROM login_codes WHERE email = ? AND scope = ? AND requester = ? ORDER BY created_at DESC LIMIT 1")
      .bind(email, scope, who)
      .first<{ id: string; code_hash: string }>()) ??
    (await db
      .prepare("SELECT id, code_hash FROM login_codes WHERE email = ? AND scope = ? ORDER BY created_at DESC LIMIT 1")
      .bind(email, scope)
      .first<{ id: string; code_hash: string }>());
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
