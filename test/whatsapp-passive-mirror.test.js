import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completePassiveMirrorParent } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";

test("passive WhatsApp mirror does not complete app-server input queued behind an active turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-active-turn-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr") };
  await createThread({ id: "thread-wa-passive-active-turn", name: "WA Passive Active Turn" }, env);
  const parent = await appendThreadMessage("thread-wa-passive-active-turn", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-passive-active-turn",
    accountId: "main",
    text: "second image",
    state: "queued",
    deliveryState: "awaiting_active_turn",
  }, env);
  const reply = await appendThreadMessage("thread-wa-passive-active-turn", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "answer for the previous turn",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: "chat-passive-active-turn",
  }, env);

  const result = await completePassiveMirrorParent({
    kind: "thread",
    threadId: "thread-wa-passive-active-turn",
    parent,
    reply,
    chatId: "chat-passive-active-turn",
    state: null,
    env,
  });
  const messages = await listThreadMessages("thread-wa-passive-active-turn", env);
  const current = messages.find((message) => message.id === parent.id);

  assert.equal(result, null);
  assert.equal(current.state, "queued");
  assert.equal(current.deliveryState, "awaiting_active_turn");
  assert.equal(current.passiveMirrorMessageId, undefined);
});
