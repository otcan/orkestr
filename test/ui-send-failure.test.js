import assert from "node:assert/strict";
import test from "node:test";
import { describeUiSendFailure } from "../apps/web/src/app/ui-send-failure.js";

test("UI send failures explain common causes without hiding server detail", () => {
  const network = describeUiSendFailure({ status: 0, message: "Http failure response" });
  assert.match(network.summary, /could not reach/i);
  assert.equal(network.retryable, true);
  assert.match(network.detail, /not duplicated/i);

  const session = describeUiSendFailure({ status: 401, error: { code: "session_expired", message: "Login required" } });
  assert.match(session.summary, /session/i);
  assert.match(session.technical, /HTTP 401.*session_expired.*Login required/);
  assert.equal(session.retryable, true);

  const oversized = describeUiSendFailure(new Error("archive.zip is larger than 25 MB"));
  assert.match(oversized.summary, /too large/i);
  assert.equal(oversized.retryable, false);

  const unavailable = describeUiSendFailure(new Error("attachment_retry_data_unavailable"));
  assert.match(unavailable.detail, /Attach the file again/i);
  assert.equal(unavailable.retryable, false);
});

test("UI send failures distinguish missing threads, runtime conflicts, and server failures", () => {
  const missing = describeUiSendFailure({ status: 404, error: { message: "thread_not_found" } });
  assert.match(missing.summary, /no longer available/i);
  assert.equal(missing.retryable, false);

  const conflict = describeUiSendFailure({ status: 409, error: { message: "thread_not_ready" } });
  assert.match(conflict.detail, /starting, stopping, or recovering/i);
  assert.equal(conflict.retryable, true);

  const server = describeUiSendFailure({ status: 503, error: { code: "runtime_unavailable", message: "worker offline" } });
  assert.match(server.summary, /server error/i);
  assert.match(server.technical, /runtime_unavailable/);
  assert.equal(server.retryable, true);
});
