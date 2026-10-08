import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";

// Vault key handling and per-item envelope encryption.
//
// The vault key (32 bytes) comes from ORKESTR_VAULT_KEY (base64/base64url) or
// from <ORKESTR_HOME>/secrets/vault.key, generated once with flag "wx". An
// existing key file that cannot be read or parsed fails closed: it is never
// regenerated, because that would make every stored item unrecoverable.
//
// Each item has its own random data key. The secret payload is AES-256-GCM
// encrypted with the data key, and the data key is AES-256-GCM wrapped with
// the vault key. Both use AAD `vault:v1:<ownerUserId>:<itemId>`, so ciphertext
// cannot be moved between users or items.

export const VAULT_ENVELOPE_VERSION = 1;
const ALG = "aes-256-gcm";

function vaultError(code, statusCode = 500) {
  return Object.assign(new Error(code), { statusCode, code });
}

function clean(value) {
  return String(value ?? "").trim();
}

function decodeKey(text = "") {
  const value = clean(text);
  if (!value) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+=*$/.test(normalized)) return null;
  const key = Buffer.from(normalized, "base64");
  return key.length === 32 ? key : null;
}

export async function vaultKeyPath(env = process.env) {
  const paths = await ensureDataDirs(env);
  return path.join(paths.secrets, "vault.key");
}

async function readKeyFile(keyPath) {
  let raw;
  try {
    raw = await fs.readFile(keyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    throw vaultError("vault_key_unavailable");
  }
  const key = decodeKey(raw);
  if (!key) throw vaultError("vault_key_invalid");
  return { key };
}

/**
 * Loads the vault key. Returns `{ key, source: "env" | "file", keyId }`.
 * @param {Record<string, string | undefined>} [env]
 */
export async function loadVaultKey(env = process.env) {
  const configured = clean(env.ORKESTR_VAULT_KEY);
  if (configured) {
    const key = decodeKey(configured);
    if (!key) throw vaultError("vault_key_invalid");
    return { key, source: "env", keyId: vaultKeyId(key) };
  }
  const keyPath = await vaultKeyPath(env);
  const existing = await readKeyFile(keyPath);
  if (existing.key) return { key: existing.key, source: "file", keyId: vaultKeyId(existing.key) };
  const generated = randomBytes(32);
  try {
    await fs.writeFile(keyPath, `${generated.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw vaultError("vault_key_unavailable");
  }
  await fs.chmod(keyPath, 0o600).catch(() => {});
  const written = await readKeyFile(keyPath);
  if (!written.key) throw vaultError("vault_key_unavailable");
  return { key: written.key, source: "file", keyId: vaultKeyId(written.key) };
}

/** Key status without creating or reading key material into responses. */
export async function vaultKeyStatus(env = process.env) {
  const keyPath = await vaultKeyPath(env);
  const keyFilePresent = await fs.stat(keyPath).then(() => true, () => false);
  return { keySource: clean(env.ORKESTR_VAULT_KEY) ? "env" : "file", keyFilePresent };
}

/** Non-secret identifier of a vault key, stored with each envelope for rotation. */
export function vaultKeyId(key) {
  return createHash("sha256").update("orkestr-vault-key-id:v1:").update(key).digest("hex").slice(0, 16);
}

export function vaultAad(ownerUserId, itemId) {
  return Buffer.from(`vault:v1:${clean(ownerUserId)}:${clean(itemId)}`, "utf8");
}

function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}

function open(key, box, aad) {
  try {
    const iv = Buffer.from(clean(box?.iv), "base64url");
    // Require full-length IVs and tags: GCM otherwise accepts truncated tags.
    const tag = Buffer.from(clean(box?.tag), "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("vault_envelope_invalid");
    const decipher = createDecipheriv(ALG, key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(clean(box?.data), "base64url")), decipher.final()]);
  } catch {
    throw vaultError("vault_item_decrypt_failed");
  }
}

/**
 * Encrypts an item's secret payload into a fresh envelope.
 * @param {object} payload plain secret payload (never persisted in clear)
 */
export async function sealItemPayload(payload, ownerUserId, itemId, env = process.env) {
  const { key, keyId } = await loadVaultKey(env);
  const aad = vaultAad(ownerUserId, itemId);
  const dataKey = randomBytes(32);
  try {
    return {
      v: VAULT_ENVELOPE_VERSION,
      alg: ALG,
      keyId,
      wrappedKey: seal(key, dataKey, aad),
      payload: seal(dataKey, Buffer.from(JSON.stringify(payload || {}), "utf8"), aad),
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts an envelope produced by sealItemPayload for the same owner/item. */
export async function openItemPayload(envelope, ownerUserId, itemId, env = process.env) {
  if (!envelope || envelope.v !== VAULT_ENVELOPE_VERSION || envelope.alg !== ALG) throw vaultError("vault_item_decrypt_failed");
  const { key } = await loadVaultKey(env);
  const aad = vaultAad(ownerUserId, itemId);
  const dataKey = open(key, envelope.wrappedKey, aad);
  try {
    if (dataKey.length !== 32) throw vaultError("vault_item_decrypt_failed");
    const plain = open(dataKey, envelope.payload, aad);
    try {
      return JSON.parse(plain.toString("utf8"));
    } catch {
      throw vaultError("vault_item_decrypt_failed");
    }
  } finally {
    dataKey.fill(0);
  }
}
