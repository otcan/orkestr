import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeThreadConnectorDeliverySignalCount,
  setThreadConnectorDeliverySignalHandler,
  syncRuntimeLeases,
} from "../packages/core/src/runtime-leases.js";
import { appendThreadMessage, createThread, getThread, listThreadMessages } from "../packages/core/src/threads.js";

test("detached app-server WhatsApp threads project direct Codex rollout replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-detached-rollout-"));
  const rolloutPath = path.join(home, "rollout.jsonl");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES: "8192",
  };
  const codexThreadId = "11111111-1111-4111-8111-111111111111";
  const signals = [];
  const clearSignalHandler = setThreadConnectorDeliverySignalHandler((event) => {
    signals.push(event);
  });
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  try {
    consumeThreadConnectorDeliverySignalCount();
    const userTimestamp = "2026-05-26T14:00:00.000Z";
    const replyTimestamp = "2026-05-26T14:00:03.000Z";
    await createThread({
      id: "detached-rollout-thread",
      name: "Detached Rollout Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId,
        metadata: {
          runtimeKind: "codex-app-server",
          codexRolloutPath: rolloutPath,
        },
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
      },
      binding: {
        connector: "whatsapp",
        chatId: "chat-1",
        responderAccountId: "responder",
        outboundAccountId: "responder",
      },
    }, env);
    const parent = await appendThreadMessage("detached-rollout-thread", {
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-1",
      accountId: "responder",
      text: "What changed?",
      timestamp: userTimestamp,
      state: "completed",
    }, env);
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-05-26T13:59:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Old reply" }],
        },
      }),
      JSON.stringify({
        timestamp: replyTimestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Projected reply" }],
        },
      }),
    ].join("\n") + "\n", "utf8");

    const first = await syncRuntimeLeases(env);
    const messages = await listThreadMessages("detached-rollout-thread", env);
    const reply = messages.find((message) => message.text === "Projected reply");

    assert.equal(first.appended, 1);
    assert.ok(reply);
    assert.equal(reply.source, "codex-rollout");
    assert.equal(reply.parentMessageId, parent.id);
    assert.equal(reply.connector, "whatsapp");
    assert.equal(reply.chatId, "chat-1");
    assert.equal(reply.originTransport, "codex-rollout");
    assert.equal(reply.executorThreadId, codexThreadId);
    assert.equal(messages.some((message) => message.text === "Old reply"), false);
    assert.equal(consumeThreadConnectorDeliverySignalCount(), 1);
    assert.deepEqual(signals.map((signal) => ({
      messageId: signal.messageId,
      connector: signal.connector,
      chatId: signal.chatId,
      deliveryState: signal.deliveryState,
    })), [{
      messageId: reply.id,
      connector: "whatsapp",
      chatId: "chat-1",
      deliveryState: "completed",
    }]);

    const stored = await getThread("detached-rollout-thread", env);
    assert.equal(stored.runtime.operatorRolloutPath, rolloutPath);
    assert.ok(stored.runtime.operatorRolloutOffset > 0);
    const firstSyncedAt = stored.runtime.operatorRolloutSyncedAt;
    const firstUpdatedAt = stored.updatedAt;

    const second = await syncRuntimeLeases(env);
    const afterSecond = await listThreadMessages("detached-rollout-thread", env);
    const storedAfterSecond = await getThread("detached-rollout-thread", env);

    assert.equal(second.appended, 0);
    assert.equal(afterSecond.filter((message) => message.text === "Projected reply").length, 1);
    assert.equal(storedAfterSecond.runtime.operatorRolloutSyncedAt, firstSyncedAt);
    assert.equal(storedAfterSecond.updatedAt, firstUpdatedAt);
  } finally {
    clearSignalHandler();
  }
});

