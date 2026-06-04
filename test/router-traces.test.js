import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectStuckRouterTraces,
  ensureRouterTurn,
  listRouterOutbox,
  listRouterTraces,
  markRouterOutboxItem,
  planRouterOutboxItem,
  recordRouterTraceEvent,
  routerOutboxIdFor,
  routerTraceIdFor,
  routerTraceMetrics,
  turnIdFor,
} from "../packages/core/src/router-traces.js";

test("router trace projection records phases, turns, outbox, and stuck diagnostics", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-traces-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ROUTER_TRACE_STUCK_MS: "30000",
  };
  const routerTraceId = routerTraceIdFor({
    connector: "whatsapp",
    accountId: "wa-1",
    chatId: "chat-1",
    eventId: "evt-1",
  });
  const turnId = turnIdFor({ routerTraceId });
  const oldTs = new Date(Date.now() - 60_000).toISOString();

  await ensureRouterTurn({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId: "wa-1",
    chatId: "chat-1",
    eventId: "evt-1",
    threadId: "thread-1",
    messageId: "message-1",
  }, env);
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId: "wa-1",
    chatId: "chat-1",
    sourceEventId: "evt-1",
    threadId: "thread-1",
    messageId: "message-1",
    phase: "received",
    ts: oldTs,
  }, env);
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    threadId: "thread-1",
    messageId: "message-1",
    phase: "queued",
    ts: oldTs,
  }, env);
  const outboxId = routerOutboxIdFor({
    turnId,
    connector: "whatsapp",
    destination: "chat-1",
    eventId: "assistant-1",
    payloadHash: "payload-hash",
  });
  const outbox = await planRouterOutboxItem({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    destination: "chat-1",
    eventId: "assistant-1",
    payloadHash: "payload-hash",
  }, env);
  await markRouterOutboxItem(outbox.outboxId, { status: "claimed", attempts: 1 }, env);

  const traces = await listRouterTraces({ threadId: "thread-1" }, env);
  const stuck = await detectStuckRouterTraces(env);
  const outboxItems = await listRouterOutbox({ routerTraceId }, env);
  const metrics = await routerTraceMetrics(env);

  assert.equal(routerTraceId.startsWith("rt_"), true);
  assert.equal(turnId.startsWith("turn_"), true);
  assert.equal(outboxId, outbox.outboxId);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].currentPhase, "queued");
  assert.equal(traces[0].diagnostics.stuck, true);
  assert.match(traces[0].diagnostics.recovery, /wake|retry/i);
  assert.equal(stuck.length, 1);
  assert.equal(outboxItems[0].status, "claimed");
  assert.equal(outboxItems[0].attempts, 1);
  assert.equal(metrics.traces, 1);
  assert.equal(metrics.outbox, 1);
  assert.equal(metrics.stuck, 1);
});
