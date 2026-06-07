import assert from "node:assert/strict";
import test from "node:test";
import {
  rawAttachWatchPayload,
  rawAttachWatchText,
  rawStructuredTurnActive,
} from "../packages/core/src/raw-terminal-watch.js";

test("raw terminal watch detects active structured app-server turns", () => {
  const thread = {
    id: "thread-1",
    name: "Demo",
    runtime: {
      runtimeKind: "codex-app-server",
      activeTurnId: "turn-1",
      updatedAt: "2026-06-07T10:00:00.000Z",
    },
  };
  const status = {
    runtimeKind: "codex-app-server",
    state: "working",
    activeTurnId: "turn-1",
    codexAppServerTransport: "stdio",
    activeTurnObservedAt: "2026-06-07T10:00:00.000Z",
    statusObservedAt: "2026-06-07T10:00:20.000Z",
    pendingCount: 1,
  };

  assert.equal(rawStructuredTurnActive(thread, status), true);
  assert.equal(rawStructuredTurnActive({ ...thread, runtime: { runtimeKind: "codex-app-server" } }, { ...status, state: "ready", activeTurnId: "", working: false }), false);

  const watch = rawAttachWatchPayload({
    thread,
    status,
    messages: [
      { role: "assistant", text: "working", updatedAt: "2026-06-07T10:00:30.000Z" },
      { role: "tool", text: "shell", updatedAt: "2026-06-07T10:00:40.000Z" },
    ],
    startedAtMs: Date.parse("2026-06-07T10:00:10.000Z"),
    nowMs: Date.parse("2026-06-07T10:01:10.000Z"),
    intervalMs: 5000,
    timeoutMs: 900000,
  });

  assert.equal(watch.mode, "watch-and-wait");
  assert.equal(watch.attachable, false);
  assert.equal(watch.mutationAllowed, false);
  assert.equal(watch.threadId, "thread-1");
  assert.equal(watch.runtimeMode, "codex-app-server");
  assert.equal(watch.runtimeState, "working");
  assert.equal(watch.activeTurnId, "turn-1");
  assert.equal(watch.queueDepth, 1);
  assert.equal(watch.appServerConnected, true);
  assert.equal(watch.staleRisk, "low");
  assert.equal(watch.recommendedAction, "wait");
  assert.match(rawAttachWatchText(watch), /Raw attach watch-and-wait/);
  assert.match(rawAttachWatchText(watch), /Active turn: turn-1/);
  assert.match(rawAttachWatchText(watch), /Hotkeys: Ctrl-C cancel; i interrupt\/take over; r read-only; s refresh; a approve; d deny/);
});

test("raw terminal watch does not invent active duration for idle structured runtimes", () => {
  const watch = rawAttachWatchPayload({
    thread: {
      id: "thread-2",
      name: "Idle Demo",
      runtime: {
        runtimeKind: "codex-app-server",
        updatedAt: "2026-06-07T10:00:00.000Z",
      },
    },
    status: {
      runtimeKind: "codex-app-server",
      state: "ready",
      codexAppServerTransport: "websocket",
      statusObservedAt: "2026-06-07T10:00:20.000Z",
    },
    nowMs: Date.parse("2026-06-07T10:01:10.000Z"),
  });

  assert.equal(watch.activeTurnId, null);
  assert.equal(watch.activeDurationMs, null);
  assert.equal(watch.activeDuration, "unknown");
  assert.match(rawAttachWatchText(watch), /Active turn: none \(unknown\)/);
});
