// Operator enrollment of the WhatsApp accounts whose incoming messages a
// connected assistant may read (MCP tool list_incoming_whatsapp_messages).
//
// ORKESTR_WHATSAPP_INCOMING_SOURCES names a root-owned JSON file that says, per
// Orkestr owner, which existing and already-authorized read path backs each
// account. It holds no credential: the German bridge token stays in its own
// file and is referenced by path only.
//
//   { "format": "orkestr-whatsapp-incoming-sources-v1", "refKey": "<64 hex>", "accounts": [
//     { "account": "orkestr", "label": "...", "ownerUserId": "admin",
//       "kind": "scoped_relay_journal", "journalPath": "/var/lib/.../transport.sqlite" },
//     { "account": "german", "label": "...", "ownerUserId": "admin",
//       "kind": "coordinator_bridge", "baseUrl": "http://127.0.0.1:18749",
//       "tokenFile": "/etc/.../coordinator.token", "ownerApprovedAt": "<ISO>",
//       "assistantAuthorIds": ["<Orkestr number>@c.us", "<its LID>@lid"] } ] }
//
// `refKey` keys the opaque chat/sender/message references (HMAC), so a
// reference cannot be reversed to a phone number by trying candidates. It is a
// pseudonymization key, not a credential: it opens nothing.
//
// Also: references and phone masking shared by the readers, so no raw WhatsApp
// id (which embeds phone numbers) and no number-like name reaches an answer.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { localIsoTime } from "./provider-quota-report.js";

export const WHATSAPP_INCOMING_FORMAT = "orkestr-whatsapp-incoming-v1";
export const WHATSAPP_SOURCES_FORMAT = "orkestr-whatsapp-incoming-sources-v1";
export const WHATSAPP_INCOMING_ACCOUNTS = Object.freeze(["orkestr", "german"]);
export const WHATSAPP_REPORT_ZONE = "Europe/Berlin";
const KIND = { orkestr: "scoped_relay_journal", german: "coordinator_bridge" };
const SOURCES_LIMIT = 16_384;
const TOKEN_LIMIT = 1024;

const exactKeys = (value, required, optional = []) => value && typeof value === "object" && !Array.isArray(value)
  && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value, max) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const absolute = (value) => text(value, 512) && path.isAbsolute(value) && path.normalize(value) === value;
const userId = (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
const waId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}@(?:c\.us|lid)$/.test(value);

