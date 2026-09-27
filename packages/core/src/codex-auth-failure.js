// Classification and redaction for Codex provider auth rejections reported on
// the app-server turn-failure channel. Keep this module dependency-free so the
// auth-health tracker and the app-server client can both import it.

export const codexProviderAuthRejectedReason = "codex_provider_auth_rejected";
export const redactedApiKeyPlaceholder = "[redacted-api-key]";

function clean(value) {
  return String(value || "").trim();
}

// Matches OpenAI-style secret keys, including provider-masked forms such as
// `sk-abc***...***`. The replacement intentionally drops the `sk-` prefix so no
// key fragment survives in stored summaries.
const apiKeyPattern = /\bsk-[A-Za-z0-9_*.…-]{3,}/g;

export function redactCodexSecrets(value = "") {
  const text = String(value ?? "");
  if (!text) return text;
  return text.replace(apiKeyPattern, (match) => {
    const trailing = match.match(/\.+$/)?.[0] || "";
    return `${redactedApiKeyPlaceholder}${trailing}`;
  });
}

const codexResponsesEndpointPattern = /\/backend-api\/codex\/responses\b|\/v1\/responses\b/i;

// Returns a reason code when the provider rejected Codex credentials. Only call
// this with text from the runtime's turn-failure/error channel, never with
// arbitrary tool or pane output: generic 401 text is only trusted when it is
// tied to the Codex responses endpoint.
export function codexProviderAuthRejectionReason(value = "") {
  const text = clean(value);
  if (!text) return "";
  if (/incorrect api key provided/i.test(text)) return codexProviderAuthRejectedReason;
  if (/\binvalid_api_key\b/i.test(text)) return codexProviderAuthRejectedReason;
  const unauthorized = /\b401\b[\s:]*unauthorized\b|unexpected status 401\b/i.test(text);
  if (unauthorized && codexResponsesEndpointPattern.test(text)) return codexProviderAuthRejectedReason;
  return "";
}
