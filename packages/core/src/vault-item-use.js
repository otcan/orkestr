import { appendEvent } from "../../storage/src/store.js";
import { vaultError } from "./vault-access.js";
import { singleUseStatus, wipeSingleUse } from "./vault-single-use.js";
import { mutateVault, nowIso } from "./vault-store.js";

// Use accounting for vault values that leave the vault without the caller
// seeing them (desktop fill). Single-use items use vault-single-use: only a
// successful use releases (wipes) them; a refused or failed use consumes
// nothing. While a use is in flight the item is reserved in this process, so
// a concurrent fill or `vault exec` cannot release it a second time.

const inFlight = new Set();

function key(ownerUserId, itemId) {
  return `${ownerUserId}:${itemId}`;
}

/** Throws while another release of this single-use item is in flight. */
export function assertItemNotInUse(ownerUserId, record = {}) {
  if (singleUseStatus(record) === "active" && inFlight.has(key(ownerUserId, record.id))) throw vaultError("vault_item_in_use", 409);
}

/**
 * Call inside the mutateVault write that opened the record. Returns a claim
 * for finishItemUse; single-use items are reserved, not yet consumed.
 */
export function claimItemUse(ownerUserId, record = {}, nowMs = Date.now()) {
  record.lastUsedAt = nowIso(nowMs);
  if (singleUseStatus(record, nowMs) !== "active") return null;
  assertItemNotInUse(ownerUserId, record);
  const claim = key(ownerUserId, record.id);
  inFlight.add(claim);
  return { ownerUserId, itemId: record.id, claim };
}

/** Consumes the single-use item when `ok`, then drops the reservation. */
export async function finishItemUse(claim, ok, extra = {}, env = process.env) {
  if (!claim) return false;
  try {
    if (!ok) return false;
    const consumed = await mutateVault(claim.ownerUserId, (store) => {
      const record = store.items.find((item) => item.id === claim.itemId);
      if (!record?.secret) return false;
      store.items[store.items.indexOf(record)] = wipeSingleUse(record, "used", Date.now(), extra);
      return true;
    }, env);
    if (consumed) await appendEvent({ type: "vault_single_use_consumed", ownerUserId: claim.ownerUserId, itemId: claim.itemId, ...extra }, env).catch(() => {});
    return consumed;
  } finally {
    inFlight.delete(claim.claim);
  }
}