// Only a loopback http(s) origin: the bridge token must never leave the host.
function loopbackOrigin(value) {
  if (!text(value, 200)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

function validSource(entry) {
  const base = ["account", "label", "ownerUserId", "kind"];
  if (!entry || !WHATSAPP_INCOMING_ACCOUNTS.includes(entry.account) || entry.kind !== KIND[entry.account]
      || !text(entry.label, 80) || !userId(entry.ownerUserId)) return false;
  if (entry.kind === "scoped_relay_journal") {
    return exactKeys(entry, [...base, "journalPath"], ["ownerAuthorIds"]) && absolute(entry.journalPath)
      && (entry.ownerAuthorIds === undefined || Array.isArray(entry.ownerAuthorIds) && entry.ownerAuthorIds.length <= 16 && entry.ownerAuthorIds.every(waId));
  }
  return exactKeys(entry, [...base, "baseUrl", "tokenFile", "ownerApprovedAt"], ["assistantAuthorIds"])
    && loopbackOrigin(entry.baseUrl) && absolute(entry.tokenFile) && Number.isFinite(Date.parse(entry.ownerApprovedAt))
    && (entry.assistantAuthorIds === undefined || Array.isArray(entry.assistantAuthorIds) && entry.assistantAuthorIds.length <= 16 && entry.assistantAuthorIds.every(waId));
}

// A small private file: no symlink, one link, not group/other writable (or
// readable, for the token), bounded size.
async function readPrivateFile(filename, { owners = null, forbiddenMode, limit }) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (owners && !owners.includes(stat.uid)) || (stat.mode & forbiddenMode) || stat.size > limit) throw new Error("custody");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("bound");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

// The owner's enrolled accounts: { configured, accounts: Map(account -> source) };
// each source carries the file's refKey. Missing, unprotected or invalid
// configuration enrolls nothing (fails closed); a duplicate or invalid entry
// for this owner drops that account.
export async function loadWhatsAppSources(ownerUserId, env = process.env) {
  const filename = env.ORKESTR_WHATSAPP_INCOMING_SOURCES;
  const accounts = new Map();
  if (!absolute(filename || "")) return { configured: false, accounts };
  let config;
  try {
    config = JSON.parse(await readPrivateFile(filename, { owners: [0, process.getuid?.()].filter(Number.isInteger), forbiddenMode: 0o027, limit: SOURCES_LIMIT }));
  } catch { return { configured: false, accounts }; }
  if (!exactKeys(config, ["format", "refKey", "accounts"]) || config.format !== WHATSAPP_SOURCES_FORMAT || !/^[0-9a-f]{64}$/.test(config.refKey)
      || !Array.isArray(config.accounts) || config.accounts.length > 16) {
    return { configured: false, accounts };
  }
  const owned = config.accounts.filter((entry) => entry && typeof entry === "object" && entry.ownerUserId === ownerUserId);
  for (const account of WHATSAPP_INCOMING_ACCOUNTS) {
    const entries = owned.filter((entry) => entry.account === account);
    if (entries.length === 1 && validSource(entries[0])) accounts.set(account, Object.freeze({ ...entries[0], refKey: config.refKey }));
  }
  return { configured: true, accounts };
}

// The bridge token, read per call so a rotation applies; never logged.
export async function readSourceToken(source) {
  const value = (await readPrivateFile(source.tokenFile, { forbiddenMode: 0o077, limit: TOKEN_LIMIT })).trim();
  if (!value || /\s/.test(value)) throw new Error("token");
  return value;
}

const keyed = (key, ...parts) => createHmac("sha256", Buffer.from(String(key || ""), "hex")).update(parts.join("\0")).digest("hex");

// Stable opaque references: raw chat and sender ids embed phone numbers.
export const chatRef = (key, account, rawChatId) => `wa-${keyed(key, "orkestr-wa-chat-v1", account, rawChatId).slice(0, 20)}`;
export const senderRef = (key, account, rawSenderId) => `ws-${keyed(key, "orkestr-wa-sender-v1", account, rawSenderId).slice(0, 20)}`;

// +49…62 for a phone-number id; null for a LID or anything else.
const maskDigits = (digits) => `+${digits.slice(0, 2)}…${digits.slice(-2)}`;
export function maskedNumber(rawId) {
  const match = /^(\d{6,20})@c\.us$/.exec(String(rawId || ""));
  return match ? maskDigits(match[1]) : null;
}

// A contact WhatsApp has no name for is listed under its formatted number
// ("+49 176 …"): mask a name made of digits only, and every "+"-number in a
// name (6+ digits). Dates and other numbers in group names stay.
export function maskedName(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const name = value.trim().slice(0, 80);
  const digitsOf = (text) => text.replace(/\D/g, "");
  if (/^[\d\s().-]+$/.test(name) && digitsOf(name).length >= 6) return maskDigits(digitsOf(name));
  return name.replace(/\+\d[\d\s().-]{4,}\d/g, (run) => digitsOf(run).length >= 6 ? maskDigits(digitsOf(run)) : run);
}

// The provider's message key (third part of fromMe_chat_key[_author]); it
// carries no phone number. Anything unexpected is replaced by a keyed hash.
export function messageKey(key, serializedId) {
  const part = String(serializedId || "").split("_")[2] || "";
  return /^[A-Za-z0-9]{6,64}$/.test(part) ? part : `h${keyed(key, "orkestr-wa-message-v1", String(serializedId || "")).slice(0, 24)}`;
}

export const timePair = (ms) => ({ utc: new Date(ms).toISOString(), berlin: localIsoTime(ms, WHATSAPP_REPORT_ZONE) });

const MAX_TEXT = 4000;
export function boundedText(value) {
  const textValue = typeof value === "string" ? value : "";
  if (!textValue.trim()) return { text: null, textTruncated: false };
  return textValue.length > MAX_TEXT ? { text: textValue.slice(0, MAX_TEXT), textTruncated: true } : { text: textValue, textTruncated: false };
}
