import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseAssistantRolloutMessages,
  retractStalePhantomNeedInputMessages,
} from "../packages/core/src/runtime-leases.js";
import { rejectExpiredLegacyQuestionReply } from "../packages/core/src/codex-app-server.js";
import { visibleThreadMessages } from "../packages/core/src/thread-message-visibility.js";
import {
  appendThreadMessage,
  createThread,
  enqueueThreadInput,
  listThreadMessages,
} from "../packages/core/src/threads.js";

// ORK-473 hardening: durable cross-read phantom request_user_input
// suppression, and safe requeue of a reply rejected as answering an
// expired/unbound legacy question. See docs referenced in the commit for
// the production incident this closes the remaining gap on.

async function setupHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-phantom-question-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr-home") };
  t.after(async () => { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return env;
}

function requestUserInputCall(callId, questionText = "Which records should be synchronized?") {
  return {
    timestamp: "2026-09-09T14:57:05.912Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: callId,
      arguments: JSON.stringify({
        questions: [{
          header: "Sync scope",
          id: "sync_scope",
          question: questionText,
          options: [
            { label: "Full pool", description: "Synchronize every validated record." },
            { label: "Promoted only", description: "Synchronize only promoted records." },
          ],
        }],
      }),
    },
  };
}

function requestUserInputUnavailableOutput(callId) {
  return {
    timestamp: "2026-09-09T14:57:05.987Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output: "request_user_input is unavailable in Default mode",
    },
  };
}

// --- Part 1: durable cross-read correlation -------------------------------

test("rollout parsing reports an orphan failed call_id when its function_call was read in an earlier, separate pass", () => {
  const question = requestUserInputCall("call_cross_read");
  const readOneBody = `${JSON.stringify(question)}\n`;
  const readOneOrphans = [];
  const readOneMessages = parseAssistantRolloutMessages(readOneBody, "thread-cross-read", 0, "codex-generation", {
    onOrphanFailedRequestUserInputCallId: (callId) => readOneOrphans.push(callId),
  });

  // The function_call alone (no failure output seen yet) still projects a
  // real need_input message in its own read -- it only carries a
  // codexCallId, it is not itself suppressed.
  assert.equal(readOneMessages.length, 1);
  assert.equal(readOneMessages[0].phase, "need_input");
  assert.equal(readOneMessages[0].codexCallId, "call_cross_read");
  assert.deepEqual(readOneOrphans, []);

  // A later, separate read only contains the failure output for the same
  // call_id -- simulating the exact incident timing (function_call and
  // function_call_output landing in different poll cycles).
  const unavailable = requestUserInputUnavailableOutput("call_cross_read");
  const readTwoBody = `${JSON.stringify(unavailable)}\n`;
  const readTwoOrphans = [];
  const readTwoMessages = parseAssistantRolloutMessages(readTwoBody, "thread-cross-read", readOneBody.length, "codex-generation", {
    onOrphanFailedRequestUserInputCallId: (callId) => readTwoOrphans.push(callId),
  });

  assert.equal(readTwoMessages.length, 0);
  assert.deepEqual(readTwoOrphans, ["call_cross_read"]);
});

test("rollout parsing does not report an orphan when the function_call and its failure share one read", () => {
  const question = requestUserInputCall("call_same_read");
  const unavailable = requestUserInputUnavailableOutput("call_same_read");
  const body = `${JSON.stringify(question)}\n${JSON.stringify(unavailable)}\n`;
  const orphans = [];
  const messages = parseAssistantRolloutMessages(body, "thread-same-read", 0, "codex-generation", {
    onOrphanFailedRequestUserInputCallId: (callId) => orphans.push(callId),
  });
  assert.equal(messages.some((message) => message.phase === "need_input"), false);
  assert.deepEqual(orphans, []);
});

test("rollout parsing suppresses only the failed call_id when multiple request_user_input calls are in flight", () => {
  const questionA = requestUserInputCall("call_a", "Question A");
  const questionB = requestUserInputCall("call_b", "Question B");
  const failB = requestUserInputUnavailableOutput("call_b");
  const body = [questionA, questionB, failB].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const messages = parseAssistantRolloutMessages(body, "thread-multi-question", 0, "codex-generation");
  const needInput = messages.filter((message) => message.phase === "need_input");
  assert.equal(needInput.length, 1);
  assert.equal(needInput[0].codexCallId, "call_a");
});

