import { vaultError } from "./vault-access.js";
import { nowIso } from "./vault-store.js";

// Use accounting for vault values that leave the vault without the caller
// seeing them (desktop fill). Call inside the same mutateVault write that
// opens the record, so two concurrent uses cannot both pass the check.
//
// Single-use items (`singleUse: true`) are used up by their first use. The
// single-use entry feature owns that flag; it can replace this function with
// its own consume helper without touching the fill code.
export function claimItemUse(record = {}, via = "", nowMs = Date.now()) {
  if (record.singleUse === true) {
    if (record.usedAt) throw vaultError("vault_item_used", 410);
    record.usedAt = nowIso(nowMs);
    record.usedVia = String(via || "").slice(0, 40);
  }
  record.lastUsedAt = nowIso(nowMs);
}
