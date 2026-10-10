import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordCodexTurnOutcome } from "../packages/core/src/codex-app-server-turn-outcome.js";
import { lookupThreadInputResult } from "../packages/core/src/runtime-input-result.js";
import { classifyCodexTurnError } from "../packages/core/src/runtime-turn-error-class.js";
import { appendThreadMessage, createThread, updateThreadMessage } from "../packages/core/src/threads.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-input-result-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "result-owner", HOME: home };
  await createThread({ id: "result-thread", name: "Result", ownerUserId: "result-owner", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
  return env;
}

test("completed codex input resolves to its final message by client id", async (t) => {
  const env = await fixture(t);
  const input = await appendThreadMessage("result-thread", { role: "user", text: "hello", clientMessageId: "client-1", state: "completed", codexTurnId: "turn-a" }, env);
  await appendThreadMessage("result-thread", { role: "assistant", source: "codex", phase: "commentary", text: "working", codexTurnId: "turn-a" }, env);
  const final = await appendThreadMessage("result-thread", { role: "assistant", source: "codex", phase: "final_answer", text: "hello back", codexTurnId: "turn-a" }, env);
  await recordCodexTurnOutcome({ threadId: "result-thread", turnId: "turn-a", status: "completed" }, env);

  const result = await lookupThreadInputResult("result-thread", "client-1", env);
  assert.equal(result.messageId, input.id);
  assert.equal(result.turnId, "turn-a");
  assert.equal(result.status, "completed");
  assert.equal(result.settled, true);
  assert.equal(result.finalMessageId, final.id);
  assert.equal(result.output.text, "hello back");
  assert.equal(result.error, null);
  assert.equal((await lookupThreadInputResult("result-thread", input.id, env)).turnId, "turn-a");
  assert.equal(await lookupThreadInputResult("result-thread", "client-missing", env), null);
});

test("failed codex input returns the classified error", async (t) => {
  const env = await fixture(t);
  await appendThreadMessage("result-thread", { role: "user", text: "boom", clientMessageId: "client-2", state: "delivered", codexTurnId: "turn-b" }, env);
  const error = classifyCodexTurnError("429 Too Many Requests");
  await recordCodexTurnOutcome({ threadId: "result-thread", turnId: "turn-b", status: "failed", error }, env);

  const result = await lookupThreadInputResult("result-thread", "client-2", env);
  assert.equal(result.status, "failed");
  assert.equal(result.finalMessageId, null);
  assert.equal(result.error.class, "rate_limit");
  assert.equal(result.error.retryable, true);
});

test("an outcome from an earlier attempt is ignored once the input is requeued or resubmitted", async (t) => {
  const env = await fixture(t);
  const input = await appendThreadMessage("result-thread", { role: "user", text: "retry", clientMessageId: "client-3", state: "delivered", codexTurnId: "turn-c" }, env);
  await recordCodexTurnOutcome({ threadId: "result-thread", turnId: "turn-c", status: "failed", error: classifyCodexTurnError("", { authReason: "provider_auth_rejected" }) }, env);
  await updateThreadMessage("result-thread", input.id, { state: "queued" }, env);
  assert.equal((await lookupThreadInputResult("result-thread", "client-3", env)).status, "pending");

  await updateThreadMessage("result-thread", input.id, { state: "running", codexTurnId: "turn-d" }, env);
  const running = await lookupThreadInputResult("result-thread", "client-3", env);
  assert.equal(running.status, "running");
  assert.equal(running.turnId, "turn-d");
  assert.equal(running.settled, false);
});
