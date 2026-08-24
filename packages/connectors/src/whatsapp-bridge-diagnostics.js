import crypto from "node:crypto";

const DEFAULT_EXCERPT_LIMIT = 240;
const MAX_EXCERPT_LIMIT = 512;
const MAX_STRUCTURED_KEYS = 24;
const MAX_STRUCTURED_ITEMS = 10;
const sensitiveKeyPattern = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|payload|attachments?|phone|recipient|chat(?:id)?|sender|from|to|text|body)/i;

function clean(value = "") {
  return String(value || "").trim();
}

function boundedIdentifier(value = "") {
  const text = clean(value);
  return /^[A-Za-z0-9._:-]{1,160}$/.test(text) ? text : "";
}

function responseHeader(response, name) {
  try {
    return clean(response?.headers?.get?.(name));
  } catch {
    return "";
  }
}

function redactKnownValues(value = "", sensitiveValues = []) {
  let output = String(value || "");
  for (const item of Array.isArray(sensitiveValues) ? sensitiveValues : []) {
    const sensitive = clean(item);
    if (sensitive.length < 3) continue;
    output = output.split(sensitive).join("[redacted]");
  }
  return output;
}

function redactDiagnosticText(value = "", sensitiveValues = []) {
  return clean(redactKnownValues(value, sensitiveValues))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " [redacted-script] ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|authorization|cookie|password|secret|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:authorization|cookie|credential|password|secret|token|api[_-]?key|payload|attachments?|phone|recipient|chat(?:id)?|sender|from|to|text|body)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, "$1\"[redacted]\"")
    .replace(/((?:authorization|cookie|credential|password|secret|token|api[_-]?key)\s*[:=]\s*)[^,;\s}]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^/\s]+/gi, "[redacted-origin]")
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)(?:@(c\.us|lid|g\.us))?\b/gi, "[redacted-identity]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\/(?:root|home|opt|etc|var)\/[^\s"'<>]+/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeStructuredValue(value, depth = 0, sensitiveValues = []) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactDiagnosticText(value, sensitiveValues).slice(0, 240);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STRUCTURED_ITEMS).map((item) => sanitizeStructuredValue(item, depth + 1, sensitiveValues));
  }
  if (!value || typeof value !== "object") return clean(value).slice(0, 120);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_STRUCTURED_KEYS)) {
    const name = clean(key).slice(0, 80);
    if (!name) continue;
    output[name] = sensitiveKeyPattern.test(name) ? "[redacted]" : sanitizeStructuredValue(item, depth + 1, sensitiveValues);
  }
  return output;
}

export function whatsappBridgeDiagnosticExcerptLimit(value = DEFAULT_EXCERPT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EXCERPT_LIMIT;
  return Math.max(64, Math.min(MAX_EXCERPT_LIMIT, Math.floor(parsed)));
}

export function sanitizeWhatsAppBridgePayload(payload = {}, { sensitiveValues = [] } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return sanitizeStructuredValue(payload, 0, sensitiveValues);
}

export function sanitizeWhatsAppBridgeResponseExcerpt(rawText = "", payload = null, limit = DEFAULT_EXCERPT_LIMIT, sensitiveValues = []) {
  const max = whatsappBridgeDiagnosticExcerptLimit(limit);
  const structured = payload && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length
    ? JSON.stringify(sanitizeWhatsAppBridgePayload(payload, { sensitiveValues }))
    : "";
  const text = redactDiagnosticText(structured || rawText, sensitiveValues);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function classifyWhatsAppBridgeFailure({ status = 0, payload = {}, excerpt = "" } = {}) {
  const code = clean(
    payload?.error?.code ||
      payload?.errorCode ||
      payload?.code ||
      (typeof payload?.error === "string" ? payload.error : "") ||
      (typeof payload?.reason === "string" ? payload.reason : ""),
  );
  if (Number(status) === 401) {
    return { failureCode: code || "whatsapp_bridge_authentication_failed", classification: "authentication", retryable: false };
  }
  if (Number(status) === 403) {
    return { failureCode: code || "whatsapp_bridge_authorization_failed", classification: "authorization", retryable: false };
  }
  if (Number(status) === 404) {
    return { failureCode: "whatsapp_bridge_route_not_found", classification: "route_configuration", retryable: false };
  }
  if ([408, 425, 429].includes(Number(status))) {
    return { failureCode: code || `whatsapp_bridge_transient_${status}`, classification: "transient", retryable: true };
  }
  if (Number(status) >= 500) {
    return { failureCode: code || `whatsapp_bridge_upstream_${status}`, classification: "upstream_transient", retryable: true };
  }
  if (Number(status) >= 400) {
    return { failureCode: code || `whatsapp_bridge_request_${status}`, classification: "request", retryable: false };
  }
  const logicalRetryable = payload?.retryable !== false;
  return {
    failureCode: code || (excerpt ? "whatsapp_bridge_application_failed" : "whatsapp_send_failed"),
    classification: "bridge_application",
    retryable: logicalRetryable,
  };
}

export function newWhatsAppBridgeRequestId(value = "") {
  return boundedIdentifier(value) || `wa_${crypto.randomUUID()}`;
}

export async function readWhatsAppBridgeResponse(response, {
  requestId = "",
  correlationId = "",
  upstreamPath = "",
  excerptLimit = DEFAULT_EXCERPT_LIMIT,
  sensitiveValues = [],
} = {}) {
  let rawText = "";
  let payload = {};
  if (typeof response?.text === "function") {
    rawText = await response.text();
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = {};
      }
    }
  } else if (typeof response?.json === "function") {
    // Compatibility for injected test doubles. Real fetch responses always use
    // the text-once path above so opaque bodies cannot be discarded.
    payload = await response.json().catch(() => ({}));
    rawText = payload && Object.keys(payload).length ? JSON.stringify(payload) : "";
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  const safePayload = sanitizeWhatsAppBridgePayload(payload, { sensitiveValues });
  const contentType = responseHeader(response, "content-type").slice(0, 160);
  const bridgeRequestId = boundedIdentifier(
    responseHeader(response, "x-orkestr-bridge-request-id") ||
      responseHeader(response, "x-request-id") ||
      requestId,
  );
  const responseCorrelationId = boundedIdentifier(responseHeader(response, "x-correlation-id") || correlationId);
  const upstreamRequestId = boundedIdentifier(
    responseHeader(response, "x-orkestr-upstream-request-id") ||
      responseHeader(response, "x-amzn-requestid") ||
      responseHeader(response, "x-amz-cf-id"),
  );
  const responseExcerpt = sanitizeWhatsAppBridgeResponseExcerpt(rawText, payload, excerptLimit, sensitiveValues);
  const classification = classifyWhatsAppBridgeFailure({ status: Number(response?.status || 0), payload: safePayload, excerpt: responseExcerpt });
  const diagnostics = {
    status: Number(response?.status || 0),
    statusText: clean(response?.statusText).slice(0, 80),
    contentType,
    upstreamPath: clean(upstreamPath).slice(0, 200),
    requestId: bridgeRequestId,
    correlationId: responseCorrelationId,
    upstreamRequestId,
    bodyFingerprint: rawText ? crypto.createHash("sha256").update(rawText).digest("hex") : "",
    responseBytes: Buffer.byteLength(rawText),
    responseExcerpt,
    ...classification,
  };
  return { payload, safePayload, diagnostics };
}
