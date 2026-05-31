import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTurnLifecycle,
  turnLifecycleEvent,
  turnLifecycleFromRuntimeStatus,
} from "../packages/core/src/turn-lifecycle.js";

test("turn lifecycle normalizes queued, running, approval, and terminal states", () => {
  const queued = turnLifecycleFromRuntimeStatus({ state: "ready", pendingCount: 2, typingActive: true });
  const running = turnLifecycleFromRuntimeStatus({ state: "working", activeTurnId: "turn-1", runningCount: 1, typingActive: true });
  const approval = turnLifecycleFromRuntimeStatus({ state: "awaiting_approval", activeTurnId: "turn-2", typingActive: true });
  const terminal = normalizeTurnLifecycle({ state: "completed", typingActive: true });

  assert.equal(queued.state, "queued");
  assert.equal(queued.queued, true);
  assert.equal(queued.typingActive, false);
  assert.equal(running.state, "running");
  assert.equal(running.running, true);
  assert.equal(running.typingActive, true);
  assert.equal(approval.awaitingApproval, true);
  assert.equal(approval.typingActive, false);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.sidebarWorking, false);
});

test("turn lifecycle events use the shared terminal event contract", () => {
  const event = turnLifecycleEvent("completed", {
    threadId: "thread-1",
    messageId: "message-1",
    runtimeKind: "codex-app-server",
    turnId: "turn-1",
    source: "codex-app-server",
  });

  assert.deepEqual(event, {
    type: "turn_lifecycle_completed",
    threadId: "thread-1",
    messageId: "message-1",
    runtimeKind: "codex-app-server",
    turnId: "turn-1",
    state: "completed",
    source: "codex-app-server",
    reason: null,
  });
});
