import test from "node:test";
import assert from "node:assert/strict";

import {
  activeTurnRecoveryPending,
  shouldRecoverStaleActiveTurn,
  staleDynamicExecCall,
} from "../packages/core/src/codex-app-server-active-turn-recovery.js";
import {
  activeDynamicToolCallFromCodexThread,
  probeLiveCodexThreadState,
} from "../packages/core/src/codex-app-server-live-state.js";

function activeContext(overrides = {}) {
  const turnId = "turn-active";
  const thread = {
    state: "working",
    runtime: { state: "working", activeTurnId: turnId },
    ...(overrides.thread || {}),
  };
  const clientState = {
    activeTurnId: turnId,
    activeTurnIds: [turnId],
    status: { type: "active", activeFlags: ["running"] },
    activeDynamicToolCall: {
      id: "tool-exec-1",
      turnId,
      namespace: "functions",
      tool: "exec",
      durationMs: 31_000,
      observedAt: new Date(Date.now() - 31_000).toISOString(),
    },
    ...(overrides.clientState || {}),
  };
  const turn = {
    latestUser: {
      codexTurnId: turnId,
      steerActiveTurn: true,
      codexDeliveryMode: "instant_steer",
      observedVia: "codex_app_server_turn_steer",
      ...(overrides.latestUser || {}),
    },
  };
  return { thread, clientState, turn };
}

test("live Codex state identifies the in-progress dynamic tool callback", () => {
  const active = activeDynamicToolCallFromCodexThread({
    turns: [
      {
        id: "turn-active",
        status: "inProgress",
        items: [
          { id: "user-1", type: "userMessage" },
          { id: "tool-old", type: "dynamicToolCall", tool: "exec", status: "completed" },
          { id: "tool-live", type: "dynamicToolCall", namespace: "functions", tool: "exec", status: "inProgress", durationMs: 45_000 },
        ],
      },
    ],
  }, "turn-active");

  assert.deepEqual(active, {
    id: "tool-live",
    turnId: "turn-active",
    namespace: "functions",
    tool: "exec",
    durationMs: 45_000,
  });
});

test("live Codex probes preserve the first-seen time for the same callback", async () => {
  const codexThread = {
    id: "codex-thread-1",
    status: { type: "active", activeFlags: ["running"] },
    turns: [{
      id: "turn-active",
      status: "inProgress",
      items: [{ id: "tool-live", type: "dynamicToolCall", tool: "exec", status: "inProgress" }],
    }],
  };
  const client = {
    threadStates: new Map(),
    request: async () => ({ thread: codexThread }),
  };

  const first = await probeLiveCodexThreadState(client, codexThread.id);
  const second = await probeLiveCodexThreadState(client, codexThread.id);

  assert.equal(first.state.activeDynamicToolCall.id, "tool-live");
  assert.equal(second.state.activeDynamicToolCall.observedAt, first.state.activeDynamicToolCall.observedAt);
  assert.notEqual(second.state.activeDynamicToolCall.checkedAt, "");
});

test("active-turn recovery targets only a stale exec callback with a waiting steer", () => {
  const env = { ORKESTR_CODEX_APP_SERVER_STALE_DYNAMIC_EXEC_MS: "30000" };
  const context = activeContext();

  assert.equal(Boolean(staleDynamicExecCall(context.clientState, env)), true);
  assert.equal(activeTurnRecoveryPending(context.thread, context.clientState, context.turn, env), true);
  assert.equal(shouldRecoverStaleActiveTurn(context.thread, context.clientState, context.turn, env), true);
});

test("active-turn recovery preserves long turns without an abandoned exec callback", () => {
  const env = { ORKESTR_CODEX_APP_SERVER_STALE_DYNAMIC_EXEC_MS: "30000" };
  const noTool = activeContext({ clientState: { activeDynamicToolCall: null } });
  const freshTool = activeContext({
    clientState: {
      activeDynamicToolCall: {
        id: "tool-exec-fresh",
        turnId: "turn-active",
        tool: "exec",
        durationMs: 1_000,
        observedAt: new Date().toISOString(),
      },
    },
  });
  const noSteer = activeContext({ latestUser: { steerActiveTurn: false, codexDeliveryMode: "passive", observedVia: "codex_app_server_turn_start" } });
  const approval = activeContext({
    thread: { state: "awaiting_approval", runtime: { state: "awaiting_approval", activeTurnId: "turn-active", pendingRequest: { id: "approval-1" } } },
  });

  assert.equal(shouldRecoverStaleActiveTurn(noTool.thread, noTool.clientState, noTool.turn, env), false);
  assert.equal(shouldRecoverStaleActiveTurn(freshTool.thread, freshTool.clientState, freshTool.turn, env), false);
  assert.equal(shouldRecoverStaleActiveTurn(noSteer.thread, noSteer.clientState, noSteer.turn, env), false);
  assert.equal(shouldRecoverStaleActiveTurn(approval.thread, approval.clientState, approval.turn, env), false);
});
