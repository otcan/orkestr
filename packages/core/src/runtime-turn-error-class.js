// Provider-neutral classification of failed runtime turns.
//
// Classes:
//   auth       credentials rejected or login required; retry after re-auth
//   rate_limit 429 / quota / usage limit; retry after a backoff
//   transient  network, transport, 5xx, overload, timeouts; retry soon
//   permanent  invalid request, context too long, anything unknown; no retry
//
// Every classification is { class, code, retryable, retryAfterMs, hint } and is
// safe to persist: it carries no raw provider text.

export const TURN_ERROR_CLASSES = Object.freeze(["auth", "rate_limit", "transient", "permanent"]);

const DEFAULT_RETRY_AFTER_MS = Object.freeze({
  auth: null,
  rate_limit: 60_000,
  transient: 5_000,
  permanent: null,
});

const HINTS = Object.freeze({
  auth: "re-authenticate the provider account, then retry",
  rate_limit: "provider rate limit or quota reached; retry after the backoff",
  transient: "temporary provider or network failure; safe to retry",
  permanent: "the request cannot succeed as sent; change the input before retrying",
});

// Transport-level failures of the local JSON-RPC/stdio channel. Callers use
// this to decide whether a submission outcome is uncertain.
const TRANSPORT_PATTERN = /timeout|timed out|closed|disconnect|socket|ECONN|transport|EOF/i;

const RULES = [
  ["permanent", "context_length_exceeded", /context[_ ]length[_ ]exceeded|context window|maximum context length|prompt is too long|too many tokens|input is too long/i],
  ["rate_limit", "rate_limited", /\b429\b|too many requests|rate[_ ]?limit/i],
  ["rate_limit", "quota_exceeded", /quota|usage limit|insufficient_quota|billing|credit balance/i],
  ["transient", "model_capacity", /selected model is at capacity|model\s+.+\s+at capacity|server is overloaded|overloaded_error|temporarily unavailable due to (?:high )?demand/i],
  ["transient", "server_error", /\b(?:status|http|code|error)\s*:?\s*5\d\d\b|\b5\d\d\s+(?:internal|bad gateway|service|gateway)|internal server error|bad gateway|service unavailable|gateway timeout|server_error/i],
  ["transient", "network", /stream disconnected|connection (?:reset|refused|closed)|network error|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i],
  ["transient", "timeout", /timed? ?out|deadline exceeded/i],
  ["transient", "transport", TRANSPORT_PATTERN],
  ["permanent", "invalid_request", /invalid_request|invalid request|bad request|\b(?:status|http|code|error)\s*:?\s*40[04]\b|malformed|unsupported|not supported/i],
];

const clean = (value) => String(value ?? "").trim();

export function isTransportErrorText(value = "") {
  return TRANSPORT_PATTERN.test(clean(value));
}

function parseRetryAfterMs(text = "") {
  const match = /(?:retry[- ]after|try again in|retry in)\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit.startsWith("ms") || unit.startsWith("milli")) return Math.round(value);
  if (unit.startsWith("m")) return Math.round(value * 60_000);
  return Math.round(value * 1000);
}

export function turnErrorClassification(errorClass, code = "", { retryAfterMs = null } = {}) {
  const normalizedClass = TURN_ERROR_CLASSES.includes(errorClass) ? errorClass : "permanent";
  const retryable = normalizedClass === "rate_limit" || normalizedClass === "transient";
  return {
    class: normalizedClass,
    code: clean(code) || normalizedClass,
    retryable,
    retryAfterMs: retryable ? retryAfterMs ?? DEFAULT_RETRY_AFTER_MS[normalizedClass] : null,
    hint: HINTS[normalizedClass],
  };
}

// Classifies redacted Codex turn error text. `authReason` is the result of the
// existing auth classifier (codexTurnAuthFailureReason) so auth detection stays
// in one place.
export function classifyCodexTurnError(errorText = "", { authReason = "" } = {}) {
  const text = clean(errorText);
  if (clean(authReason)) return turnErrorClassification("auth", clean(authReason));
  for (const [errorClass, code, pattern] of RULES) {
    if (pattern.test(text)) return turnErrorClassification(errorClass, code, { retryAfterMs: parseRetryAfterMs(text) });
  }
  return turnErrorClassification("permanent", text ? "unknown" : "empty_error");
}

// Claude Code failures are already low-cardinality codes from the adapter.
const CLAUDE_CODE_CLASS_BY_CODE = Object.freeze({
  claude_code_auth_required: "auth",
  llm_account_profile_login_required: "auth",
  claude_code_rate_limited: "rate_limit",
  claude_code_timeout: "transient",
});

export function classifyClaudeCodeFailureCode(code = "") {
  const normalized = clean(code);
  return turnErrorClassification(CLAUDE_CODE_CLASS_BY_CODE[normalized] || "permanent", normalized || "claude_code_failed");
}

// The conformance contract (docs/spec/conformance.md) has three classes;
// rate_limit is a retryable transient failure there.
export function conformanceErrorClass(errorClass = "") {
  return errorClass === "rate_limit" ? "transient" : errorClass || "permanent";
}