test("rollout parsing still reports a failed call_id with no matching request_user_input call as an orphan (safe upper layer no-op)", () => {
  const unrelatedFailure = requestUserInputUnavailableOutput("call_never_seen");
  const body = `${JSON.stringify(unrelatedFailure)}\n`;
  const orphans = [];
  const messages = parseAssistantRolloutMessages(body, "thread-mismatched", 0, "codex-generation", {
    onOrphanFailedRequestUserInputCallId: (callId) => orphans.push(callId),
  });
  assert.equal(messages.length, 0);
  // A single parsed batch cannot distinguish "the function_call was in an
  // earlier read" from "there was never a function_call at all" -- both
  // report as orphan. retractStalePhantomNeedInputMessages (tested below)
  // is what makes a mismatched/unknown call_id a safe no-op in practice,
  // since it only acts on a call_id it finds on an actual persisted message.
  assert.deepEqual(orphans, ["call_never_seen"]);
});

// --- Part 2: retraction of an already-persisted phantom question ----------

test("retractStalePhantomNeedInputMessages hides a stale persisted phantom question and leaves an unrelated one alone", async (t) => {
  const env = await setupHome(t);
  await createThread({ id: "thread-retract", name: "Retract Thread" }, env);
  const phantom = await appendThreadMessage("thread-retract", {
    role: "assistant", source: "codex-rollout", phase: "need_input", eventId: "phantom-need-input",
    text: "Codex needs input to continue:\n\n1. Sync scope: Which records?",
    codexCallId: "call_retract_me",
  }, env);
  const legitimate = await appendThreadMessage("thread-retract", {
    role: "assistant", source: "codex-rollout", phase: "need_input", eventId: "legit-need-input",
    text: "Codex needs input to continue:\n\n1. Other question: Pick one.",
    codexCallId: "call_keep_me",
  }, env);

  const existing = await listThreadMessages("thread-retract", env);
  await retractStalePhantomNeedInputMessages("thread-retract", existing, ["call_retract_me", "call_never_persisted"], env);

  const after = await listThreadMessages("thread-retract", env);
  const retracted = after.find((message) => message.id === phantom.id);
  const untouched = after.find((message) => message.id === legitimate.id);
  assert.equal(retracted.visibility, "internal");
  assert.equal(retracted.deliveryState, "phantom_question_retracted");
  assert.equal(untouched.visibility, undefined);

  // Non-leakage / UI-suppression: the retracted phantom must no longer be a
  // visible thread message, the legitimate one must remain visible.
  const visible = visibleThreadMessages(after);
  assert.equal(visible.some((message) => message.id === phantom.id), false);
  assert.equal(visible.some((message) => message.id === legitimate.id), true);
});

test("retractStalePhantomNeedInputMessages is idempotent across a repeated (restart-like) call with the same call_id", async (t) => {
  const env = await setupHome(t);
  await createThread({ id: "thread-retract-idempotent", name: "Retract Idempotent Thread" }, env);
  await appendThreadMessage("thread-retract-idempotent", {
    role: "assistant", source: "codex-rollout", phase: "need_input", eventId: "phantom-idempotent",
    text: "Codex needs input to continue:\n\n1. Sync scope: Which records?",
    codexCallId: "call_idempotent",
  }, env);

  const firstExisting = await listThreadMessages("thread-retract-idempotent", env);
  await retractStalePhantomNeedInputMessages("thread-retract-idempotent", firstExisting, ["call_idempotent"], env);
  const afterFirst = await listThreadMessages("thread-retract-idempotent", env);
  const retractedFirst = afterFirst.find((message) => message.codexCallId === "call_idempotent");
  assert.equal(retractedFirst.visibility, "internal");
  const revisionAfterFirst = retractedFirst.revision;

  // Simulate a restart/duplicate-replay: the same orphan call_id is
  // reconciled again against the now-already-retracted message.
  await retractStalePhantomNeedInputMessages("thread-retract-idempotent", afterFirst, ["call_idempotent"], env);
  const afterSecond = await listThreadMessages("thread-retract-idempotent", env);
  const retractedSecond = afterSecond.find((message) => message.codexCallId === "call_idempotent");
  assert.equal(retractedSecond.visibility, "internal");
  assert.equal(retractedSecond.revision, revisionAfterFirst, "a second retraction of the same already-retracted message must not mutate it again");
  assert.equal(afterSecond.length, afterFirst.length, "no duplicate or extra message was created");
});

test("retractStalePhantomNeedInputMessages ignores a call_id that matches no persisted message (mismatched/unknown call_id)", async (t) => {
  const env = await setupHome(t);
  await createThread({ id: "thread-retract-mismatch", name: "Retract Mismatch Thread" }, env);
  const question = await appendThreadMessage("thread-retract-mismatch", {
    role: "assistant", source: "codex-rollout", phase: "need_input", eventId: "phantom-mismatch",
    text: "Codex needs input to continue:\n\n1. Sync scope: Which records?",
    codexCallId: "call_real",
  }, env);

  const existing = await listThreadMessages("thread-retract-mismatch", env);
  await retractStalePhantomNeedInputMessages("thread-retract-mismatch", existing, ["call_never_seen"], env);

  const after = await listThreadMessages("thread-retract-mismatch", env);
  const untouched = after.find((message) => message.id === question.id);
  assert.equal(untouched.visibility, undefined);
  assert.equal(untouched.deliveryState, undefined);
});

