import assert from "node:assert/strict";
import test from "node:test";
import {
  OrkestrEventTypes,
  orkestrEventIdempotencyKey,
  turnLifecycleEventName,
} from "../packages/core/src/orkestr-events.js";
import {
  normalizeTurnLifecycle,
  turnLifecycleEvent,
  turnLifecycleFromRuntimeStatus,
} from "../packages/core/src/turn-lifecycle.js";

test("turn lifecycle normalizes queued, running, approval, and terminal states", () => {
  const queued = turnLifecycleFromRuntimeStatus({ state: "ready", pendingCount: 2, typingActive: true });
  const running = turnLifecycleFromRuntimeStatus({ state: "working", activeTurnId: "turn-1", runningCount: 1, typingActive: true });
  const planning = turnLifecycleFromRuntimeStatus({ state: "working", activeTurnId: "turn-plan", progress: { stateHint: "planning" }, typingActive: true });
  const approval = turnLifecycleFromRuntimeStatus({ state: "awaiting_approval", activeTurnId: "turn-2", typingActive: true });
  const terminal = normalizeTurnLifecycle({ state: "completed", typingActive: true });

  assert.equal(queued.state, "queued");
  assert.equal(queued.queued, true);
  assert.equal(queued.typingActive, false);
  assert.equal(running.state, "running");
  assert.equal(running.running, true);
  assert.equal(running.typingActive, true);
  assert.equal(planning.state, "planning");
  assert.equal(planning.planning, true);
  assert.equal(planning.sidebarWorking, true);
  assert.equal(approval.awaitingApproval, true);
  assert.equal(approval.typingActive, false);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.sidebarWorking, false);
});

test("confirmed idle execution wins over stale delivery rows and progress", () => {
  const status = { state: "ready", working: false, activeTurnId: null, runningCount: 1, progress: { stateHint: "planning" } };
  const messages = [{ id: "old-input", role: "user", state: "running", executorTurnId: "old-turn" }];
  const idle = turnLifecycleFromRuntimeStatus(status, messages);
  assert.equal(idle.state, "ready");
  assert.equal(idle.sidebarWorking, false);
  assert.equal(idle.running, false);
  assert.equal(idle.activeTurnId, null);
  assert.equal(idle.runningCount, 1, "keep the stale count available for diagnosis");
  const queued = turnLifecycleFromRuntimeStatus({ ...status, pendingCount: 1 }, messages);
  assert.equal(queued.state, "queued");
  assert.equal(queued.sidebarWorking, true);
  assert.equal(queued.running, false);
  const live = turnLifecycleFromRuntimeStatus({ ...status, state: "working", working: true, activeTurnId: "new-turn" }, messages);
  assert.equal(live.sidebarWorking, true);
  assert.equal(live.activeTurnId, "new-turn");
});

test("legacy runtimes without an explicit idle signal keep message evidence", () => {
  const lifecycle = turnLifecycleFromRuntimeStatus({ state: "ready", runningCount: 1 });
  assert.equal(lifecycle.running, true);
});

test("shared Orkestr event contract exposes stable names and idempotency keys", () => {
  assert.equal(OrkestrEventTypes.threadInputQueued, "thread.input.queued");
  assert.equal(OrkestrEventTypes.whatsappMirrorDelivered, "whatsapp.mirror.delivered");
  assert.equal(turnLifecycleEventName("completed"), "turn_lifecycle_completed");
  assert.equal(
    orkestrEventIdempotencyKey({
      type: OrkestrEventTypes.whatsappMirrorDelivered,
      threadId: "thread-1",
      messageId: "message-1",
      chatId: "chat-1",
      deliveryType: "final",
    }),
    "whatsapp.mirror.delivered|thread-1|message-1|||chat-1|final",
  );
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
