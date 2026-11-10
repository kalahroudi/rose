// SPDX-License-Identifier: Apache-2.0
import { toB64Url, toHex } from "./encoding";

/** Random, non-guessable identifier with a readable prefix, e.g. `tn_9f2c…`. */
export function newId(prefix: string): string {
  return `${prefix}_${toHex(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** 256-bit random secret for session tokens, API keys and handoffs. */
export function randomToken(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Uniformly distributed numeric code (rejection sampling avoids modulo bias). */
export function randomDigits(length = 6): string {
  let out = "";
  while (out.length < length) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0]!;
    if (b < 250) out += (b % 10).toString();
  }
  return out;
}

export const now = (): number => Date.now();
