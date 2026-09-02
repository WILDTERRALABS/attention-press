/**
 * AES-256-GCM body encryption (WebCrypto — works in the browser and in Node ≥ 20).
 * A fresh random key per article; ciphertext goes into the on-chain metadata,
 * the key goes to the collector (see the trust note in the README).
 */

export interface EncryptedBody {
  alg: "AES-GCM";
  /** base64, 12 bytes */
  iv: string;
  /** base64 ciphertext (GCM tag appended by WebCrypto) */
  ct: string;
}

const te = new TextEncoder();
const td = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** base64 -> a standalone ArrayBuffer (satisfies WebCrypto's BufferSource). */
function fromB64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 32 random bytes, base64. */
export function randomKeyB64(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

/** True for a well-formed base64 AES-256 key (44 chars, decodes to 32 bytes). */
export function isKeyB64(s: string): boolean {
  try {
    return typeof s === "string" && s.length === 44 && fromB64(s).byteLength === 32;
  } catch {
    return false;
  }
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(keyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptBody(plaintext: string, keyB64: string): Promise<EncryptedBody> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyB64);
  const data = te.encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data.buffer as ArrayBuffer);
  return { alg: "AES-GCM", iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Rejects (GCM auth failure) if the key is wrong or the ciphertext was tampered with. */
export async function decryptBody(enc: EncryptedBody, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(enc.iv) }, key, fromB64(enc.ct));
  return td.decode(pt);
}
