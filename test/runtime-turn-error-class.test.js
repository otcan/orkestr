import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyClaudeCodeFailureCode,
  classifyCodexTurnError,
  conformanceErrorClass,
  isTransportErrorText,
} from "../packages/core/src/runtime-turn-error-class.js";

test("codex turn errors are classified with retry hints", () => {
  const cases = [
    ["stream disconnected before completion: 429 Too Many Requests", "rate_limit", "rate_limited"],
    ["You've hit your usage limit. Try again in 30 seconds", "rate_limit", "quota_exceeded"],
    ["The selected model is at capacity. Please try a different model.", "transient", "model_capacity"],
    ["unexpected status 503 Service Unavailable", "transient", "server_error"],
    ["stream disconnected before completion: connection reset", "transient", "network"],
    ["request timed out", "transient", "timeout"],
    ["invalid_request_error: the request body is malformed", "permanent", "invalid_request"],
    ["context_length_exceeded: input exceeds the context window", "permanent", "context_length_exceeded"],
    ["something nobody anticipated", "permanent", "unknown"],
  ];
  for (const [text, errorClass, code] of cases) {
    const classified = classifyCodexTurnError(text);
    assert.equal(classified.class, errorClass, text);
    assert.equal(classified.code, code, text);
    assert.equal(classified.retryable, errorClass !== "permanent", text);
    assert.equal(typeof classified.hint, "string");
  }
});

test("codex auth reason wins and retry-after is parsed", () => {
  const auth = classifyCodexTurnError("unexpected status 401 Unauthorized", { authReason: "provider_auth_rejected" });
  assert.deepEqual([auth.class, auth.code, auth.retryable, auth.retryAfterMs], ["auth", "provider_auth_rejected", false, null]);
  assert.equal(classifyCodexTurnError("429 rate limit, retry after 12s").retryAfterMs, 12_000);
  assert.equal(classifyCodexTurnError("usage limit reached, try again in 2 minutes").retryAfterMs, 120_000);
  assert.equal(classifyCodexTurnError("429 Too Many Requests").retryAfterMs, 60_000);
  assert.equal(classifyCodexTurnError("invalid request").retryAfterMs, null);
});

test("claude code failure codes map to classes", () => {
  assert.equal(classifyClaudeCodeFailureCode("claude_code_auth_required").class, "auth");
  assert.equal(classifyClaudeCodeFailureCode("claude_code_rate_limited").class, "rate_limit");
  assert.equal(classifyClaudeCodeFailureCode("claude_code_timeout").class, "transient");
  assert.equal(classifyClaudeCodeFailureCode("claude_code_failed").class, "permanent");
  assert.equal(conformanceErrorClass("rate_limit"), "transient");
  assert.equal(conformanceErrorClass("auth"), "auth");
});

test("transport errors are recognised for acceptance-uncertain retries", () => {
  assert.equal(isTransportErrorText("codex app-server socket closed"), true);
  assert.equal(isTransportErrorText("read ECONNRESET"), true);
  assert.equal(isTransportErrorText("invalid_request_error"), false);
});
