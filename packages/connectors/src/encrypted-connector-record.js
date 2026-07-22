import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";

const recordType = "orkestr.encrypted-connector-record";
const recordVersion = 1;
const algorithm = "aes-256-gcm";
const additionalData = Buffer.from(`${recordType}:v${recordVersion}`, "utf8");

function clean(value = "") {
  return String(value || "").trim();
}

function keyFromConfiguredValue(value = "") {
  const configured = clean(value);
  if (!configured) return null;
  if (configured.startsWith("base64:")) {
    const key = Buffer.from(configured.slice("base64:".length), "base64url");
    if (key.length !== 32) throw new Error("connector_encryption_key_invalid");
    return key;
  }
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  return createHash("sha256").update(configured).digest();
}

async function connectorEncryptionKey(env = process.env) {
  const configured = clean(
    env.ORKESTR_CONNECTOR_ENCRYPTION_KEY ||
      env.ORKESTR_SECRET_KEY ||
      env.ORKESTR_SECURE_INPUT_KEY,
  );
  const configuredKey = keyFromConfiguredValue(configured);
  if (configuredKey) return configuredKey;

  const paths = await ensureDataDirs(env);
  const keyPath = path.join(paths.secrets, "connector-encryption.key");
  const existing = await fs.readFile(keyPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (existing.trim()) return keyFromConfiguredValue(`base64:${existing.trim()}`);

  const key = randomBytes(32);
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await fs.chmod(keyPath, 0o600).catch(() => {});
  const stored = await fs.readFile(keyPath, "utf8");
  return keyFromConfiguredValue(`base64:${stored.trim()}`);
}

function keyId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function isEncryptedConnectorRecord(value = {}) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.recordType === recordType &&
      Number(value.version) === recordVersion &&
      value.encrypted &&
      typeof value.encrypted === "object",
  );
}

export async function writeEncryptedConnectorRecord(filePath, value, env = process.env) {
  const key = await connectorEncryptionKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value ?? {}), "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    recordType,
    version: recordVersion,
    encrypted: {
      algorithm,
      keyId: keyId(key),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      data: ciphertext.toString("base64url"),
    },
  };
  await writeSecretJson(filePath, envelope);
  return value;
}

export async function readEncryptedConnectorRecord(filePath, fallback = {}, env = process.env, options = {}) {
  const stored = await readJson(filePath, fallback);
  if (!isEncryptedConnectorRecord(stored)) {
    if (options.migratePlaintext !== false && stored && typeof stored === "object" && Object.keys(stored).length) {
      await writeEncryptedConnectorRecord(filePath, stored, env);
    }
    return stored;
  }

  const key = await connectorEncryptionKey(env);
  if (clean(stored.encrypted.keyId) && clean(stored.encrypted.keyId) !== keyId(key)) {
    throw new Error("connector_encryption_key_mismatch");
  }
  const decipher = createDecipheriv(algorithm, key, Buffer.from(stored.encrypted.iv, "base64url"));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(Buffer.from(stored.encrypted.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(stored.encrypted.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}
