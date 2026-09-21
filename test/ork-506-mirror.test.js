import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, appendThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { hydrateCodexAppServerThreadMessages } from "../packages/core/src/codex-app-server.js";
import { reconcileCodexFinalProjection } from "../packages/core/src/codex-final-projection.js";
import { createThreadMessageRepository } from "../packages/storage/src/repositories.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";

const response = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });

for (const outcome of ["delivered", "partial_delivery", "delivery_uncertain"]) test(`one native final plus three files: copied projections preserve ${outcome}`, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-506-mirror-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "0",
    ORKESTR_CODEX_ROLLOUT_GENERATION_MODE: "off" };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.invalid" }, env);
  const thread = await createThread({ id: "mirror", ownerUserId: "tenant-a", name: "Synthetic mirror", cwd: home,
    executor: { id: "codex", codexThreadId: "gen-a" },
    binding: { connector: "whatsapp", chatId: "chat-a", responderAccountId: "account-a", outboundAccountId: "account-a", mirrorToWhatsApp: true } }, env);
  const parent = await appendThreadMessage(thread.id, { role: "user", source: "whatsapp_inbound", text: "Synthetic request",
    state: "completed", connector: "whatsapp", chatId: "chat-a", accountId: "account-a", codexThreadId: "gen-a", codexTurnId: "turn-a" }, env);
  const attachments = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(home, `sample-${i}.txt`);
    await fs.writeFile(file, `Synthetic attachment ${i}`);
    attachments.push({ path: file, filename: `sample-${i}.txt`, mimeType: "text/plain" });
  }
  const answer = await appendThreadMessage(thread.id, { role: "assistant", source: "codex-app-server", phase: "final_answer",
    state: "completed", text: "Synthetic final", parentMessageId: parent.id, connector: "whatsapp", chatId: "chat-a", accountId: "account-a",
    codexThreadId: "gen-a", codexTurnId: "turn-a", codexItemId: "answer-a", eventId: "native-event", attachments }, env);
  await reconcileCodexFinalProjection({ thread, message: answer, runtimeGeneration: "gen-a", env });
  const sends = [];
  const transport = async (url, options) => {
    if (url.pathname === "/health") return response({ ok: true, ready: true, accounts: [{ id: "account-a", ready: true }] });
    sends.push(JSON.parse(options.body));
    if (outcome === "partial_delivery") return response({ ok: false, error: "whatsapp_partial_delivery",
      partialDelivery: { sent: [{ id: "text-receipt", kind: "text" }], attachments: [{ index: 0, outcome: "uncertain" },
        { index: 1, outcome: "not_attempted" }, { index: 2, outcome: "not_attempted" }], failedKind: "attachment", failureCode: "provider_evaluation_failed" } }, 409);
    if (outcome === "delivery_uncertain") throw new TypeError("fetch failed");
    return response({ ok: true, ids: ["text-receipt", "file-0", "file-1", "file-2"] });
  };
  await deliverWhatsAppReplies(env, transport);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].attachments.length, 3);
  const first = (await readConnectorOutbox(env)).jobs.find(job => job.deliveryType === "final");
  assert.equal(first.state, outcome);
  // Seed already-corrupt historical aliases without weakening normal writers.
  const repository = createThreadMessageRepository(env);
  const stored = await listThreadMessages(thread.id, env);
  const copies = Array.from({ length: 3 }, (_, i) => ({ ...answer, id: `copied-output-${i}`, parentMessageId: `copied-input-${i}`,
    source: "codex-app-server-import", eventId: "history-event", cursor: 100 + i, text: "Synthetic  final",
    mirrorOutboxJobId: null, finalProjectionConnectorSignaledAt: null }));
  await repository.save(thread.id, [...stored, ...copies]);
  for (const message of copies) await reconcileCodexFinalProjection({ thread, message, runtimeGeneration: "gen-a", env });
  const history = { id: "gen-a", turns: [{ id: "turn-a", items: [{ type: "agentMessage", id: "answer-a", phase: "final_answer", text: "Synthetic final" }] }] };
  await hydrateCodexAppServerThreadMessages(thread, history, env);
  for (let i = 0; i < 3; i++) await deliverWhatsAppReplies(env, transport);
  assert.equal(sends.length, 1, "neither text nor media may be resent");
  const finals = (await readConnectorOutbox(env)).jobs.filter(job => job.deliveryType === "final");
  assert.equal(finals.length, 1); assert.equal(finals[0].id, first.id);
  assert.equal(finals[0].state, outcome); assert.deepEqual(finals[0].brokerAck, first.brokerAck);
});
