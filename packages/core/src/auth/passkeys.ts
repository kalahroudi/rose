// SPDX-License-Identifier: Apache-2.0
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromB64Url, toB64Url, utf8 } from "../encoding";
import { notFound, unauthorized } from "../errors";
import { newId, now } from "../ids";

// A passkey is registered for one scope and one RP ID (the exact host). The browser
// refuses to offer it on any other host, and the server re-checks scope + RP ID.

const CHALLENGE_TTL = 5 * 60_000;

export interface PasskeySite {
  scope: string;
  rpId: string;
  origin: string;
  rpName: string;
}

async function saveChallenge(db: D1Database, kind: "register" | "login", site: PasskeySite, challenge: string, userId: string | null): Promise<string> {
  const id = newId("ch");
  await db
    .prepare("INSERT INTO webauthn_challenges (id, challenge, kind, scope, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, challenge, kind, site.scope, userId, now() + CHALLENGE_TTL)
    .run();
  return id;
}

/** Single use: the row is deleted as it is read. */
async function takeChallenge(db: D1Database, id: string, kind: "register" | "login", scope: string): Promise<{ challenge: string; user_id: string | null } | null> {
  return db
    .prepare("DELETE FROM webauthn_challenges WHERE id = ? AND kind = ? AND scope = ? AND expires_at > ? RETURNING challenge, user_id")
    .bind(id, kind, scope, now())
    .first<{ challenge: string; user_id: string | null }>();
}

export async function beginRegistration(db: D1Database, site: PasskeySite, user: { id: string; email: string; name: string }) {
  const existing = await db.prepare("SELECT credential_id FROM passkeys WHERE user_id = ? AND scope = ?").bind(user.id, site.scope).all<{ credential_id: string }>();
  const options = await generateRegistrationOptions({
    rpName: site.rpName,
    rpID: site.rpId,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: utf8(user.id),
    attestationType: "none",
    excludeCredentials: existing.results.map((r) => ({ id: r.credential_id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { id: await saveChallenge(db, "register", site, options.challenge, user.id), options };
}

export async function finishRegistration(db: D1Database, site: PasskeySite, userId: string, challengeId: string, response: RegistrationResponseJSON, name: string): Promise<void> {
  const ch = await takeChallenge(db, challengeId, "register", site.scope);
  if (!ch || ch.user_id !== userId) throw unauthorized("Passkey setup expired. Try again.");
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: site.origin,
    expectedRPID: site.rpId,
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) throw unauthorized("That passkey could not be verified.");
  const cred = result.registrationInfo.credential;
  await db
    .prepare("INSERT INTO passkeys (credential_id, user_id, scope, rp_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(cred.id, userId, site.scope, site.rpId, toB64Url(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), name.trim().slice(0, 60) || "Passkey", now())
    .run();
}

export async function beginLogin(db: D1Database, site: PasskeySite) {
  const options = await generateAuthenticationOptions({ rpID: site.rpId, userVerification: "required" });
  return { id: await saveChallenge(db, "login", site, options.challenge, null), options };
}

/** Returns the authenticated user id. */
export async function finishLogin(db: D1Database, site: PasskeySite, challengeId: string, response: AuthenticationResponseJSON): Promise<string> {
  const fail = unauthorized("That passkey could not be verified.");
  const ch = await takeChallenge(db, challengeId, "login", site.scope);
  if (!ch) throw fail;
  const row = await db
    .prepare("SELECT credential_id, user_id, public_key, counter, transports FROM passkeys WHERE credential_id = ? AND scope = ? AND rp_id = ?")
    .bind(response.id, site.scope, site.rpId)
    .first<{ credential_id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!row) throw fail;
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: site.origin,
    expectedRPID: site.rpId,
    requireUserVerification: true,
    credential: { id: row.credential_id, publicKey: fromB64Url(row.public_key), counter: row.counter },
  }).catch(() => null);
  if (!result?.verified) throw fail;
  await db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?").bind(result.authenticationInfo.newCounter, now(), row.credential_id).run();
  return row.user_id;
}

export interface PasskeyItem {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export async function listPasskeys(db: D1Database, userId: string, scope: string): Promise<PasskeyItem[]> {
  const r = await db
    .prepare("SELECT credential_id AS id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? AND scope = ? ORDER BY created_at LIMIT 50")
    .bind(userId, scope)
    .all<PasskeyItem>();
  return r.results;
}

export async function deletePasskey(db: D1Database, userId: string, scope: string, credentialId: string): Promise<void> {
  const r = await db.prepare("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ? AND scope = ?").bind(credentialId, userId, scope).run();
  if (r.meta.changes === 0) throw notFound();
}
