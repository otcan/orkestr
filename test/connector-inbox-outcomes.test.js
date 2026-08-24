import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConnectorInboxEvent, listConnectorInboxEvents, markConnectorInboxEvent, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import { replayConnectorInboxEvent, retryConnectorInbox, routeWhatsAppInboundFromWorker } from "../packages/connectors/src/connectors-mcp-router.js";
import { claimWhatsAppInboundFailureNotice } from "../packages/connectors/src/whatsapp-inbound-notice-ledger.js";

function deniedResponse() {
  return {
    ok: false,
    status: 403,
    json: async () => ({
      ok: false,
      error: "whatsapp_inbound_sender_denied",
      routingFailure: {
        code: "whatsapp_inbound_sender_denied",
        classification: "host_execution",
        effectiveRole: "trusted",
        retryable: false,
      },
    }),
  };
}

test("connector inbox preserves a terminal denial and classifies retries as duplicate rejection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbox-terminal-denial-"));
  const env = { ORKESTR_HOME: home, ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL: "http://target.test/inbound" };
  const input = { eventId: "wa-denied-1", accountId: "wa-receiver", chatId: "synthetic@g.us", text: "run the host check" };
  let calls = 0;
  try {
    const denied = await routeWhatsAppInboundFromWorker(input, env, async () => {
      calls += 1;
      return deniedResponse();
    });
    const duplicate = await routeWhatsAppInboundFromWorker(input, env, async () => {
      throw new Error("terminal denial must not be automatically forwarded");
    });
    const retryPump = await retryConnectorInbox(env, async () => {
      throw new Error("terminal denial must not enter retry pump");
    });

    assert.equal(denied.state, "rejected_terminal");
    assert.equal(denied.outcome, "rejected_terminal");
    assert.equal(denied.retryable, false);
    assert.equal(duplicate.outcome, "duplicate_rejected");
    assert.equal(duplicate.rejected, true);
    assert.equal(retryPump.attempted, 0);
    assert.equal(calls, 1);
  } finally {
    resetConnectorInboxForTest();
  }
});

test("explicit linked replay reevaluates policy and creates at most one target input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbox-explicit-replay-"));
  const env = { ORKESTR_HOME: home, ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL: "http://target.test/inbound" };
  const input = { eventId: "wa-denied-replay-1", accountId: "wa-receiver", chatId: "synthetic@g.us", text: "run the host check" };
  const deliveredEventIds = [];
  try {
    await routeWhatsAppInboundFromWorker(input, env, async () => deniedResponse());
    const deliverReplay = async (_url, options) => {
      const payload = JSON.parse(options.body);
      deliveredEventIds.push(payload.eventId);
      return { ok: true, status: 202, json: async () => ({ ok: true, threadId: "thread-1", messageId: "message-1" }) };
    };
    const first = await replayConnectorInboxEvent(input.eventId, {
      replayId: "authorization-revision-2",
      requestedBy: "synthetic-operator",
      reason: "owner_alias_verified",
    }, env, deliverReplay);
    const duplicate = await replayConnectorInboxEvent(input.eventId, {
      replayId: "authorization-revision-2",
      requestedBy: "synthetic-operator",
    }, env, async () => {
      throw new Error("same explicit replay must not be forwarded twice");
    });
    const events = await listConnectorInboxEvents({}, env);
    const replay = events.find((event) => event.replayOfId === input.eventId);

    assert.equal(first.ok, true);
    assert.equal(first.explicitReplay, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.outcome, "duplicate_accepted");
    assert.equal(deliveredEventIds.length, 1);
    assert.equal(replay.replayId, "authorization-revision-2");
    assert.equal(replay.outcome, "duplicate_accepted");
  } finally {
    resetConnectorInboxForTest();
  }
});

test("WhatsApp terminal denial sender notices are claimed once durably", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-denial-notice-ledger-"));
  const env = { ORKESTR_HOME: home };
  const input = {
    accountId: "wa-receiver",
    eventId: "terminal-denial-notice-1",
    chatId: "synthetic@g.us",
    failureCode: "whatsapp_inbound_sender_denied",
  };
  const claims = await Promise.all([
    claimWhatsAppInboundFailureNotice(input, env),
    claimWhatsAppInboundFailureNotice(input, env),
  ]);
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(claims.filter((claim) => claim.reason === "already_notified").length, 1);
});

test("explicit replay requires an override for uncertain dead letters", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbox-dead-letter-replay-"));
  const env = { ORKESTR_HOME: home, ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL: "http://target.test/inbound" };
  try {
    await ensureConnectorInboxEvent({
      id: "wa-dead-letter-1",
      connector: "whatsapp",
      accountId: "wa-receiver",
      conversationId: "synthetic@g.us",
      payload: { eventId: "wa-dead-letter-1", accountId: "wa-receiver", chatId: "synthetic@g.us", text: "synthetic" },
    }, env);
    await markConnectorInboxEvent("wa-dead-letter-1", { state: "dead_letter", outcome: "retryable_failure" }, env);
    await assert.rejects(
      replayConnectorInboxEvent("wa-dead-letter-1", { replayId: "operator-attempt-1" }, env),
      /connector_inbox_replay_source_not_rejected/,
    );
  } finally {
    resetConnectorInboxForTest();
  }
});
