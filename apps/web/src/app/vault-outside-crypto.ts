// Browser side of end-to-end vault shares (docs/vault-sharing.md). Same
// format as packages/core/src/vault-share-crypto.js: AES-256-GCM under a
// random 32-byte key that only goes into the link's #fragment; with a
// passphrase the AES key is HMAC-SHA256(fragmentKey, PBKDF2-SHA256(...)).

export interface VaultShareEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
  kdf?: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
}

const iterations = 600_000;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Bytes = Uint8Array<ArrayBuffer>;

function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

async function aesKeyBytes(fragmentKey: Bytes, passphrase: string, salt: Bytes): Promise<Bytes> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
  const hmac = await subtle.importKey("raw", fragmentKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", hmac, bits));
}

export function shareCryptoSupported(): boolean {
  return Boolean(globalThis.crypto?.subtle);
}

export async function encryptVaultShare(value: string, passphrase = ""): Promise<{ envelope: VaultShareEnvelope; key: string }> {
  const crypto = globalThis.crypto;
  const fragmentKey = randomBytes(32);
  const iv = randomBytes(12);
  const salt = randomBytes(16);
  const keyBytes = passphrase ? await aesKeyBytes(fragmentKey, passphrase, salt) : fragmentKey;
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  const envelope: VaultShareEnvelope = { v: 1, alg: "A256GCM", iv: b64url(iv), ct: b64url(ct) };
  if (passphrase) envelope.kdf = { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64url(salt) };
  return { envelope, key: b64url(fragmentKey) };
}
