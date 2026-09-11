import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../packages/core/src/codex-app-server-client.js";
import { recoverStaleCodexAppServerTurns } from "../packages/core/src/codex-app-server-recovery.js";
import {
  classifyCodexRemoteCompactionFailure,
  codexRemoteCompactionFailureClass,
  remoteCompactionRecoveryAttempt,
  remoteCompactionRecoveryAttempted,
} from "../packages/core/src/codex-remote-compaction-recovery.js";
import { codexAppServerClientArgs } from "../packages/connectors/src/codex-app-server-transport.js";
import { appendThreadMessage, createThread, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";

const remoteCompaction404 = "Error running remote compact task: unexpected status 404 Not Found: {\"detail\":\"Not Found\"}, url: https://chatgpt.com/backend-api/codex/responses/compact";

test("Codex remote-compaction 404 has a dedicated bounded recovery classification", () => {
  const failure = classifyCodexRemoteCompactionFailure({ message: remoteCompaction404 }, {
    runtimeGeneration: "generation-a",
    turnId: "turn-a",
    observedAt: "2026-09-11T06:00:00.000Z",
  });

  assert.equal(failure.classification, codexRemoteCompactionFailureClass);
  assert.equal(failure.upstreamStatus, 404);
  assert.equal(failure.endpointCategory, "codex_responses_compact");
  assert.equal(failure.runtimeGeneration, "generation-a");
  assert.equal(failure.turnId, "turn-a");
  assert.equal(failure.automaticRecoveryLimit, 1);
  assert.equal(failure.automaticTurnReplay, false);
  assert.equal(failure.operatorRetryRequired, true);

  const recovery = remoteCompactionRecoveryAttempt(failure, { status: "resetting" });
  assert.equal(remoteCompactionRecoveryAttempted({ runtime: { remoteCompactionRecovery: recovery } }, failure), true);
  assert.equal(remoteCompactionRecoveryAttempted({ runtime: { remoteCompactionRecovery: { ...recovery, turnId: "turn-b" } } }, failure), false);
});

test("ordinary Codex failures are not classified as remote-compaction 404", () => {
  assert.equal(classifyCodexRemoteCompactionFailure({ message: "unexpected status 500 while generating a response" }), null);
  assert.equal(classifyCodexRemoteCompactionFailure({ message: "thread not found", status: 404 }), null);
  assert.equal(classifyCodexRemoteCompactionFailure({ message: "Error running remote compact task: unexpected status 401 Unauthorized" }), null);
});

test("managed stdio app-server forces current remote compaction while proxy keeps daemon ownership", () => {
  assert.deepEqual(codexAppServerClientArgs({ ORKESTR_CODEX_APP_SERVER_MODE: "stdio" }), [
    "app-server",
    "--listen",
    "stdio://",
    "--enable",
    "remote_compaction_v2",
  ]);
  assert.deepEqual(codexAppServerClientArgs({ ORKESTR_CODEX_APP_SERVER_MODE: "external" }), [
    "app-server",
    "proxy",
  ]);
});

test("remote-compaction 404 resets once and never replays a timer turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-remote-compaction-404-"));
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    ORKESTR_CODEX_APP_SERVER_HISTORY_SYNC: "0",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS: "0",
  };
  const runtimeGeneration = "remote-compact-generation";
  const turnId = "remote-compact-turn";
  const thread = await createThread({
    id: "remote-compact-thread",
    name: "Remote Compact Thread",
    cwd: home,
    executorId: "codex",
    executor: {
      type: "codex",
      transport: "app-server",
      codexThreadId: runtimeGeneration,
      codexSessionId: runtimeGeneration,
    },
    runtimeKind: "codex-app-server",
    codexThreadId: runtimeGeneration,
    codexSessionId: runtimeGeneration,
    runtime: {
      runtimeKind: "codex-app-server",
      runtimeGeneration,
      codexThreadId: runtimeGeneration,
      codexSessionId: runtimeGeneration,
      state: "working",
      activeTurnId: turnId,
      codexStatus: { type: "active", activeFlags: ["running"] },
    },
  }, env);
  const timerInput = await appendThreadMessage(thread.id, {
    role: "user",
    source: "timer_due",
    timerId: "timer-mailbox-check",
    text: "Check the mailbox and update matching records.",
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: "2026-09-11T06:00:00.000Z",
    observedVia: "codex_app_server_turn_start",
    codexThreadId: runtimeGeneration,
    codexTurnId: turnId,
  }, env);
  const client = new CodexAppServerClient({ env, home: env.HOME });
  client.rememberTurnParent(runtimeGeneration, turnId, timerInput);
  await client.handleNotification({
    method: "turn/completed",
    params: {
      turn: {
        id: turnId,
        threadId: runtimeGeneration,
        status: "failed",
        error: { message: remoteCompaction404 },
      },
    },
  });
  client.request = async (method) => {
    assert.equal(method, "thread/read");
    return { thread: { id: runtimeGeneration, status: { type: "idle" }, turns: [{ id: turnId, status: "failed" }] } };
  };

  const afterFailure = await getThread(thread.id, env);
  assert.equal(afterFailure.state, "failed");
  assert.equal(afterFailure.runtime.lastTurnFailure.classification, codexRemoteCompactionFailureClass);
  assert.equal(afterFailure.runtime.lastTurnFailure.runtimeGeneration, runtimeGeneration);
  assert.equal(afterFailure.runtime.lastTurnFailure.turnId, turnId);
  await updateThread(thread.id, {
    runtime: {
      ...afterFailure.runtime,
      lastTurnFailure: null,
    },
  }, env);

  const resets = [];
  const recoveryOptions = {
    client,
    autoSafeResetThread: async (threadId, context) => {
      resets.push({ threadId, context });
      return {
        ok: true,
        safeReset: true,
        oldCodexThreadId: runtimeGeneration,
        newCodexThreadId: "remote-compact-new-generation",
        manualCheckpoint: { path: path.join(home, "checkpoint.md") },
      };
    },
    continueThreadInput: async () => assert.fail("remote-compaction recovery must not continue the failed timer input"),
  };

  const firstProbe = await recoverStaleCodexAppServerTurns(env, recoveryOptions);
  assert.equal(firstProbe.recovered, 0);
  const recovered = await recoverStaleCodexAppServerTurns(env, recoveryOptions);
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.autoSafeReset, 1);
  assert.equal(recovered.continued, 0);
  assert.equal(resets.length, 1);
  assert.equal(resets[0].context.reason, "codex_remote_compaction_404_auto_safe_reset");

  const messages = await listThreadMessages(thread.id, env);
  const notices = messages.filter((message) => message.failureClassification === codexRemoteCompactionFailureClass);
  const replayedInputs = messages.filter((message) => message.role === "user" && message.replayedFromMessageId === timerInput.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].parentMessageId, timerInput.id);
  assert.equal(notices[0].timerId, "timer-mailbox-check");
  assert.equal(notices[0].upstreamStatus, 404);
  assert.equal(notices[0].endpointCategory, "codex_responses_compact");
  assert.equal(notices[0].runtimeGeneration, runtimeGeneration);
  assert.equal(notices[0].failedTurnId, turnId);
  assert.equal(notices[0].operatorRetryRequired, true);
  assert.equal(notices[0].automaticTurnReplay, false);
  assert.match(notices[0].text, /will not run again automatically/i);
  assert.equal(replayedInputs.length, 0);

  const afterRecovery = await getThread(thread.id, env);
  assert.equal(afterRecovery.state, "ready");
  assert.equal(afterRecovery.runtime.remoteCompactionRecovery.attemptCount, 1);
  assert.equal(afterRecovery.runtime.remoteCompactionRecovery.status, "reset_succeeded");
  assert.equal(afterRecovery.runtime.remoteCompactionRecovery.automaticTurnReplay, false);

  const repeated = await recoverStaleCodexAppServerTurns(env, recoveryOptions);
  assert.equal(repeated.autoSafeReset, 0);
  assert.equal(repeated.continued, 0);
  assert.equal(resets.length, 1);
  assert.equal((await listThreadMessages(thread.id, env)).filter((message) => message.role === "user").length, 1);
});
