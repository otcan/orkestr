// HMAC-SHA256 verification for incoming Agent Job webhooks.
//
// Two header styles are accepted:
// * Orkestr: `X-Orkestr-Timestamp: <unix seconds>` and
//   `X-Orkestr-Signature-256: sha256=<hex>` over `<timestamp>.<raw body>`.
//   The timestamp must be inside the replay window (default 300 s,
//   ORKESTR_AGENT_JOB_WEBHOOK_TOLERANCE_S).
// * GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. GitHub
//   signs no timestamp; set ORKESTR_AGENT_JOB_WEBHOOK_REQUIRE_TIMESTAMP=1 to
//   refuse it. Replays of a valid request can never start a second run
//   because the hook endpoint derives the dedupe key from the signed body only.
// Comparison is constant time. Neither the secret nor the expected digest is
// ever returned or logged.
import crypto from "node:crypto";

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;

function header(headers = {}, name) {
  const lower = name.toLowerCase();
  const value = headers[lower] ?? headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

export function agentJobWebhookToleranceMs(env = process.env) {
  const seconds = Number(env.ORKESTR_AGENT_JOB_WEBHOOK_TOLERANCE_S || 300);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : 300_000;
}

export function signAgentJobWebhook(secret, rawBody, timestamp = null) {
  const hmac = crypto.createHmac("sha256", String(secret));
  if (timestamp !== null && timestamp !== undefined) hmac.update(`${timestamp}.`);
  hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8"));
  return `sha256=${hmac.digest("hex")}`;
}

function constantTimeEqual(a, b) {
  // Hash both sides so lengths match and timingSafeEqual cannot throw.
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right) && String(a).length === String(b).length;
}

/**
 * @returns {{ ok: true, style: "orkestr" | "github" } | { ok: false, reason: string }}
 */
export function verifyAgentJobWebhookSignature({ secret, rawBody, headers = {}, now = Date.now() }, env = process.env) {
  if (!secret) return { ok: false, reason: "webhook_secret_unavailable" };
  if (rawBody === undefined || rawBody === null) return { ok: false, reason: "webhook_raw_body_unavailable" };
  const orkestrSignature = header(headers, "X-Orkestr-Signature-256");
  const githubSignature = header(headers, "X-Hub-Signature-256");
  if (orkestrSignature) {
    const timestamp = header(headers, "X-Orkestr-Timestamp");
    if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "webhook_timestamp_missing" };
    if (Math.abs(now - Number(timestamp) * 1000) > agentJobWebhookToleranceMs(env)) return { ok: false, reason: "webhook_timestamp_outside_window" };
    if (!SIGNATURE_RE.test(orkestrSignature)) return { ok: false, reason: "webhook_signature_malformed" };
    const expected = signAgentJobWebhook(secret, rawBody, timestamp);
    return constantTimeEqual(orkestrSignature.toLowerCase(), expected) ? { ok: true, style: "orkestr" } : { ok: false, reason: "webhook_signature_mismatch" };
  }
  if (githubSignature) {
    if (String(env.ORKESTR_AGENT_JOB_WEBHOOK_REQUIRE_TIMESTAMP || "") === "1") return { ok: false, reason: "webhook_timestamp_missing" };
    if (!SIGNATURE_RE.test(githubSignature)) return { ok: false, reason: "webhook_signature_malformed" };
    const expected = signAgentJobWebhook(secret, rawBody);
    return constantTimeEqual(githubSignature.toLowerCase(), expected) ? { ok: true, style: "github" } : { ok: false, reason: "webhook_signature_mismatch" };
  }
  return { ok: false, reason: "webhook_signature_missing" };
}
