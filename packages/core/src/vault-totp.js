import { createHmac } from "node:crypto";

// RFC 4226 (HOTP) and RFC 6238 (TOTP) one-time codes plus RFC 4648 base32.
// Errors carry value-free codes only; secrets never appear in messages.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_ALGORITHMS = Object.freeze(["SHA1", "SHA256", "SHA512"]);
const MAX_SECRET_BYTES = 128;

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

/** Decodes RFC 4648 base32 (case-insensitive, optional padding, spaces/dashes ignored). */
export function base32Decode(input = "") {
  const text = String(input || "").replace(/[\s-]+/g, "").toUpperCase().replace(/=+$/g, "");
  if (!text) throw vaultError("vault_totp_secret_invalid");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw vaultError("vault_totp_secret_invalid");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= 0xff;
  }
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES) throw vaultError("vault_totp_secret_invalid");
  return Buffer.from(bytes);
}

/** Encodes bytes as unpadded upper-case RFC 4648 base32. */
export function base32Encode(buffer) {
  const bytes = Buffer.from(buffer || []);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= 0xff;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function normalizeAlgorithm(value = "SHA1") {
  const name = String(value || "SHA1").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!TOTP_ALGORITHMS.includes(name)) throw vaultError("vault_totp_algorithm_unsupported");
  return name;
}

function normalizeDigits(value = 6) {
  const digits = Number(value || 6);
  if (digits !== 6 && digits !== 8) throw vaultError("vault_totp_digits_unsupported");
  return digits;
}

function normalizePeriod(value = 30) {
  const period = Number(value || 30);
  if (!Number.isInteger(period) || period < 1 || period > 3600) throw vaultError("vault_totp_period_invalid");
  return period;
}

function counterBuffer(counter) {
  const value = BigInt(counter);
  if (value < 0n || value > 0xffffffffffffffffn) throw vaultError("vault_totp_counter_invalid");
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

/** RFC 4226 HOTP over raw key bytes. */
export function hotp(key, counter, { algorithm = "SHA1", digits = 6 } = {}) {
  const hmac = createHmac(normalizeAlgorithm(algorithm).toLowerCase(), Buffer.from(key)).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const size = normalizeDigits(digits);
  return String(binary % 10 ** size).padStart(size, "0");
}

/** RFC 6238 TOTP over raw key bytes at `nowMs`. */
export function totp(key, { nowMs = Date.now(), period = 30, algorithm = "SHA1", digits = 6, t0 = 0 } = {}) {
  const step = normalizePeriod(period);
  const counter = Math.floor((Math.floor(nowMs / 1000) - t0) / step);
  return hotp(key, counter, { algorithm, digits });
}

/** Validates and normalizes a stored TOTP/HOTP configuration. */
export function normalizeTotpConfig(input = {}) {
  const type = String(input.type || "totp").trim().toLowerCase();
  if (type !== "totp" && type !== "hotp") throw vaultError("vault_totp_type_unsupported");
  const secretBytes = base32Decode(input.secret);
  const counter = type === "hotp" ? Number(input.counter || 0) : 0;
  if (!Number.isSafeInteger(counter) || counter < 0) throw vaultError("vault_totp_counter_invalid");
  return {
    secret: base32Encode(secretBytes),
    algorithm: normalizeAlgorithm(input.algorithm || "SHA1"),
    digits: normalizeDigits(input.digits || 6),
    period: normalizePeriod(input.period || 30),
    type,
    counter,
    issuer: String(input.issuer || "").trim().slice(0, 200),
    accountName: String(input.accountName || "").trim().slice(0, 200),
  };
}

/**
 * Current code for a stored config. HOTP uses (and the caller must persist)
 * `nextCounter`.
 */
export function currentCode(config = {}, nowMs = Date.now()) {
  const normalized = normalizeTotpConfig(config);
  const key = base32Decode(normalized.secret);
  if (normalized.type === "hotp") {
    const code = hotp(key, normalized.counter, normalized);
    return { code, digits: normalized.digits, period: null, expiresInSeconds: null, counter: normalized.counter, nextCounter: normalized.counter + 1 };
  }
  const seconds = Math.floor(nowMs / 1000);
  return {
    code: totp(key, { ...normalized, nowMs }),
    digits: normalized.digits,
    period: normalized.period,
    expiresInSeconds: normalized.period - (seconds % normalized.period),
  };
}
