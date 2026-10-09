import crypto from "node:crypto";

// End-to-end envelope for public vault share links (docs/vault-sharing.md).
// The sender (CLI or browser) encrypts; the server stores only the envelope;
// the recipient's browser decrypts with the key from the URL fragment, which
// browsers never send to the server. With a passphrase the AES key is
// HMAC-SHA256(fragmentKey, PBKDF2-SHA256(passphrase, salt)), so neither the
// link alone nor the passphrase alone opens the secret. The recipient page
// (vault-share-pages.ts) implements the same derivation with WebCrypto.

export const VAULT_SHARE_PBKDF2_ITERATIONS = 600_000;
const minIterations = 100_000;
const maxIterations = 5_000_000;
const maxCiphertextBytes = 32 * 1024;
const b64url = /^[A-Za-z0-9_-]+$/;

function shareError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function decode(value, { min = 1, max = maxCiphertextBytes } = {}) {
  const text = typeof value === "string" ? value : "";
  if (!text || !b64url.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length >= min && bytes.length <= max ? bytes : null;
}

function aesKey(fragmentKey, passphrase, kdf) {
  if (!kdf) return fragmentKey;
  const stretched = crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), Buffer.from(kdf.salt, "base64url"), kdf.iterations, 32, "sha256");
  return crypto.createHmac("sha256", fragmentKey).update(stretched).digest();
}

/** Encrypts a value; returns `{ envelope, key }` where `key` belongs in the URL fragment only. */
export function encryptVaultShare(value, { passphrase = "", iterations = VAULT_SHARE_PBKDF2_ITERATIONS } = {}) {
  const fragmentKey = crypto.randomBytes(32);
  const kdf = passphrase ? { name: "PBKDF2", hash: "SHA-256", iterations, salt: crypto.randomBytes(16).toString("base64url") } : null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(fragmentKey, passphrase, kdf), iv);
  const ct = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const envelope = { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: ct.toString("base64url"), ...(kdf ? { kdf } : {}) };
  return { envelope, key: fragmentKey.toString("base64url") };
}

/** Test/diagnostic counterpart of the recipient page. Throws on a wrong key or passphrase. */
export function decryptVaultShare(envelope, key, passphrase = "") {
  const valid = normalizeVaultShareEnvelope(envelope);
  const fragmentKey = decode(key, { min: 32, max: 32 });
  if (!fragmentKey) throw shareError("vault_share_key_invalid");
  if (valid.kdf && !passphrase) throw shareError("vault_share_passphrase_required");
  const ct = Buffer.from(valid.ct, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(fragmentKey, passphrase, valid.kdf), Buffer.from(valid.iv, "base64url"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8");
}

/** Strict shape check for envelopes received by the server; unknown fields are dropped. */
export function normalizeVaultShareEnvelope(input) {
  const envelope = input && typeof input === "object" ? input : {};
  if (envelope.v !== 1 || envelope.alg !== "A256GCM") throw shareError("vault_share_envelope_invalid");
  if (!decode(envelope.iv, { min: 12, max: 12 }) || !decode(envelope.ct, { min: 17 })) throw shareError("vault_share_envelope_invalid");
  const out = { v: 1, alg: "A256GCM", iv: envelope.iv, ct: envelope.ct };
  if (envelope.kdf !== undefined && envelope.kdf !== null) {
    const { name, hash, iterations, salt } = envelope.kdf || {};
    const okIterations = Number.isInteger(iterations) && iterations >= minIterations && iterations <= maxIterations;
    if (name !== "PBKDF2" || hash !== "SHA-256" || !okIterations || !decode(salt, { min: 16, max: 64 })) {
      throw shareError("vault_share_envelope_invalid");
    }
    out.kdf = { name, hash, iterations, salt };
  }
  return out;
}
