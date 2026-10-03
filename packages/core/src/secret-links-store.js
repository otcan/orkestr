import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { normalizeUserId } from "./users.js";

// Persistence for one-time secret links (docs/secret-links.md). Only the
// sha256 of a link token is stored; share ciphertext is removed as soon as a
// link is used, revoked or expires. Terminal records keep metadata (never a
// value) for a day so `orkestr secret links list` can show what happened.

export const SECRET_LINK_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const SECRET_LINK_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const SECRET_LINK_MIN_TTL_MS = 60 * 1000;
export const SECRET_LINK_MAX_VALUE_BYTES = 16 * 1024;
const terminalRetentionMs = 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/;

function clean(value) {
  return String(value ?? "").trim();
}

export function secretLinkError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function newSecretLinkToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function newSecretLinkId() {
  return `sl_${crypto.randomBytes(9).toString("hex")}`;
}

export function secretLinkTokenHash(token = "") {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function plausibleSecretLinkToken(token = "") {
  return tokenPattern.test(String(token || ""));
}

/** Parses "90s", "15m", "2h", "1d" or plain seconds. Returns milliseconds. */
export function parseSecretLinkTtl(value = "") {
  const text = clean(value).toLowerCase();
  if (!text) return SECRET_LINK_DEFAULT_TTL_MS;
  const match = text.match(/^(\d{1,6})\s*(s|m|h|d)?$/);
  if (!match) throw secretLinkError("secret_link_ttl_invalid");
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] || "s"];
  const ms = Number(match[1]) * unit;
  if (ms < SECRET_LINK_MIN_TTL_MS) throw secretLinkError("secret_link_ttl_too_short");
  if (ms > SECRET_LINK_MAX_TTL_MS) throw secretLinkError("secret_link_ttl_too_long");
  return ms;
}

export function assertSecretLinkValue(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) throw secretLinkError("secret_value_required");
  if (Buffer.byteLength(text, "utf8") > SECRET_LINK_MAX_VALUE_BYTES) throw secretLinkError("secret_value_too_large", 413);
  return text;
}

function storePath(env = process.env) {
  return `${dataPaths(env).secrets}/secret-links.json`;
}

export function secretLinkActive(link = {}, now = Date.now()) {
  return link.status === "active" && Date.parse(link.expiresAt || "") > now;
}

// Expired-but-active links become "expired" and lose their ciphertext;
// terminal records past the retention window are dropped. Returns the ids of
// links that expired during this sweep so callers can audit them.
function sweep(links = [], now = Date.now()) {
  const expired = [];
  const kept = [];
  for (const link of links) {
    if (!link || typeof link !== "object" || !clean(link.id)) continue;
    let next = link;
    if (next.status === "active" && Date.parse(next.expiresAt || "") <= now) {
      const { encryptedValue: _dropped, ...rest } = next;
      next = { ...rest, status: "expired", endedAt: new Date(now).toISOString() };
      expired.push(next);
    }
    if (next.status !== "active") {
      const { encryptedValue: _dropped, ...rest } = next;
      next = rest;
      const ended = Date.parse(next.endedAt || next.expiresAt || "");
      if (Number.isFinite(ended) && ended + terminalRetentionMs <= now) continue;
    }
    kept.push(next);
  }
  return { links: kept, expired };
}

async function readState(env) {
  const raw = await readJson(storePath(env), { schemaVersion: 1, links: [] });
  return Array.isArray(raw?.links) ? raw.links : [];
}

/**
 * Runs `operation(links, { expired })` under the in-process + file lock for the
 * link store, then durably writes the (swept) list before resolving. The
 * operation mutates the array in place or returns `{ links }` to replace it.
 */
export async function mutateSecretLinks(env, operation) {
  await ensureDataDirs(env);
  const filePath = storePath(env);
  return withStorageFileLock(filePath, async () => {
    const now = Date.now();
    const swept = sweep(await readState(env), now);
    const links = swept.links;
    const result = await operation(links, { expired: swept.expired, now });
    await writeSecretJson(filePath, { schemaVersion: 1, links, updatedAt: new Date().toISOString() });
    return { result, expired: swept.expired };
  });
}

export function findSecretLinkByToken(links = [], token = "") {
  if (!plausibleSecretLinkToken(token)) return null;
  const hash = secretLinkTokenHash(token);
  return links.find((link) => link.tokenHash === hash) || null;
}

export function publicSecretLink(link = {}) {
  return {
    id: clean(link.id),
    kind: link.kind === "request" ? "request" : "share",
    status: secretLinkActive(link) ? "active" : clean(link.status) === "active" ? "expired" : clean(link.status),
    ownerUserId: normalizeUserId(link.ownerUserId),
    name: clean(link.name) || null,
    handle: clean(link.handle) || null,
    label: clean(link.label) || null,
    threadId: clean(link.threadId) || null,
    createdBy: clean(link.createdBy) || null,
    createdAt: clean(link.createdAt) || null,
    expiresAt: clean(link.expiresAt) || null,
    endedAt: clean(link.endedAt) || null,
  };
}
