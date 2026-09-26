import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexProviderAuthRejectedReason,
  codexProviderAuthRejectionReason,
  redactCodexSecrets,
} from "../packages/core/src/codex-auth-failure.js";
import {
  codexRuntimeAuthInvalidReason,
  codexTurnAuthFailureReason,
  readCodexAuthHealth,
  recordCodexRuntimeAuthFailureSignal,
} from "../packages/core/src/codex-auth-health.js";
import { paneProgressFromText } from "../packages/core/src/pane-progress.js";
import { appServerStateFromStatus } from "../packages/core/src/codex-app-server-common.js";

const providerRejection = [
  "unexpected status 401 Unauthorized: Incorrect API key provided: sk-test***…***REDACTED.",
  "You can find your API key at https://platform.example.test/account/api-keys.,",
  "url: https://chatgpt.com/backend-api/codex/responses, cf-ray: test-ray, request id: req-test",
].join(" ");

test("provider 401 invalid API key rejections classify as Codex auth faults", () => {
  assert.equal(codexProviderAuthRejectionReason(providerRejection), codexProviderAuthRejectedReason);
  assert.equal(codexTurnAuthFailureReason(providerRejection), "codex_provider_auth_rejected");
  assert.equal(codexTurnAuthFailureReason('{"error":{"code":"invalid_api_key"}}'), "codex_provider_auth_rejected");
  assert.equal(
    codexTurnAuthFailureReason("unexpected status 401 Unauthorized, url: https://chatgpt.com/backend-api/codex/responses"),
    "codex_provider_auth_rejected",
  );
  assert.equal(
    codexTurnAuthFailureReason("Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."),
    "codex_refresh_token_invalid",
  );
});

test("generic 401 text is not a Codex auth fault", () => {
  assert.equal(codexTurnAuthFailureReason("curl: server returned 401 Unauthorized for https://api.example.test/items"), "");
  assert.equal(codexTurnAuthFailureReason("stream disconnected before completion: 503 Service Unavailable"), "");
  assert.equal(codexTurnAuthFailureReason(""), "");
});

test("pane output keeps the narrow classifier and ignores provider 401 tool text", () => {
  assert.equal(codexRuntimeAuthInvalidReason(providerRejection), "");
  const progress = paneProgressFromText(`$ ./check-api.sh\n${providerRejection}\n`, { tailLines: 12 });
  assert.equal(progress.codexAuthInvalid, false);
});

test("API key fragments are redacted from stored auth text", () => {
  const redacted = redactCodexSecrets(providerRejection);
  assert.doesNotMatch(redacted, /sk-/);
  assert.match(redacted, /Incorrect API key provided: \[redacted-api-key\]\./);
  assert.equal(redactCodexSecrets("sk-test-REDACTED and sk-proj-abc123"), "[redacted-api-key] and [redacted-api-key]");
  assert.equal(redactCodexSecrets("task-runner risk-free desk-top"), "task-runner risk-free desk-top");
});

test("turn auth failure signal records broken health without key fragments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-auth-failure-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr"), HOME: home };
  const recorded = await recordCodexRuntimeAuthFailureSignal({
    thread: { id: "auth-failure-thread", name: "Auth Failure Thread" },
    error: providerRejection,
    turnId: "turn-auth-401",
  }, env);
  const health = await readCodexAuthHealth(env);
  assert.equal(recorded.reason, "codex_provider_auth_rejected");
  assert.equal(health.state, "broken");
  assert.equal(health.reason, "codex_provider_auth_rejected");
  assert.equal(health.turnId, "turn-auth-401");
  assert.doesNotMatch(JSON.stringify(health), /sk-/);
});

test("Codex systemError status maps to a failed runtime state", () => {
  assert.equal(appServerStateFromStatus({ type: "systemError" }), "failed");
  assert.equal(appServerStateFromStatus({ type: "idle" }), "ready");
});
