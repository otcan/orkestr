import { csvRecords, parseCsv } from "./vault-csv.js";
import { parseOtpauthMigrationUri, parseOtpauthUri } from "./vault-otpauth.js";
import { normalizeTotpConfig } from "./vault-totp.js";

// Turns import content (Bitwarden / 1Password / Chrome CSV, otpauth:// and
// otpauth-migration:// URIs) into vault item inputs. Pure: no storage. Skip
// reasons are value-free codes with row numbers only.

export const IMPORT_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 5000 });
export const IMPORT_FORMATS = Object.freeze(["auto", "bitwarden", "1password", "chrome", "otpauth"]);
const MAX_REASONS = 200;

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

function clean(value) {
  return String(value ?? "").trim();
}

const columnAliases = {
  bitwarden: {
    type: ["type"],
    name: ["name"],
    url: ["login_uri"],
    username: ["login_username"],
    password: ["login_password"],
    totp: ["login_totp"],
    notes: ["notes"],
    fields: ["fields"],
    folder: ["folder"],
  },
  "1password": {
    name: ["title", "name"],
    url: ["website", "url", "urls", "login url", "login_url"],
    username: ["username", "user name", "login", "email"],
    password: ["password"],
    totp: ["otpauth", "one-time password", "one time password", "otp", "totp"],
    notes: ["notes", "notesplain", "note"],
  },
  chrome: {
    name: ["name"],
    url: ["url"],
    username: ["username"],
    password: ["password"],
    notes: ["note", "notes"],
  },
};

function pick(record, aliases = []) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) return String(record[alias] ?? "");
  }
  return "";
}

export function detectCsvFormat(headers = []) {
  const has = (name) => headers.includes(name);
  if (has("login_password") || has("login_username") || has("login_uri")) return "bitwarden";
  if (has("title") && has("password")) return "1password";
  if (has("name") && has("url") && has("username") && has("password")) return "chrome";
  if (has("password") && (has("website") || has("otpauth"))) return "1password";
  return "";
}

function parseTotpValue(value = "") {
  const text = clean(value);
  if (!text) return null;
  if (/^otpauth:\/\//i.test(text)) return parseOtpauthUri(text);
  return normalizeTotpConfig({ secret: text });
}

function parseBitwardenFields(value = "") {
  return String(value || "").split(/\r?\n/).map((line) => {
    const separator = line.indexOf(": ");
    return separator >= 0 ? { name: line.slice(0, separator), value: line.slice(separator + 2) } : { name: line, value: "" };
  }).filter((field) => clean(field.name) || clean(field.value));
}

function csvEntries(content, requested) {
  const rows = parseCsv(content, { maxRows: IMPORT_LIMITS.maxRows + 1 });
  if (rows.length < 1) throw vaultError("vault_import_empty");
  const { headers, records } = csvRecords(rows);
  const format = requested === "auto" ? detectCsvFormat(headers) : requested;
  if (!format || !columnAliases[format]) throw vaultError("vault_import_format_unknown");
  const aliases = columnAliases[format];
  if (!aliases.password.some((alias) => headers.includes(alias))) throw vaultError("vault_import_format_mismatch");
  const entries = [];
  const reasons = [];
  records.forEach((record, index) => {
    const row = index + 2;
    if (Object.values(record).every((value) => !clean(value))) return;
    if (format === "bitwarden") {
      const type = clean(pick(record, aliases.type)).toLowerCase();
      if (type && type !== "login") return reasons.push({ row, reason: "unsupported_item_type", skipped: true });
    }
    const url = clean(pick(record, aliases.url).split(/[\r\n,]/)[0]);
    const input = {
      name: clean(pick(record, aliases.name)),
      url,
      username: pick(record, aliases.username),
      password: pick(record, aliases.password),
      notes: pick(record, aliases.notes),
    };
    if (format === "bitwarden") {
      const fields = parseBitwardenFields(pick(record, aliases.fields));
      if (fields.length) input.fields = fields;
      const folder = clean(pick(record, aliases.folder));
      if (folder) input.tags = [folder];
    }
    if (!input.name && !url) return reasons.push({ row, reason: "missing_name_and_url", skipped: true });
    if (!input.password && !input.username && !clean(pick(record, aliases.totp || []))) {
      return reasons.push({ row, reason: "no_credentials", skipped: true });
    }
    const totpValue = pick(record, aliases.totp || []);
    if (clean(totpValue)) {
      try {
        input.totp = parseTotpValue(totpValue);
      } catch {
        reasons.push({ row, reason: "totp_invalid_ignored", skipped: false });
      }
    }
    entries.push({ row, input });
  });
  return { format, entries, reasons };
}

function totpEntry(config, row) {
  return { row, input: { name: config.issuer || config.accountName, username: config.accountName, totp: config }, totpOnly: true };
}

function otpauthEntries(content) {
  const lines = String(content || "").split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length > IMPORT_LIMITS.maxRows) throw vaultError("vault_import_too_many_rows", 413);
  const entries = [];
  const reasons = [];
  lines.forEach((line, index) => {
    const row = index + 1;
    if (/^otpauth-migration:\/\//i.test(line)) {
      let parsed;
      try {
        parsed = parseOtpauthMigrationUri(line);
      } catch (error) {
        return reasons.push({ row, reason: clean(error?.code) || "migration_invalid", skipped: true });
      }
      for (const account of parsed.accounts) {
        if (account.ok) entries.push(totpEntry(account.config, row));
        else reasons.push({ row, reason: account.reason, skipped: true });
      }
      return undefined;
    }
    try {
      entries.push(totpEntry(parseOtpauthUri(line), row));
    } catch (error) {
      reasons.push({ row, reason: clean(error?.code) || "otpauth_invalid", skipped: true });
    }
    return undefined;
  });
  if (entries.length > IMPORT_LIMITS.maxRows) throw vaultError("vault_import_too_many_rows", 413);
  return { format: "otpauth", entries, reasons };
}

/**
 * @param {{ format?: string, content?: string }} input
 * @returns {{ format: string, entries: { row: number, input: object, totpOnly?: boolean }[], reasons: { row: number, reason: string, skipped: boolean }[] }}
 */
export function planVaultImport({ format = "auto", content = "" } = {}) {
  const requested = clean(format || "auto").toLowerCase();
  if (!IMPORT_FORMATS.includes(requested)) throw vaultError("vault_import_format_unknown");
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) throw vaultError("vault_import_empty");
  if (Buffer.byteLength(text, "utf8") > IMPORT_LIMITS.maxBytes) throw vaultError("vault_import_too_large", 413);
  const looksLikeOtpauth = /^\s*otpauth(?:-migration)?:\/\//i.test(text.replace(/^﻿/, ""));
  const plan = requested === "otpauth" || (requested === "auto" && looksLikeOtpauth)
    ? otpauthEntries(text)
    : csvEntries(text, requested);
  return { ...plan, reasons: plan.reasons.slice(0, MAX_REASONS * 5) };
}

export function publicImportReasons(reasons = []) {
  return reasons.slice(0, MAX_REASONS).map(({ row, reason }) => ({ row, reason }));
}
