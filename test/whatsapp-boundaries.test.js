import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireOutboundDeliveryClaim,
  deliveryTextKey,
  finishOutboundDeliveryClaim,
  outboundDeliveryClaimExpired,
  outboundDeliveryKey,
  pruneOutboundDeliveryClaims,
} from "../packages/connectors/src/whatsapp-delivery-ledger.js";
import { appendWhatsAppDebugFooter, formatWhatsAppOutboundText } from "../packages/connectors/src/whatsapp-formatting.js";
import { whatsappInboundThreadMatchesBinding } from "../packages/connectors/src/whatsapp-inbound-routing.js";
import { shouldMirrorWhatsAppProgress, shouldMirrorWhatsAppReply } from "../packages/connectors/src/whatsapp-mirror-policy.js";
import { initialQueueDeliveryState } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
import { createWhatsAppOutboundMirrorWorker } from "../packages/connectors/src/whatsapp-outbound-worker.js";

test("WhatsApp formatting strips plan envelopes and preserves code fences", () => {
  const formatted = formatWhatsAppOutboundText([
    "<proposed_plan>",
    "# Plan",
    "",
    "**Bold** [Docs](https://example.com/docs) `literal **x**`",
    "```js",
    "**do not touch**",
    "```",
    "</proposed_plan>",
  ].join("\n"));

  assert.equal(formatted, [
    "Plan",
    "",
    "*Bold* Docs: https://example.com/docs `literal **x**`",
    "```js",
    "**do not touch**",
    "```",
  ].join("\n"));
});

test("WhatsApp debug footer is gated and marks progress as update", () => {
  const disabled = appendWhatsAppDebugFooter("Done", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "0" },
    message: { source: "codex-app-server", phase: "final_answer" },
  });
  assert.equal(disabled, "Done");

  const enabled = appendWhatsAppDebugFooter("Working", {
    env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1", ORKESTR_DEFAULT_CODEX_MODEL: "gpt-test" },
    deliveryType: "progress",
    message: { source: "codex-app-server", phase: "commentary" },
    thread: { codexModeLive: "plan" },
    messages: [{ id: "u1", role: "user", state: "queued" }],
  });
  assert.match(enabled, /^Working\n\ndbg: /);
  assert.match(enabled, /m:gpt-test/);
  assert.match(enabled, /mode:plan/);
  assert.match(enabled, /msg:update/);
  assert.match(enabled, /switch:\/code/);
});

test("WhatsApp mirror policy separates final replies from progress updates", () => {
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "final_answer" }), true);
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server", phase: "commentary" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "commentary" }), false);
  assert.equal(
    shouldMirrorWhatsAppProgress(
      { source: "codex-app-server", phase: "commentary" },
      { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" },
    ),
    true,
  );
  assert.equal(shouldMirrorWhatsAppReply({ source: "codex-app-server-import", phase: "final_answer" }), true);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server-import", phase: "commentary" }), false);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "awaiting_approval" }), true);
  assert.equal(shouldMirrorWhatsAppProgress({ source: "codex-app-server", phase: "context_compaction" }), false);
  assert.equal(shouldMirrorWhatsAppReply({ source: "manual", phase: "commentary" }), true);
});

test("WhatsApp outbound mirror worker serializes delivery and maps app-server queue states", async () => {
  const worker = createWhatsAppOutboundMirrorWorker();
  let runs = 0;
  let release;
  const first = worker.run(() => new Promise((resolve) => {
    runs += 1;
    release = resolve;
  }));
  const second = worker.run(() => {
    runs += 1;
    return "second";
  });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runs, 1);
  release("done");
  assert.equal(await first, "done");
  assert.equal(runs, 1);

  assert.equal(initialQueueDeliveryState({
    state: "sleeping",
    runtimeKind: "codex-app-server",
    promptReady: false,
  }, { text: "hello" }), "waking");
  assert.equal(initialQueueDeliveryState({
    state: "working",
    runtimeKind: "codex-app-server",
    activeTurnId: "turn-1",
  }, { text: "hello" }), "awaiting_active_turn");
});

test("WhatsApp inbound routing requires explicit participants unless a generated group boundary is trusted", () => {
  const baseThread = {
    binding: {
      connector: "whatsapp",
      chatId: "group-1@g.us",
      generated: true,
      senderAccountId: "wa-1",
      responderAccountId: "wa-1",
      outboundAccountId: "wa-1",
      senderContactId: "491234@c.us",
      responderContactId: "905555@c.us",
      additionalParticipantsEnabled: false,
      additionalParticipantIds: [],
    },
  };

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: baseThread,
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "66378837028965@lid",
    fromMe: false,
  }), true);

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: { binding: { ...baseThread.binding, generated: false } },
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "66378837028965@lid",
    fromMe: false,
  }), false);

  assert.equal(whatsappInboundThreadMatchesBinding({
    thread: { binding: { ...baseThread.binding, generated: false, additionalParticipantsEnabled: true, additionalParticipantIds: ["66378837028965@lid"] } },
    chatId: "group-1@g.us",
    accountId: "wa-1",
    from: "66378837028965@lid",
    fromMe: false,
  }), true);
});

test("WhatsApp delivery ledger claims prevent concurrent duplicate sends", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ledger-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "5000" };
  const state = { outboundDeliveryClaims: [] };
  const persistState = async () => {};
  const textKey = deliveryTextKey("chat-1", "same message");

  const first = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(first.acquired, true);

  const second = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "delivery_claim_active");

  await finishOutboundDeliveryClaim({
    state,
    claim: first.claim,
    filePath: first.filePath,
    status: "delivered",
    delivery: { deliveredAt: new Date().toISOString() },
  }, env, { persistState });

  assert.equal((await fs.stat(first.filePath).catch(() => null)), null);
  assert.equal(outboundDeliveryKey({ kind: "thread", deliveryType: "final", chatId: "chat-1", accountId: "wa-1", messageId: "message-1", textKey }).includes("chat-1"), true);
  assert.equal(outboundDeliveryClaimExpired({ status: "claimed", updatedAt: "2000-01-01T00:00:00.000Z" }, Date.now(), env), true);
  assert.equal(pruneOutboundDeliveryClaims([{ claimKey: "old", updatedAt: "2000-01-01T00:00:00.000Z" }], { env }).length, 0);
});

test("WhatsApp delivery ledger releases failed claim files for retry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ledger-failed-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "60000" };
  const state = { outboundDeliveryClaims: [] };
  const persistState = async () => {};
  const textKey = deliveryTextKey("chat-1", "retry message");

  const first = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(first.acquired, true);

  await finishOutboundDeliveryClaim({
    state,
    claim: first.claim,
    filePath: first.filePath,
    status: "failed",
    error: "temporary bridge failure",
  }, env, { persistState });

  assert.equal((await fs.stat(first.filePath).catch(() => null)), null);

  const retry = await acquireOutboundDeliveryClaim({
    state,
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-1",
    messageId: "message-1",
    chatId: "chat-1",
    accountId: "wa-1",
    textKey,
  }, env, { persistState });
  assert.equal(retry.acquired, true);
});