test("retractStalePhantomNeedInputMessages never retracts a native app-server question (it has a codexRequestId, not a rollout codexCallId)", async (t) => {
  const env = await setupHome(t);
  await createThread({ id: "thread-retract-native", name: "Retract Native Thread" }, env);
  const nativeQuestion = await appendThreadMessage("thread-retract-native", {
    role: "assistant", source: "codex-app-server", phase: "need_input", eventId: "native-need-input",
    text: "Codex needs input to continue:\n\n1. Sync scope: Which records?",
    codexRequestId: "req-native-1",
  }, env);

  const existing = await listThreadMessages("thread-retract-native", env);
  // Even if a caller ever passed the native request's id through this
  // rollout-only path, there is no codexCallId on a native message to match.
  await retractStalePhantomNeedInputMessages("thread-retract-native", existing, ["req-native-1"], env);

  const after = await listThreadMessages("thread-retract-native", env);
  const untouched = after.find((message) => message.id === nativeQuestion.id);
  assert.equal(untouched.visibility, undefined);
});

// --- Part 3: expired-question reply requeue --------------------------------

async function expiredQuestionFixture(t, { text = "1-A", connector = "whatsapp", chatId = "chat-expired" } = {}) {
  const env = await setupHome(t);
  const threadId = "thread-expired-requeue";
  const thread = await createThread({ id: threadId, name: "Expired Requeue Thread", executorId: "codex", executor: { type: "codex" } }, env);
  const question = await appendThreadMessage(threadId, {
    role: "assistant", source: "codex-rollout", phase: "need_input", state: "completed",
    text: "Codex needs input to continue:\n\n1. Scope: Which scope?\n   A. Full pool\n   B. Promoted only",
    eventId: "expired-question-fixture",
  }, env);
  const input = await enqueueThreadInput(threadId, { text, source: "whatsapp_inbound", connector, chatId }, env);
  return { env, thread, threadId, question, input };
}

test("an expired legacy question reply is rejected and the user's own words are requeued as exactly one passive turn", async (t) => {
  const { env, thread, threadId, question, input } = await expiredQuestionFixture(t, { text: "Actually just sync the full pool now" });

  const result = await rejectExpiredLegacyQuestionReply(thread, input, env);
  assert.ok(result);
  assert.equal(result.input.state, "failed");
  assert.equal(result.input.deliveryState, "expired_codex_user_input_request");
  assert.match(result.reply.text, /resend the intended instruction in full/i);
  assert.ok(result.requeued, "a requeued message must be returned");
  assert.equal(result.requeued.role, "user");
  assert.equal(result.requeued.text, "Actually just sync the full pool now");
  assert.equal(result.requeued.state, "queued");
  assert.equal(result.requeued.codexDeliveryMode, "passive");
  assert.equal(result.requeued.steerActiveTurn, false);
  assert.equal(result.requeued.connector, "whatsapp");
  assert.equal(result.requeued.chatId, "chat-expired");

  const messages = await listThreadMessages(threadId, env);
  const requeuedMessages = messages.filter((message) =>
    message.role === "user" && message.deliveryState === "expired_question_requeue");
  assert.equal(requeuedMessages.length, 1, "exactly one fresh passive turn must be enqueued");
  assert.equal(requeuedMessages[0].id, result.requeued.id);

  // No thread/routing/identity leakage: the requeued turn must not expose
  // (or need) the phantom question's own message id, and must stay on the
  // exact same connector/chat/thread the rejected reply already belonged to
  // -- never a different chat, account, or thread.
  assert.equal(requeuedMessages[0].answeredInputMessageId, undefined);
  assert.equal(JSON.stringify(requeuedMessages[0]).includes(question.id), false);
});

test("rejecting the same expired-question reply twice (restart/retry) requeues exactly one turn", async (t) => {
  const { env, thread, threadId, input } = await expiredQuestionFixture(t, { text: "resend attempt after a restart" });

  const first = await rejectExpiredLegacyQuestionReply(thread, input, env);
  assert.ok(first?.requeued);
  // A restart or duplicate delivery-recovery sweep could invoke the exact
  // same rejection again for the same input/question pair.
  const second = await rejectExpiredLegacyQuestionReply(thread, input, env);
  assert.ok(second?.requeued);
  assert.equal(second.requeued.id, first.requeued.id, "the idempotency key must resolve to the same requeued message, not a duplicate");
  assert.equal(second.requeued.duplicate, true);

  const messages = await listThreadMessages(threadId, env);
  const requeuedMessages = messages.filter((message) =>
    message.role === "user" && message.deliveryState === "expired_question_requeue");
  assert.equal(requeuedMessages.length, 1, "no duplicate requeued turn was created on retry");
});

