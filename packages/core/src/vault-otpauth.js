import { base32Encode, normalizeTotpConfig } from "./vault-totp.js";

// otpauth:// (Key Uri Format) and Google Authenticator otpauth-migration://
// parsing. A tiny protobuf reader is used for the migration payload; inputs
// are size-capped and malformed data is rejected with value-free codes.

const MAX_URI_LENGTH = 4096;
const MAX_MIGRATION_BYTES = 64 * 1024;
const MAX_MIGRATION_ACCOUNTS = 500;

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

function safeDecode(value = "") {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch {
    throw vaultError("vault_otpauth_invalid");
  }
}

/** Parses `otpauth://totp|hotp/<label>?secret=...` into a normalized config. */
export function parseOtpauthUri(input = "") {
  const text = String(input || "").trim();
  if (!text || text.length > MAX_URI_LENGTH) throw vaultError("vault_otpauth_invalid");
  const match = text.match(/^otpauth:\/\/([a-z]+)\/([^?#]*)(?:\?([^#]*))?/i);
  if (!match) throw vaultError("vault_otpauth_invalid");
  const type = match[1].toLowerCase();
  if (type !== "totp" && type !== "hotp") throw vaultError("vault_totp_type_unsupported");
  const label = safeDecode(match[2]);
  const params = new URLSearchParams(match[3] || "");
  const separator = label.indexOf(":");
  const labelIssuer = separator >= 0 ? label.slice(0, separator).trim() : "";
  const accountName = (separator >= 0 ? label.slice(separator + 1) : label).trim();
  const issuer = String(params.get("issuer") || labelIssuer || "").trim();
  if (type === "hotp" && !params.has("counter")) throw vaultError("vault_totp_counter_invalid");
  return normalizeTotpConfig({
    type,
    secret: params.get("secret") || "",
    issuer,
    accountName,
    algorithm: params.get("algorithm") || "SHA1",
    digits: params.get("digits") || 6,
    period: params.get("period") || 30,
    counter: type === "hotp" ? Number(params.get("counter")) : 0,
  });
}

/** Builds an otpauth:// URI for export. Contains the secret: owner-only use. */
export function buildOtpauthUri(config = {}) {
  const normalized = normalizeTotpConfig(config);
  const label = normalized.issuer
    ? `${encodeURIComponent(normalized.issuer)}:${encodeURIComponent(normalized.accountName)}`
    : encodeURIComponent(normalized.accountName || "account");
  const params = new URLSearchParams({ secret: normalized.secret });
  if (normalized.issuer) params.set("issuer", normalized.issuer);
  params.set("algorithm", normalized.algorithm);
  params.set("digits", String(normalized.digits));
  if (normalized.type === "hotp") params.set("counter", String(normalized.counter));
  else params.set("period", String(normalized.period));
  return `otpauth://${normalized.type}/${label}?${params.toString()}`;
}

class ProtoReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  done() {
    return this.offset >= this.buffer.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.buffer.length) throw vaultError("vault_migration_malformed");
      const byte = this.buffer[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result & 0xffffffffffffffffn;
      shift += 7n;
    }
    throw vaultError("vault_migration_malformed");
  }

  bytes() {
    const length = this.varint();
    if (length > BigInt(this.buffer.length - this.offset)) throw vaultError("vault_migration_malformed");
    const start = this.offset;
    this.offset += Number(length);
    return this.buffer.subarray(start, this.offset);
  }

  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.bytes();
    else if (wireType === 1) this.advance(8);
    else if (wireType === 5) this.advance(4);
    else throw vaultError("vault_migration_malformed");
  }

  advance(count) {
    if (this.offset + count > this.buffer.length) throw vaultError("vault_migration_malformed");
    this.offset += count;
  }

  fields(handler) {
    while (!this.done()) {
      const tag = this.varint();
      const field = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (field < 1) throw vaultError("vault_migration_malformed");
      if (!handler(field, wireType, this)) this.skip(wireType);
    }
  }
}

