// SPDX-License-Identifier: Apache-2.0
import { reauthRequired } from "../errors";
import { now } from "../ids";
import { assertFreshSession, type SessionInfo } from "../control/sessions";
import { listPasskeys } from "./passkeys";

/** How long after a request a recovery takes effect, and how long it then stays usable. */
export const RECOVERY_WAIT_MS = 48 * 3_600_000;
export const RECOVERY_TTL_MS = 7 * 86_400_000;

export interface RecoveryState {
  status: "pending" | "ready";
  requestedAt: number;
  effectiveAt: number;
  expiresAt: number;
}

export async function getRecovery(db: D1Database, userId: string, scope: string): Promise<RecoveryState | null> {
  const row = await db
    .prepare("SELECT requested_at, effective_at FROM passkey_recoveries WHERE user_id = ? AND scope = ?")
    .bind(userId, scope)
    .first<{ requested_at: number; effective_at: number }>();
  if (!row) return null;
  const expiresAt = row.effective_at + RECOVERY_TTL_MS;
  const t = now();
  if (t >= expiresAt) return null;
  return { status: t >= row.effective_at ? "ready" : "pending", requestedAt: row.requested_at, effectiveAt: row.effective_at, expiresAt };
}

/** Create the recovery (idempotent: an existing live one is kept, an expired one is replaced). */
export async function requestRecovery(db: D1Database, userId: string, scope: string): Promise<{ state: RecoveryState; created: boolean }> {
  const existing = await getRecovery(db, userId, scope);
  if (existing) return { state: existing, created: false };
  const t = now();
  await db.prepare("INSERT OR REPLACE INTO passkey_recoveries (user_id, scope, requested_at, effective_at) VALUES (?, ?, ?, ?)").bind(userId, scope, t, t + RECOVERY_WAIT_MS).run();
  return { state: (await getRecovery(db, userId, scope))!, created: true };
}

/** Remove the recovery. True when there was one. */
export async function cancelRecovery(db: D1Database, userId: string, scope: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM passkey_recoveries WHERE user_id = ? AND scope = ?").bind(userId, scope).run();
  return r.meta.changes > 0;
}

/**
 * The gate for passkey changes, workspace deletion and owner changes: a fresh session, and a
 * passkey session when the person has a passkey (or `always` is set). A fresh non-passkey session
 * only counts once a recovery has matured. Returns true when recovery was what allowed it.
 */
export async function assertPasskeyStep(
  db: D1Database,
  s: Pick<SessionInfo, "userId" | "method" | "createdAt">,
  scope: string,
  opts: { always?: boolean } = {},
): Promise<boolean> {
  const has = (await listPasskeys(db, s.userId, scope)).length > 0;
  if (!has && !opts.always) {
    assertFreshSession(s, { passkey: false });
    return false;
  }
  if (s.method === "passkey") {
    assertFreshSession(s, { passkey: true });
    return false;
  }
  assertFreshSession(s, { passkey: false });
  if (has && (await getRecovery(db, s.userId, scope))?.status === "ready") return true;
  throw reauthRequired("Sign in again with your passkey, or request passkey recovery (it takes effect after 48 hours).");
}
