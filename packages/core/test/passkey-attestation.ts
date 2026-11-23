// SPDX-License-Identifier: Apache-2.0
import { fromB64Url, toB64Url, utf8 } from "../src/encoding";

const P256_GX = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY";
const P256_GY = "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

const cbor = (v: Cbor): Uint8Array => {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 0xff];
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") return new Uint8Array([...head(3, utf8(v).length), ...utf8(v)]);
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  return new Uint8Array([...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])]);
};

/** A "none" attestation for a fresh P-256 credential, as a browser would send it to `passkey/register/verify`. */
export const noneAttestation = async (rpId: string, origin: string, challenge: string) => {
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64Url(P256_GX)], [-3, fromB64Url(P256_GY)]]));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(rpId)));
  const authData = new Uint8Array([...rpIdHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, credentialId.length, ...credentialId, ...cose]);
  const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  const id = toB64Url(credentialId);
  return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: toB64Url(clientDataJSON), attestationObject: toB64Url(attestationObject), transports: ["internal"] } };
};