const migrationAlgorithms = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };

function parseOtpParameters(buffer) {
  const raw = { secret: null, name: "", issuer: "", algorithm: 0, digits: 0, type: 0, counter: 0n };
  new ProtoReader(buffer).fields((field, wireType, reader) => {
    if (wireType === 2 && field === 1) raw.secret = Buffer.from(reader.bytes());
    else if (wireType === 2 && field === 2) raw.name = reader.bytes().toString("utf8");
    else if (wireType === 2 && field === 3) raw.issuer = reader.bytes().toString("utf8");
    else if (wireType === 0 && field === 4) raw.algorithm = Number(reader.varint());
    else if (wireType === 0 && field === 5) raw.digits = Number(reader.varint());
    else if (wireType === 0 && field === 6) raw.type = Number(reader.varint());
    else if (wireType === 0 && field === 7) raw.counter = reader.varint();
    else return false;
    return true;
  });
  if (!raw.secret?.length) throw vaultError("vault_totp_secret_invalid");
  const algorithm = migrationAlgorithms[raw.algorithm];
  if (!algorithm) throw vaultError("vault_totp_algorithm_unsupported");
  const digits = raw.digits === 2 ? 8 : raw.digits === 0 || raw.digits === 1 ? 6 : 0;
  if (!digits) throw vaultError("vault_totp_digits_unsupported");
  if (![0, 1, 2].includes(raw.type)) throw vaultError("vault_totp_type_unsupported");
  if (raw.counter > BigInt(Number.MAX_SAFE_INTEGER)) throw vaultError("vault_totp_counter_invalid");
  const separator = raw.name.indexOf(":");
  const labelIssuer = separator >= 0 ? raw.name.slice(0, separator).trim() : "";
  const accountName = (separator >= 0 ? raw.name.slice(separator + 1) : raw.name).trim();
  return normalizeTotpConfig({
    type: raw.type === 1 ? "hotp" : "totp",
    secret: base32Encode(raw.secret),
    issuer: raw.issuer.trim() || labelIssuer,
    accountName,
    algorithm,
    digits,
    period: 30,
    counter: Number(raw.counter),
  });
}

/**
 * Parses `otpauth-migration://offline?data=<base64 MigrationPayload>`.
 * Returns `{ accounts: [{ ok, config? , reason? }], batchIndex, batchSize }`.
 * Individual bad accounts are reported, a malformed envelope throws.
 */
export function parseOtpauthMigrationUri(input = "") {
  const text = String(input || "").trim();
  if (!/^otpauth-migration:\/\/offline\?/i.test(text) || text.length > MAX_MIGRATION_BYTES * 2) {
    throw vaultError("vault_migration_invalid");
  }
  const params = new URLSearchParams(text.slice(text.indexOf("?") + 1));
  const data = String(params.get("data") || "").replace(/ /g, "+");
  if (!data || !/^[A-Za-z0-9+/_-]+=*$/.test(data)) throw vaultError("vault_migration_invalid");
  const buffer = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buffer.length || buffer.length > MAX_MIGRATION_BYTES) throw vaultError("vault_migration_invalid");
  const parameters = [];
  const meta = { batchSize: 1, batchIndex: 0 };
  new ProtoReader(buffer).fields((field, wireType, reader) => {
    if (field === 1 && wireType === 2) {
      if (parameters.length >= MAX_MIGRATION_ACCOUNTS) throw vaultError("vault_migration_too_large");
      parameters.push(reader.bytes());
    } else if (field === 3 && wireType === 0) meta.batchSize = Number(reader.varint());
    else if (field === 4 && wireType === 0) meta.batchIndex = Number(reader.varint());
    else return false;
    return true;
  });
  const accounts = parameters.map((entry) => {
    try {
      return { ok: true, config: parseOtpParameters(entry) };
    } catch (error) {
      if (error?.message === "vault_migration_malformed") throw error;
      return { ok: false, reason: String(error?.code || "vault_totp_invalid") };
    }
  });
  return { accounts, ...meta };
}
