// Single-use vault items (docs/vault.md, "Single-use items"). A single-use
// item releases its username/password to an agent at most once, and only
// until it expires. Releasing or expiring it removes the encrypted envelope;
// the metadata stays as an audit record with status "used" or "expired".
// Self-contained (no vault-store import) so the store can sweep with it.

import { parseSecretLinkTtl } from "./secret-links-store.js";

function clean(value) {
  return String(value ?? "").trim();
}

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

/** null for normal items, else "active" | "used" | "expired". */
export function singleUseStatus(record = {}, nowMs = Date.now()) {
  if (record?.singleUse !== true) return null;
  const status = clean(record.singleUseStatus) || "active";
  if (status === "active" && !(Date.parse(record.singleUseExpiresAt || "") > nowMs)) return "expired";
  return status;
}

export function singleUseSpent(record = {}, nowMs = Date.now()) {
  const status = singleUseStatus(record, nowMs);
  return status !== null && status !== "active";
}

/** Marks new item metadata as single-use, valid for `ttlMs`. */
export function markSingleUse(meta = {}, ttlMs, nowMs = Date.now()) {
  return { ...meta, singleUse: true, singleUseStatus: "active", singleUseExpiresAt: iso(nowMs + ttlMs) };
}

/**
 * Applies `{ singleUse: true, ttl? }` from an owner create body. TTL uses the
 * secret-link format (default 15m, 1m..24h). Single-use items hold a
 * username/password only.
 */
export function singleUseFromBody(meta, payload = {}, body = {}, nowMs = Date.now()) {
  if (body?.singleUse !== true) return meta;
  if (payload.totp) throw Object.assign(new Error("vault_single_use_totp_unsupported"), { statusCode: 400, code: "vault_single_use_totp_unsupported" });
  return markSingleUse(meta, parseSecretLinkTtl(typeof body.ttl === "string" ? body.ttl : ""), nowMs);
}

/** Drops the ciphertext and keeps value-free metadata for audit. */
export function wipeSingleUse(record = {}, status, nowMs = Date.now(), extra = {}) {
  const { secret: _dropped, ...rest } = record;
  return { ...rest, hasPassword: false, hasTotp: false, totpType: null, singleUseStatus: status, singleUseEndedAt: iso(nowMs), ...extra };
}

export function needsSingleUseSweep(record = {}, nowMs = Date.now()) {
  return Boolean(record?.secret) && singleUseSpent(record, nowMs);
}

/** Wipes spent single-use items in place. Returns the ids that were wiped. */
export function sweepSingleUseItems(store, nowMs = Date.now()) {
  const wiped = [];
  store.items = store.items.map((record) => {
    if (!needsSingleUseSweep(record, nowMs)) return record;
    wiped.push(record.id);
    return wipeSingleUse(record, singleUseStatus(record, nowMs), nowMs);
  });
  return wiped;
}

/** Value-free metadata for list views; empty for normal items. */
export function singleUseMeta(record = {}, nowMs = Date.now()) {
  const status = singleUseStatus(record, nowMs);
  if (!status) return {};
  return {
    singleUse: true,
    singleUseStatus: status,
    singleUseExpiresAt: record.singleUseExpiresAt || null,
    singleUseEndedAt: record.singleUseEndedAt || null,
  };
}
