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
 * Check a code. Two candidates: the requester's newest live code (another requester's request
 * never supersedes it) and the newest code for the address overall (if still live) (so a requester whose
 * address changed can use the code that was emailed last). Live = unconsumed, unexpired, under the
 * guess budget. Each verify spends at most one attempt on each distinct candidate, before comparing,
 * and a correct code is consumed atomically so it can not be used twice.
 */
export async function verifyLoginCode(db: D1Database, masterKey: string, scope: string, email: string, code: string, requester: string): Promise<boolean> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  type Row = { id: string; code_hash: string };
  // Take the newest row first and only then require it to be live: once the newest code is consumed or
  // exhausted, older codes stay invalid (no resurrection, and one requester's guesses can not spill onto
  // another requester's older code). rowid breaks ties between codes issued in the same millisecond.
  const newestLive = (filter: string) =>
    `SELECT id, code_hash FROM (SELECT id, code_hash, consumed_at, expires_at, attempts FROM login_codes
       WHERE email = ? AND scope = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT 1)
     WHERE consumed_at IS NULL AND expires_at > ? AND attempts < ?`;
  const own = await db.prepare(newestLive(" AND requester = ?")).bind(email, scope, who, t, MAX_ATTEMPTS).first<Row>();
  const newest = await db.prepare(newestLive("")).bind(email, scope, t, MAX_ATTEMPTS).first<Row>();
  const candidates = [own, newest].filter((r, i, all): r is Row => !!r && all.findIndex((x) => x?.id === r.id) === i);
  const given = await codeHash(masterKey, scope, email, code);
  let matched: Row | null = null;
  for (const row of candidates) {
    // Spend an attempt before comparing, so parallel guesses can not exceed the budget.
    const spent = await db
      .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL AND expires_at > ?")
      .bind(row.id, MAX_ATTEMPTS, t)
      .run();
    if (spent.meta.changes === 0) continue;
    if (!matched && (await timingSafeEqual(row.code_hash, given))) matched = row;
  }
  if (!matched) return false;
  const consumed = await db.prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(t, matched.id).run();
  return consumed.meta.changes === 1;
}
