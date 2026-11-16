// SPDX-License-Identifier: Apache-2.0
import { deriveHmacKey, hmacHex, timingSafeEqual } from "../crypto";
import { tooMany } from "../errors";
import { newId, now, randomDigits } from "../ids";

const CODE_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
/** Shared guesses on a code by requesters other than the one it was issued to. */
const MAX_FOREIGN_ATTEMPTS = 3;
/** Per (scope, email, requester): the limit a real user can hit. */
const MAX_CODES_PER_REQUESTER = 5;
/** Per (scope, email) across all requesters: anti mail-bomb cap, well above what one requester can reach. */
const MAX_CODES_PER_EMAIL = 20;
const WINDOW = 15 * 60_000;
/**
 * Total guesses (attempts + foreign_attempts) across all codes of one (scope, email) created within
 * GUESS_WINDOW. A guess made in any 15-minute span lands on a code created at most CODE_TTL before it,
 * so counting codes from WINDOW + CODE_TTL bounds guesses in any 15-minute span at this value.
 */
const MAX_GUESSES_PER_EMAIL = 100;
const GUESS_WINDOW = WINDOW + CODE_TTL;

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
 * Check a code. Two candidates: the requester's newest code (another requester's request never
 * supersedes it) and the newest code for the address overall (so a requester whose address changed
 * can use the code that was emailed last). Guesses by a code's own requester spend its `attempts`
 * budget; guesses by anyone else spend the smaller `foreign_attempts` budget, so a stranger can never
 * exhaust the owner's guesses (total guesses per code stay bounded at MAX_ATTEMPTS + MAX_FOREIGN_ATTEMPTS).
 * Across all codes of one (scope, email) from the last GUESS_WINDOW, at most MAX_GUESSES_PER_EMAIL guesses
 * are spent; at the cap verify answers false like any bad code and spends nothing.
 * Live = unconsumed, unexpired and the relevant budget unspent. Each verify spends at most one attempt on
 * each distinct candidate (a matching candidate first, so the last guess under the cap goes to it); a code
 * is accepted only after its attempt was spent under the caps, and a correct code is consumed atomically.
 */
export async function verifyLoginCode(db: D1Database, masterKey: string, scope: string, email: string, code: string, requester: string): Promise<boolean> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  type Row = { id: string; code_hash: string; requester: string | null; consumed_at: number | null; expires_at: number; attempts: number; foreign_attempts: number };
  // Take the newest row first and only then check it is live: once the newest code is consumed or
  // exhausted, older codes stay invalid (no resurrection). rowid breaks ties between codes issued in the same millisecond.
  const newestRow = (filter: string) =>
    `SELECT id, code_hash, requester, consumed_at, expires_at, attempts, foreign_attempts FROM login_codes
       WHERE email = ? AND scope = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
  const ownRow = await db.prepare(newestRow(" AND requester = ?")).bind(email, scope, who).first<Row>();
  const newestAny = await db.prepare(newestRow("")).bind(email, scope).first<Row>();
  const open = (r: Row | null): r is Row => !!r && r.consumed_at === null && r.expires_at > t && r.attempts < MAX_ATTEMPTS;
  const candidates: { row: Row; foreign: boolean }[] = [];
  if (open(ownRow)) candidates.push({ row: ownRow, foreign: false });
  if (open(newestAny) && newestAny.id !== ownRow?.id) {
    // Newest code belongs to someone else (or has no recorded requester): spend the shared foreign budget.
    if (newestAny.foreign_attempts < MAX_FOREIGN_ATTEMPTS) candidates.push({ row: newestAny, foreign: true });
  }
  const given = await codeHash(masterKey, scope, email, code);
  let matched: Row | null = null;
  // Cap total guesses per address in the same statement that spends one, so parallel verifies can not exceed it.
  const capSql = " AND (SELECT COALESCE(SUM(attempts + foreign_attempts), 0) FROM login_codes WHERE email = ? AND scope = ? AND created_at > ?) < ?";
  // Compare every candidate (no early exit) and spend on a matching one first, so the last guess under the
  // cap is never taken by a non-matching candidate. Each candidate still spends before it can be accepted.
  const compared = await Promise.all(candidates.map(async (c) => ({ ...c, hit: await timingSafeEqual(c.row.code_hash, given) })));
  compared.sort((a, b) => Number(b.hit) - Number(a.hit));
  for (const { row, foreign, hit } of compared) {
    // Spend an attempt (atomically, under the caps) before accepting, so parallel guesses can not exceed the budget.
    const spent = await db
      .prepare(
        foreign
          ? "UPDATE login_codes SET foreign_attempts = foreign_attempts + 1 WHERE id = ? AND foreign_attempts < ? AND attempts < ? AND consumed_at IS NULL AND expires_at > ?" + capSql
          : "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL AND expires_at > ?" + capSql,
      )
      .bind(...(foreign ? [row.id, MAX_FOREIGN_ATTEMPTS, MAX_ATTEMPTS, t] : [row.id, MAX_ATTEMPTS, t]), email, scope, t - GUESS_WINDOW, MAX_GUESSES_PER_EMAIL)
      .run();
    if (spent.meta.changes === 0) continue;
    if (!matched && hit) matched = row;
  }
  if (!matched) return false;
  const consumed = await db.prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(t, matched.id).run();
  return consumed.meta.changes === 1;
}
