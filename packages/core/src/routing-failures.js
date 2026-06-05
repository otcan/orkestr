function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function inferredCode(message = "") {
  const text = lower(message);
  if (text.includes("target_instance_unhealthy")) return "target_instance_unhealthy";
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
  if (text.includes("sanitizer")) return "sanitizer";
  if (text.includes("timer")) return "timer";
  if (text.includes("whatsapp_inbound_token") || text.includes("whatsapp_bridge_token")) return "connector";
  if (text.includes("gmail") || text.includes("outlook") || text.includes("connector")) return "connector";
  if (text.includes("desktop") || text.includes("linkedin")) return "desktop";
  if (text.includes("browser_pairing_required")) return "auth";
  return "routing";
}

export function normalizeRoutingFailure(input = {}, fallback = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const message = clean(source.reason || source.message || fallback.reason || fallback.message || fallback.error);
  const code = clean(source.code || fallback.code) || inferredCode(message);
  const capability = clean(source.capability || fallback.capability) || inferredCapability(message, code);
  const provider = clean(source.provider || fallback.provider);
  const retryable = boolOrNull(source.retryable);
  return {
    code,
    capability,
    provider,
    instanceId: clean(source.instanceId || fallback.instanceId),
    threadId: clean(source.threadId || fallback.threadId),
    target: clean(source.target || fallback.target),
    retryable: retryable === null ? Boolean(fallback.retryable) : retryable,
    userFacingCategory: clean(source.userFacingCategory || fallback.userFacingCategory) || inferredCategory(message, code),
    safeMessage: clean(source.safeMessage || fallback.safeMessage),
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
