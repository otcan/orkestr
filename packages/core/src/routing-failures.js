function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function redact(value = "", limit = 1000) {
  return clean(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|token|secret|password|api[_-]?key|cookie)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/\/(?:root|home|opt|etc|var)\/[^\s]+/g, "[redacted-path]")
    .slice(0, limit);
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function inferredCode(message = "") {
  const text = lower(message);
  if (text.includes("wa_token_scope_denied") || text.includes("token_scope_denied") || text.includes("scope denied")) return "wa_token_scope_denied";
  if (text.includes("wa_acl_denied") || text.includes("acl denied")) return "wa_acl_denied";
  if (text.includes("wa_owner_mismatch") || text.includes("owner mismatch")) return "wa_owner_mismatch";
  if (text.includes("wa_binding_ambiguous") || text.includes("binding ambiguous")) return "wa_binding_ambiguous";
  if (text.includes("wa_binding_missing") || text.includes("binding missing")) return "wa_binding_missing";
  if (text.includes("whatsapp_pairing_required") || text.includes("pairing missing") || text.includes("qr required")) return "whatsapp_pairing_required";
  if (text.includes("whatsapp_comms_not_ready") || text.includes("comms not ready")) return "whatsapp_comms_not_ready";
  if (text.includes("whatsapp_account_unreachable") || text.includes("account unreachable")) return "whatsapp_account_unreachable";
  if (text.includes("whatsapp_mirror_failed") || text.includes("mirror failure") || text.includes("mirror failed")) return "whatsapp_mirror_failed";
  if (text.includes("target_instance_unhealthy")) return "target_instance_unhealthy";
  if (text.includes("codex")) return "codex_unavailable";
  if (text.includes("timer")) return "timer_unavailable";
  if (text.includes("gmail")) return "gmail_unavailable";
  if (text.includes("outlook")) return "outlook_unavailable";
  if (text.includes("linkedin") || text.includes("desktop")) return "desktop_unavailable";
  if (text.includes("browser_pairing_required")) return "browser_pairing_required";
  if (text.includes("capability")) return "capability_unavailable";
  if (text.includes("sanitizer")) return "sanitizer_denied";
  return "routing_failed";
}

function inferredCapability(message = "", code = "") {
  const text = lower(`${code} ${message}`);
  if (text.includes("wa_")) return "whatsapp";
  if (text.includes("codex")) return "codex";
  if (text.includes("timer")) return "timers";
  if (text.includes("gmail")) return "gmail";
  if (text.includes("outlook")) return "outlook";
  if (text.includes("linkedin") || text.includes("desktop")) return "linkedin";
  if (text.includes("whatsapp")) return "whatsapp";
  if (text.includes("file")) return "files";
  return "";
}

function inferredCategory(message = "", code = "") {
  const text = lower(`${code} ${message}`);
  if (text.includes("target_instance_unhealthy")) return "instance_health";
  if (text.includes("codex")) return "codex";
  if (text.includes("sanitizer")) return "sanitizer";
  if (text.includes("timer")) return "timer";
  if (text.includes("whatsapp") || text.includes("wa_")) return "connector";
  if (text.includes("gmail") || text.includes("outlook") || text.includes("connector")) return "connector";
  if (text.includes("desktop") || text.includes("linkedin")) return "desktop";
  if (text.includes("browser_pairing_required")) return "auth";
  return "routing";
}

function pickContext(source = {}, fallback = {}, key = "") {
  return clean(source[key] || fallback[key]);
}

export function normalizeRoutingFailure(input = {}, fallback = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const message = redact(source.reason || source.message || fallback.reason || fallback.message || fallback.error);
  const rawCode = clean(source.code || fallback.code);
  const code = rawCode && /^[a-z0-9_.:-]+$/i.test(rawCode) ? rawCode : inferredCode(rawCode || message);
  const capability = clean(source.capability || fallback.capability) || inferredCapability(message, code);
  const provider = clean(source.provider || fallback.provider);
  const retryable = boolOrNull(source.retryable);
  return {
    code,
    capability,
    provider,
    routerTraceId: pickContext(source, fallback, "routerTraceId"),
    accountId: pickContext(source, fallback, "accountId"),
    bindingId: pickContext(source, fallback, "bindingId"),
    instanceId: pickContext(source, fallback, "instanceId"),
    threadId: pickContext(source, fallback, "threadId"),
    chatId: pickContext(source, fallback, "chatId"),
    principalKind: pickContext(source, fallback, "principalKind"),
    principalId: pickContext(source, fallback, "principalId"),
    target: redact(source.target || fallback.target, 500),
    appUrl: redact(source.appUrl || fallback.appUrl, 800),
    setupUrl: redact(source.setupUrl || fallback.setupUrl, 800),
    retryable: retryable === null ? Boolean(fallback.retryable) : retryable,
    userFacingCategory: clean(source.userFacingCategory || fallback.userFacingCategory) || inferredCategory(message, code),
    safeMessage: redact(source.safeMessage || fallback.safeMessage, 1000),
    reason: message || code,
  };
}

export function routingFailureFromError(error, fallback = {}) {
  const payload = error?.payload && typeof error.payload === "object" ? error.payload : {};
  return normalizeRoutingFailure(error?.routingFailure || payload.routingFailure || payload.failure || {}, {
    ...fallback,
    code: fallback.code || clean(payload.error || error?.message || error),
    reason: fallback.reason || clean(error?.message || error),
  });
}

export function attachRoutingFailure(error, failure = {}) {
  const target = error instanceof Error ? error : new Error(clean(error) || clean(failure.code) || "routing_failed");
  target.routingFailure = normalizeRoutingFailure(failure, {
    code: clean(target.message) || "routing_failed",
  });
  return target;
}

export function publicRoutingFailurePayload(error, fallback = {}) {
  const failure = routingFailureFromError(error, fallback);
  return {
    ok: false,
    error: failure.code,
    routingFailure: failure,
  };
}
