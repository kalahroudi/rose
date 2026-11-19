// SPDX-License-Identifier: Apache-2.0
import { deriveHmacKey, hmacHex, timingSafeEqual } from "../crypto";
import { tooMany } from "../errors";
import { newId, now, randomDigits } from "../ids";

const CODE_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_FOREIGN_ATTEMPTS = 3;
const MAX_CODES_PER_REQUESTER = 5;
const MAX_CODES_PER_EMAIL = 20;
const WINDOW = 15 * 60_000;
const MAX_GUESSES_PER_EMAIL = 100;
const GUESS_WINDOW = WINDOW + CODE_TTL;

const codeHash = async (masterKey: string, scope: string, email: string, code: string) =>
  hmacHex(await deriveHmacKey(masterKey, "login-code/v1"), `${scope}\u0000${email}\u0000${code}`);

const requesterHash = async (masterKey: string, requester: string) =>
  hmacHex(await deriveHmacKey(masterKey, "login-code-requester/v1"), requester);

export async function issueLoginCode(db: D1Database, masterKey: string, scope: string, email: string, requester: string): Promise<string> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  const code = randomDigits(6);
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

export async function verifyLoginCode(db: D1Database, masterKey: string, scope: string, email: string, code: string, requester: string): Promise<boolean> {
  const t = now();
  const who = await requesterHash(masterKey, requester);
  type Row = { id: string; code_hash: string; requester: string | null; consumed_at: number | null; expires_at: number; attempts: number; foreign_attempts: number };
  const newestRow = (filter: string) =>
    `SELECT id, code_hash, requester, consumed_at, expires_at, attempts, foreign_attempts FROM login_codes
       WHERE email = ? AND scope = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
  const ownRow = await db.prepare(newestRow(" AND requester = ?")).bind(email, scope, who).first<Row>();
  const newestAny = await db.prepare(newestRow("")).bind(email, scope).first<Row>();
  const open = (r: Row | null): r is Row => !!r && r.consumed_at === null && r.expires_at > t && r.attempts < MAX_ATTEMPTS;
  const candidates: { row: Row; foreign: boolean }[] = [];
  if (open(ownRow)) candidates.push({ row: ownRow, foreign: false });
  if (open(newestAny) && newestAny.id !== ownRow?.id) {
    if (newestAny.foreign_attempts < MAX_FOREIGN_ATTEMPTS) candidates.push({ row: newestAny, foreign: true });
  }
  const given = await codeHash(masterKey, scope, email, code);
  let matched: Row | null = null;
  const capSql = " AND (SELECT COALESCE(SUM(attempts + foreign_attempts), 0) FROM login_codes WHERE email = ? AND scope = ? AND created_at > ?) < ?";
  const compared = await Promise.all(candidates.map(async (c) => ({ ...c, hit: await timingSafeEqual(c.row.code_hash, given) })));
  compared.sort((a, b) => Number(b.hit) - Number(a.hit));
  for (const { row, foreign, hit } of compared) {
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
