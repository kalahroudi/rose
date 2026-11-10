// SPDX-License-Identifier: Apache-2.0
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s) as Uint8Array<ArrayBuffer>;
export const fromUtf8 = (b: BufferSource): string => dec.decode(b);

export function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}