test("detached rollout final answers clear matching active app-server turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-detached-rollout-complete-"));
  const rolloutPath = path.join(home, "rollout.jsonl");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES: "8192",
  };
  const codexThreadId = "33333333-3333-4333-8333-333333333333";
  const activeTurnId = "019e0155-20a9-7d52-a059-59d5c7d9c78a";
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await createThread({
    id: "detached-rollout-complete-thread",
    name: "Detached Rollout Complete Thread",
    state: "working",
    executorId: "codex",
    executor: {
      type: "codex",
      transport: "app-server",
      codexThreadId,
      metadata: {
        runtimeKind: "codex-app-server",
        codexRolloutPath: rolloutPath,
      },
    },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "working",
      activeTurnId,
      codexStatus: { type: "active", activeFlags: ["running"] },
    },
    binding: {
      connector: "whatsapp",
      chatId: "chat-complete",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);
  const parent = await appendThreadMessage("detached-rollout-complete-thread", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-complete",
    accountId: "responder",
    text: "Finish this live turn",
    timestamp: "2026-05-26T14:01:00.000Z",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "codex_app_server_turn_start",
    codexThreadId,
    codexTurnId: activeTurnId,
    executorTurnId: activeTurnId,
  }, env);
  await fs.writeFile(rolloutPath, JSON.stringify({
    timestamp: "2026-05-26T14:01:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Detached final reply" }],
    },
  }) + "\n", "utf8");

  const result = await syncRuntimeLeases(env);
  const stored = await getThread("detached-rollout-complete-thread", env);
  const messages = await listThreadMessages("detached-rollout-complete-thread", env);
  const reply = messages.find((message) => message.text === "Detached final reply");

  assert.equal(result.appended, 1);
  assert.equal(stored.state, "ready");
  assert.equal(stored.runtime.state, "ready");
  assert.equal(stored.runtime.activeTurnId, null);
  assert.equal(stored.runtime.lastTurnId, activeTurnId);
  assert.equal(stored.runtime.lastTurnStatus, "completed");
  assert.equal(reply?.parentMessageId, parent.id);
  assert.equal(reply?.codexTurnId, activeTurnId);
});

test("detached rollout sync does not attach a final answer to a queued app-server WhatsApp input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-detached-rollout-queued-parent-"));
  const rolloutPath = path.join(home, "rollout.jsonl");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES: "8192",
  };
  const codexThreadId = "44444444-4444-4444-8444-444444444444";
  const activeTurnId = "019e8891-0376-7503-829b-c1f2d8300b78";
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await createThread({
    id: "detached-rollout-queued-parent-thread",
    name: "Detached Rollout Queued Parent Thread",
    state: "working",
    executorId: "codex",
    executor: {
      type: "codex",
      transport: "app-server",
      codexThreadId,
      metadata: {
        runtimeKind: "codex-app-server",
        codexRolloutPath: rolloutPath,
      },
    },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "working",
      activeTurnId,
      codexStatus: { type: "active", activeFlags: ["running"] },
    },
    binding: {
      connector: "whatsapp",
      chatId: "chat-rollout-queued-parent",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);
  const first = await appendThreadMessage("detached-rollout-queued-parent-thread", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-rollout-queued-parent",
    accountId: "responder",
    text: "First image",
    timestamp: "2026-06-02T13:41:02.000Z",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "codex_app_server_turn_start",
    codexThreadId,
    codexTurnId: activeTurnId,
    executorTurnId: activeTurnId,
  }, env);
  const second = await appendThreadMessage("detached-rollout-queued-parent-thread", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-rollout-queued-parent",
    accountId: "responder",
    text: "Second image",
    timestamp: "2026-06-02T13:41:34.000Z",
    state: "queued",
    deliveryState: "awaiting_active_turn",
  }, env);
  await fs.writeFile(rolloutPath, JSON.stringify({
    timestamp: "2026-06-02T13:42:14.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "First image final answer" }],
    },
  }) + "\n", "utf8");

  const result = await syncRuntimeLeases(env);
  const messages = await listThreadMessages("detached-rollout-queued-parent-thread", env);
  const reply = messages.find((message) => message.text === "First image final answer");
  const queued = messages.find((message) => message.id === second.id);

  assert.equal(result.appended, 1);
  assert.equal(reply?.parentMessageId, first.id);
  assert.notEqual(reply?.parentMessageId, second.id);
  assert.equal(queued?.state, "queued");
  assert.equal(queued?.deliveryState, "awaiting_active_turn");
});

test("detached rollout sync ignores contained app-server WhatsApp threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-contained-rollout-"));
  const rolloutPath = path.join(home, "rollout.jsonl");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES: "8192",
  };
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await createThread({
    id: "contained-detached-rollout-thread",
    name: "Contained Detached Rollout Thread",
    state: "ready",
    ownerUserId: "otcan",
    securityProfile: "private-user",
    executorId: "codex",
    executor: {
      type: "codex",
      transport: "app-server",
      codexThreadId: "22222222-2222-4222-8222-222222222222",
      metadata: {
        runtimeKind: "codex-app-server",
        codexRolloutPath: rolloutPath,
      },
    },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "ready",
    },
    binding: {
      connector: "whatsapp",
      chatId: "chat-2",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);
  await fs.writeFile(rolloutPath, JSON.stringify({
    timestamp: "2026-05-26T14:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Should not project" }],
    },
  }) + "\n", "utf8");

  const result = await syncRuntimeLeases(env);
  const messages = await listThreadMessages("contained-detached-rollout-thread", env);
  const stored = await getThread("contained-detached-rollout-thread", env);

  assert.equal(result.appended, 0);
  assert.equal(messages.some((message) => message.text === "Should not project"), false);
  assert.equal(stored.runtime.operatorRolloutPath, undefined);
  assert.equal(stored.runtime.operatorRolloutOffset, undefined);
});