test("an expired-question requeue does not itself re-trigger phantom question handling", async (t) => {
  const { env, thread, threadId, input } = await expiredQuestionFixture(t, { text: "please continue with the plan" });
  const result = await rejectExpiredLegacyQuestionReply(thread, input, env);
  assert.ok(result?.requeued);
  // The requeued message is an ordinary role:"user" input, not an
  // assistant need_input question -- rejectExpiredLegacyQuestionReply must
  // treat it as unrelated on a later, independent call rather than finding
  // it as "the question immediately before" some future reply.
  const again = await rejectExpiredLegacyQuestionReply(thread, result.requeued, env);
  assert.equal(again, null);
  const messages = await listThreadMessages(threadId, env);
  assert.equal(messages.filter((message) => message.deliveryState === "expired_question_requeue").length, 1);
});

// --- Part 4: representative CLI event-shape coverage -----------------------
//
// No authoritative captured rollout artifact for Codex CLI 0.144.5 or
// 0.153.4 exists anywhere in this repository's history -- verified via
// `git log --all -S"0.144.5"` and `git log --all -S"0.153.4"` across every
// ref, both zero hits. The two fixtures below are REPRESENTATIVE coverage
// built from the incident report's own description ("the exact Default-mode
// rejection is also present in a production rollout created by CLI
// 0.144.5"), exercising a minimal-payload shape and a shape carrying extra
// provider metadata a different CLI build could plausibly add. They are
// deliberately NOT named or asserted as verbatim CLI 0.144.5/0.153.4
// captures, because no such capture exists to verify against.

test("rollout parsing suppresses a minimal-payload request_user_input failure shape (representative, not a captured CLI fixture)", () => {
  const question = {
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "request_user_input", call_id: "call_minimal", arguments: "{}" },
  };
  const unavailable = {
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_minimal", output: "request_user_input is unavailable in Default mode" },
  };
  const body = `${JSON.stringify(question)}\n${JSON.stringify(unavailable)}\n`;
  const messages = parseAssistantRolloutMessages(body, "thread-minimal-shape", 0, "codex-generation");
  assert.equal(messages.some((message) => message.phase === "need_input"), false);
});

test("rollout parsing suppresses a request_user_input failure shape carrying extra provider metadata (representative, not a captured CLI fixture)", () => {
  const question = {
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: "call_extra_metadata",
      arguments: JSON.stringify({ questions: [{ header: "Scope", id: "scope", question: "Which scope?", options: [] }] }),
      internal_chat_message_metadata_passthrough: { turn_id: "turn-extra-metadata", provider_build: "representative-fixture" },
    },
  };
  const unavailable = {
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_extra_metadata",
      output: "request_user_input is unavailable in Default mode",
      is_error: true,
    },
  };
  const body = `${JSON.stringify(question)}\n${JSON.stringify(unavailable)}\n`;
  const messages = parseAssistantRolloutMessages(body, "thread-extra-metadata-shape", 0, "codex-generation");
  assert.equal(messages.some((message) => message.phase === "need_input"), false);
});

// --- Part 5: telemetry -------------------------------------------------

test("phantom question suppression telemetry only exposes a strict enum reason label", async () => {
  const { resetObservabilityForTests, renderOpenMetrics } = await import("../packages/core/src/observability.js");
  const { recordCodexPhantomQuestionSuppression } = await import("../packages/core/src/codex-input-observability.js");
  resetObservabilityForTests();
  recordCodexPhantomQuestionSuppression({ reason: "failed_call" });
  recordCodexPhantomQuestionSuppression({ reason: "native_request_authoritative" });
  recordCodexPhantomQuestionSuppression({ reason: "retracted_after_read" });
  recordCodexPhantomQuestionSuppression({ reason: "some-private-call-id-or-thread-name" });

  const metrics = renderOpenMetrics();
  assert.match(metrics, /orkestr_codex_phantom_question_suppressions_total\{reason="failed_call"\} 1/);
  assert.match(metrics, /orkestr_codex_phantom_question_suppressions_total\{reason="native_request_authoritative"\} 1/);
  assert.match(metrics, /orkestr_codex_phantom_question_suppressions_total\{reason="retracted_after_read"\} 1/);
  assert.match(metrics, /orkestr_codex_phantom_question_suppressions_total\{reason="unknown"\} 1/);
  assert.equal(metrics.includes("some-private-call-id-or-thread-name"), false);
});
