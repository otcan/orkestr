import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syntheticWorkbook } from "./fixtures/synthetic-workbook.js";
import { requiredOutboundSnapshots } from "../packages/core/src/outbound-attachment-snapshots.js";
import { appendThreadMessage, createThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

// A correction notice is text-only. It must not inherit the edited reply's
// staged-attachment obligations, or every notice for a reply with a file
// fails with outbound_attachment_snapshot_not_sendable and is retried.
test("text-only correction notices for a staged-attachment reply are sendable", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-notice-snapshot-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  const thread = await createThread({ id: "notice-snapshot-thread", name: "Notice snapshot", ownerUserId: "admin",
    binding: { connector: "whatsapp", chatId: "synthetic-chat", responderAccountId: "synthetic-account",
      outboundAccountId: "synthetic-account", mirrorToWhatsApp: true } }, env);
  const source = path.join(home, "report.xlsx");
  await fs.writeFile(source, Buffer.from(syntheticWorkbook));
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.example.invalid" }, env);
  const parent = await appendThreadMessage(thread.id, { role: "user", connector: "whatsapp", source: "whatsapp_inbound",
    chatId: "synthetic-chat", text: "Document please", state: "completed" }, env);
  const reply = await appendThreadMessage(thread.id, { role: "assistant", connector: "whatsapp", source: "codex-app-server",
    chatId: "synthetic-chat", parentMessageId: parent.id, phase: "final_answer", state: "completed", text: "Document ready.",
    attachments: [{ path: source, filename: "report.xlsx" }] }, env);
  assert.ok(requiredOutboundSnapshots(reply.attachments).length > 0);

  const posts = [];
  const bridge = async (_url, options = {}) => {
    if (options.method !== "POST") return new Response(JSON.stringify({ ok: true, ready: true }), { headers: { "content-type": "application/json" } });
    posts.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, ids: [`wa-synthetic-${posts.length}`] }), { headers: { "content-type": "application/json" } });
  };
  await deliverWhatsAppReplies(env, bridge);
  assert.equal(posts.length, 1);

  await updateThreadMessage(thread.id, reply.id, { text: "Document ready (corrected)." }, env);
  const result = await deliverWhatsAppReplies(env, bridge);
  const outbox = await readConnectorOutbox(env);
  const notice = outbox.jobs.find((job) => job.sourceMessageId === reply.id && job.deliveryType === "edit_notice");

  assert.deepEqual(result.failed.map((item) => item.error), []);
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /^Correction to my previous message:/);
  assert.equal(notice?.state, "delivered");
  assert.equal(notice.payload?.requiredAttachmentSnapshots, undefined);
});
