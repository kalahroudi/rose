// SPDX-License-Identifier: Apache-2.0
//
// Cryptography for Rose. Everything is WebCrypto; there is no custom primitive.
//
//   master key (worker secret)
//     ├─ HKDF "rose/kek/v1"  → KEK   wraps each tenant's data key (AES-256-GCM)
//     └─ HKDF "rose/<purpose>" → HMAC keys (login-code hashing, platform secrets)
//   tenant data key (DEK, random per tenant, stored wrapped inside the tenant's own storage)
//     ├─ AES-256-GCM field encryption, bound to tenant + field via AAD
//     └─ HKDF "rose/index/v1" → HMAC key for blind indexes (exact-match search on ciphertext)
//
import { fromB64Url, fromUtf8, toB64Url, toHex, utf8 } from "./encoding";
import { misconfigured } from "./errors";

type Bytes = Uint8Array<ArrayBuffer>;

function decodeMasterKey(b64: string | undefined, name: string): Bytes {
  if (!b64) throw misconfigured(`${name} is not set. Run \`pnpm setup\`.`);
  let raw: Bytes;
  try {
    raw = fromB64Url(b64.trim());
  } catch {
    throw misconfigured(`${name} is not valid base64.`);
  }
  if (raw.length !== 32) throw misconfigured(`${name} must decode to exactly 32 bytes.`);
  return raw;
}

async function hkdf(master: Bytes, purpose: string): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(purpose) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

const aesKey = (raw: Bytes) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
const hmacKey = (raw: Bytes) =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

/** Derive a purpose-bound HMAC key from a master key. */
export async function deriveHmacKey(masterB64: string | undefined, purpose: string): Promise<CryptoKey> {
  return hmacKey(await hkdf(decodeMasterKey(masterB64, "ROSE_MASTER_KEY"), `rose/${purpose}`));
}

export async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, utf8(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(message)));
}

/** Constant-time string comparison (compares HMACs of the inputs, so length does not leak either). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const k = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
  const [x, y] = await Promise.all([
    crypto.subtle.sign("HMAC", k, utf8(a)),
    crypto.subtle.sign("HMAC", k, utf8(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i]! ^ ya[i]!;
  return diff === 0;
}

// ── AES-GCM sealed strings: "v1.<iv>.<ciphertext+tag>" ─────────────────────────────

async function seal(key: CryptoKey, plaintext: Bytes, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, plaintext);
  return `v1.${toB64Url(iv)}.${toB64Url(ct)}`;
}

async function open(key: CryptoKey, sealed: string, aad: string): Promise<Bytes> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unrecognised ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64Url(iv), additionalData: utf8(aad) },
    key,
    fromB64Url(ct),
  );
  return new Uint8Array(pt);
}

// ── Envelope: KEK wraps per-tenant DEKs ────────────────────────────────────────────

const dekAad = (tenantId: string) => `rose:dek:${tenantId}`;

export function generateDek(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function wrapDek(masterB64: string | undefined, tenantId: string, dek: Bytes): Promise<string> {
  const kek = await aesKey(await hkdf(decodeMasterKey(masterB64, "ROSE_MASTER_KEY"), "rose/kek/v1"));
  return seal(kek, dek, dekAad(tenantId));
}

/**
 * Unwrap a tenant DEK. Tries the current master key, then the previous one (rotation).
 * `rotated` tells the caller to re-wrap under the current key.
 */
export async function unwrapDek(
  env: { ROSE_MASTER_KEY: string; ROSE_MASTER_KEY_PREVIOUS?: string },
  tenantId: string,
  wrapped: string,
): Promise<{ dek: Bytes; rotated: boolean }> {
  const attempt = async (master: string, name: string) => {
    const kek = await aesKey(await hkdf(decodeMasterKey(master, name), "rose/kek/v1"));
    return open(kek, wrapped, dekAad(tenantId));
  };
  try {
    return { dek: await attempt(env.ROSE_MASTER_KEY, "ROSE_MASTER_KEY"), rotated: false };
  } catch (err) {
    if (!env.ROSE_MASTER_KEY_PREVIOUS) throw err;
    return { dek: await attempt(env.ROSE_MASTER_KEY_PREVIOUS, "ROSE_MASTER_KEY_PREVIOUS"), rotated: true };
  }
}

// ── Field encryption bound to one tenant ───────────────────────────────────────────

/**
 * Encrypts and decrypts values for exactly one tenant. Instances are created by the
 * platform from the tenant's own data key; application code never sees key material.
 *
 * `field` names where the value lives (e.g. "contacts.email"). It is authenticated, so a
 * ciphertext copied into another column, or another tenant, fails to decrypt.
 */
export class TenantCrypto {
  private constructor(
    private readonly tenantId: string,
    private readonly key: CryptoKey,
    private readonly indexKey: CryptoKey,
  ) {}

  static async fromDek(tenantId: string, dek: Bytes): Promise<TenantCrypto> {
    return new TenantCrypto(tenantId, await aesKey(dek), await hmacKey(await hkdf(dek, "rose/index/v1")));
  }

  private aad(field: string): string {
    return `rose:field:${this.tenantId}:${field}`;
  }

  encrypt(plaintext: string, field: string): Promise<string> {
    return seal(this.key, utf8(plaintext), this.aad(field));
  }

  async decrypt(ciphertext: string, field: string): Promise<string> {
    return fromUtf8(await open(this.key, ciphertext, this.aad(field)));
  }

  /** Deterministic keyed hash for exact-match lookups on encrypted columns. */
  blindIndex(value: string, field: string): Promise<string> {
    return hmacHex(this.indexKey, `${field}\u0000${value.trim().toLowerCase()}`);
  }
}

// ── Platform secrets (operator worker): encrypts connection tokens at rest ─────────

export async function sealPlatformSecret(masterB64: string | undefined, name: string, value: string): Promise<string> {
  const key = await aesKey(await hkdf(decodeMasterKey(masterB64, "ROSE_MASTER_KEY"), "rose/platform-secret/v1"));
  return seal(key, utf8(value), `rose:platform:${name}`);
}

export async function openPlatformSecret(masterB64: string | undefined, name: string, sealed: string): Promise<string> {
  const key = await aesKey(await hkdf(decodeMasterKey(masterB64, "ROSE_MASTER_KEY"), "rose/platform-secret/v1"));
  return fromUtf8(await open(key, sealed, `rose:platform:${name}`));
}

// ── Compact HS256 JWT for the upstream gateway ────────────────────────────────────

export async function signJwtHs256(secret: string, claims: Record<string, unknown>): Promise<string> {
  const head = toB64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = toB64Url(utf8(JSON.stringify(claims)));
  const key = await hmacKey(utf8(secret));
  const sig = await crypto.subtle.sign("HMAC", key, utf8(`${head}.${body}`));
  return `${head}.${body}.${toB64Url(sig)}`;
}

export async function verifyJwtHs256(secret: string, token: string): Promise<Record<string, unknown> | null> {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return null;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, fromB64Url(sig), utf8(`${head}.${body}`));
  if (!ok) return null;
  const claims = JSON.parse(fromUtf8(fromB64Url(body))) as Record<string, unknown>;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  return claims;
}
