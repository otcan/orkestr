// Error details that are safe to persist in diagnostics. Only values from the
// explicit allowlists below are ever emitted: a known error class, a known
// code, and an opaque id that can be handed to the client for correlation.
// Nothing is copied from error messages, codes or names that are not on a
// list, whatever their syntax; unknown values become "Error" / null.
import { randomBytes } from "node:crypto";

const KNOWN_CLASSES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError"]);

const KNOWN_CODES = new Set([
  // Node network and system errors.
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "EADDRNOTAVAIL", "ERR_SOCKET_CONNECTION_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ABORT_ERR",
  // SQLite contention.
  "SQLITE_BUSY", "SQLITE_LOCKED",
  // Thread bridge and outbound fetch codes (thread-bridge*.js, safe-public-fetch.js).
  "thread_bridge_disabled", "bridge_authentication_required", "bridge_owner_inactive", "bridge_requires_sqlite",
  "bridge_grant_revoked", "bridge_thread_not_found", "bridge_cursor_reset_required", "bridge_limit_invalid",
  "bridge_history_reset_required", "bridge_reply_invalid", "bridge_cause_invalid", "bridge_idempotency_conflict",
  "bridge_message_invalid", "bridge_message_rate_limited", "bridge_message_not_found", "insufficient_scope",
  "url_invalid", "url_must_be_public_https", "url_address_not_public", "request_timeout", "response_too_large",
]);

function knownCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    if ((typeof candidate === "string" || typeof candidate === "number") && KNOWN_CODES.has(String(candidate))) return String(candidate);
  }
  return null;
}

export function safeErrorDiagnostics(error) {
  const errorClass = typeof error?.name === "string" && KNOWN_CLASSES.has(error.name) ? error.name : "Error";
  return { errorClass, errorCode: knownCode(error), errorId: `err_${randomBytes(8).toString("hex")}` };
}
