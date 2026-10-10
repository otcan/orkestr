import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import {
  deliveredTextStillCoversCurrent,
  deliveryTypeCarriesSourceAttachments,
  sourceTextUnchangedSinceDelivery,
  whatsappSourceTextHash,
} from "../packages/connectors/src/whatsapp-mutation-notice-policy.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

const reportText = "Here is the report.\n\n| Item | Count |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |";
const ok = (payload) => ({ ok: true, status: 200, async json() { return payload; } });

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-mutation-notice-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.example.invalid" }, env);
  await createThread({
    id: "thread-mutation-notice",
    ownerUserId: "tenant-a",
    name: "Mutation Notice Fixture",
    binding: { connector: "whatsapp", chatId: "chat-fixture", responderAccountId: "responder", outboundAccountId: "responder", mirrorToWhatsApp: true },
  }, env);
  const parent = await appendThreadMessage("thread-mutation-notice", {
    role: "user", source: "whatsapp_inbound", state: "completed", connector: "whatsapp", chatId: "chat-fixture", accountId: "responder", text: "fixture?",
  }, env);
  return { env, parent };
}

test("attachment-only edits send no correction when the delivered text was transformed", async (t) => {
  const { env, parent } = await fixture(t);
  const reply = await appendThreadMessage("thread-mutation-notice", {
    role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    parentMessageId: parent.id, chatId: "chat-fixture", accountId: "responder",
    text: reportText,
  }, env);
  const sent = [];
  await deliverWhatsAppReplies(env, async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return ok({ ok: true, ids: ["wa-fixture-original"] });
  });
  assert.equal(sent.length, 1);
  // Preparation moved the table into a CSV file, so the delivered text
  // differs from the raw message text.
  assert.doesNotMatch(sent[0].text, /\| --- \|/);

  await updateThreadMessage("thread-mutation-notice", reply.id, {
    attachments: [{ name: "extra.txt", path: path.join(os.tmpdir(), "orkestr-missing-fixture", "extra.txt"), size: 10 }],
  }, env);
  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return ok({ ok: true, ids: ["wa-fixture-unexpected"] });
  });
  const outbox = await readConnectorOutbox(env);
  assert.equal(calls.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(outbox.jobs.some((job) => job.sourceMessageId === reply.id && job.deliveryType === "edit_notice"), false);
});

test("text edits after an attachment reply still send one correction notice", async (t) => {
  const { env, parent } = await fixture(t);
  const reply = await appendThreadMessage("thread-mutation-notice", {
    role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    parentMessageId: parent.id, chatId: "chat-fixture", accountId: "responder",
    text: "Original answer.",
    attachments: [{ name: "report.csv", path: path.join(os.tmpdir(), "orkestr-missing-fixture", "report.csv"), size: 10 }],
  }, env);
  await deliverWhatsAppReplies(env, async () => ok({ ok: true, ids: ["wa-fixture-original"] }));
  await updateThreadMessage("thread-mutation-notice", reply.id, { text: "Corrected answer." }, env);
  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return ok({ ok: true, ids: ["wa-fixture-correction"] });
  });
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^Correction to my previous message:/);
});

test("mutation notice policy helpers", () => {
  assert.equal(deliveryTypeCarriesSourceAttachments("final"), true);
  assert.equal(deliveryTypeCarriesSourceAttachments("progress"), true);
  assert.equal(deliveryTypeCarriesSourceAttachments("edit_notice"), false);
  assert.equal(deliveryTypeCarriesSourceAttachments("delete_notice"), false);
  const delivery = { sourceTextHash: whatsappSourceTextHash("Same text") };
  assert.equal(sourceTextUnchangedSinceDelivery(delivery, { text: " Same text " }), true);
  assert.equal(sourceTextUnchangedSinceDelivery(delivery, { text: "Other text" }), false);
  assert.equal(sourceTextUnchangedSinceDelivery({}, { text: "Same text" }), null);
  assert.equal(deliveredTextStillCoversCurrent("Body\n\nNote: file unavailable", "Body"), true);
  assert.equal(deliveredTextStillCoversCurrent("Body extended", "Body"), false);
  assert.equal(deliveredTextStillCoversCurrent("", "Body"), false);
});
