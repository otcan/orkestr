// Per-account suspension of WhatsApp typing-indicator clears.
//
// Clearing typing is cosmetic: once the refresh loop stops, WhatsApp expires
// the composing state on its own, and any outbound message replaces it. When
// WhatsApp Web rejects the clear with its minified bare `r` error, the same
// call fails deterministically on every retry and every later stop, which
// only produced a stream of *_clear_failed / *_clear_retry_failed events.
// After such a failure the account skips clears (and their retries) for a
// cooldown, then tries once more; a success or a runtime reset lifts it.
const DEFAULT_SUSPEND_MS = 10 * 60 * 1000;

const suspensions = new Map();

export function typingClearSuspendMs(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_TYPING_CLEAR_SUSPEND_MS ?? "").trim();
  if (!raw) return DEFAULT_SUSPEND_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 6 * 60 * 60 * 1000) : DEFAULT_SUSPEND_MS;
}

export function typingClearSuspended(accountId = "", now = Date.now()) {
  const entry = suspensions.get(String(accountId || ""));
  return Boolean(entry && entry.untilMs > now);
}

// Records a deterministic clear failure. Returns the suspension when this
// failure starts a new one (so the caller emits a single event), else null.
export function suspendTypingClear(accountId = "", env = process.env, now = Date.now()) {
  const key = String(accountId || "");
  const durationMs = typingClearSuspendMs(env);
  if (!key || !durationMs) return null;
  const previous = suspensions.get(key);
  const entry = { untilMs: now + durationMs, durationMs, failures: Number(previous?.failures || 0) + 1 };
  suspensions.set(key, entry);
  return previous && previous.untilMs > now ? null : entry;
}

export function resetTypingClearSuspension(accountId = "") {
  if (accountId) suspensions.delete(String(accountId));
  else suspensions.clear();
}
