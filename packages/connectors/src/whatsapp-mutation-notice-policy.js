// Rules for WhatsApp edit/delete correction notices.
//
// A notice is text-only ("Correction to my previous message: ..."), so it must
// not inherit the source message's attachment snapshot obligations; doing so
// failed every notice for a reply with a staged attachment
// (outbound_attachment_snapshot_not_sendable), retried until suppressed.
//
// A notice is only due when the visible text changed. The delivery ledger
// stores the *prepared* text (attachment notices and notes appended, tables
// moved to files), so comparing it with the raw edited text flagged
// attachment-only edits, such as publishing an encrypted copy, as text edits.
// Deliveries now record a hash of the source text they were prepared from.
import { createHash } from "node:crypto";

const TEXT_ONLY_DELIVERY_TYPES = new Set(["edit_notice", "delete_notice"]);

export function deliveryTypeCarriesSourceAttachments(deliveryType = "") {
  return !TEXT_ONLY_DELIVERY_TYPES.has(String(deliveryType || "").trim().toLowerCase());
}

export function whatsappSourceTextHash(text) {
  return createHash("sha256").update(String(text ?? "").trim()).digest("hex").slice(0, 32);
}

// true: the source text is unchanged since that delivery (no notice due).
// false: it changed. null: unknown (legacy delivery without a hash).
export function sourceTextUnchangedSinceDelivery(delivery = null, message = {}) {
  const recorded = String(delivery?.sourceTextHash || "").trim();
  if (!recorded) return null;
  return recorded === whatsappSourceTextHash(message?.text);
}

// Legacy fallback for deliveries without a source hash: preparation appends
// notes as separate lines after the visible body, so an unchanged body is a
// line-aligned prefix of the delivered text.
export function deliveredTextStillCoversCurrent(deliveredText = "", currentText = "") {
  if (!deliveredText || !currentText) return false;
  return deliveredText === currentText || deliveredText.startsWith(`${currentText}\n`);
}
