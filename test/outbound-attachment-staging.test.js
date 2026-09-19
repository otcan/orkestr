import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syntheticWorkbook } from "./fixtures/synthetic-workbook.js";
import { createThread, appendThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { recoverRoutedReplyAttachments, cleanupOutboundStagingJournals, stagingFailureNotice } from "../packages/core/src/outbound-attachment-staging.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { publicEncryptedAttachmentMessage } from "../packages/core/src/encrypted-attachment-projection.js";
import { createHash } from "node:crypto";
import * as age from "age-encryption";
import { registerAttachmentEncryptionRecipient, verifyAttachmentEncryptionRecipient, setAttachmentEncryptionPolicy } from "../packages/core/src/attachment-encryption-registry.js";

async function fixture(t, phase = "final_answer") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-staging-intent-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0", ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" };
  const thread = await createThread({ id: "staging-thread", ownerUserId: "admin", name: "Synthetic staging",
    binding: { connector: "whatsapp", chatId: "synthetic-chat", responderAccountId: "synthetic-account", outboundAccountId: "synthetic-account", mirrorToWhatsApp: true } }, env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.example.invalid" }, env);
  const parent = await appendThreadMessage(thread.id, { role: "user", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-chat", state: "completed", text: "Document please" }, env);
  const source = path.join(home, "synthetic.xlsx");
  const reply = () => appendThreadMessage(thread.id, { role: "assistant", source: "codex-app-server", connector: "whatsapp", chatId: "synthetic-chat",
    parentMessageId: parent.id, state: "completed", phase, text: `Document: [workbook](${source})` }, env);
  return { home, env, thread, source, reply };
}

for (const phase of ["final_answer", "commentary"]) for (const fault of ["missing_source", "copy_failure"]) test(`${phase}: initial ${fault} preserves reply and durable retry across reload`, async t => {
  const f = await fixture(t, phase);
  const artifactDir = path.join(f.home, "uploads", f.thread.id, "artifacts");
  if (fault === "copy_failure") {
    await fs.writeFile(f.source, syntheticWorkbook);
    await fs.mkdir(path.dirname(artifactDir), { recursive: true });
    await fs.writeFile(artifactDir, "synthetic blocking file");
  }
  const reply = await f.reply();
  const journalDir = path.join(f.home, "outbound-attachment-staging", createHash("sha256").update(`admin\n${f.thread.id}`).digest("hex"));
  assert.equal((await fs.stat(journalDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(journalDir, `${reply.outboundAttachmentStaging.id}.json`))).mode & 0o777, 0o600);
  assert.equal(reply.state, "completed");
  assert.equal(reply.outboundAttachmentStaging.state, "failed_retryable");
  assert.equal(reply.deliveryError, stagingFailureNotice);
  assert.equal(reply.attachments, undefined);
  const projected = publicEncryptedAttachmentMessage(reply);
  assert.deepEqual(Object.keys(projected.outboundAttachmentStaging).sort(), ["id", "notice", "state"]);
  let sends = 0;
  const blocked = await deliverWhatsAppReplies(f.env, async () => { sends++; throw new Error("no transport while staging fails"); });
  assert.equal(blocked.failed.length, 1);
  assert.equal(blocked.delivered.length, 0);
  assert.equal(sends, 0);
  assert.equal((await readConnectorOutbox(f.env)).jobs.some(job => job.state === "failed_retryable"), true);
  const stored = (await listThreadMessages(f.thread.id, f.env)).find(item => item.id === reply.id);
  assert.equal(stored.outboundAttachmentStaging.id, reply.outboundAttachmentStaging.id);
  assert.deepEqual((await cleanupOutboundStagingJournals(f.thread, [], f.env, { minAgeMs: 0 })).eligible, []);
  if (fault === "copy_failure") await fs.unlink(artifactDir);
  else await fs.writeFile(f.source, syntheticWorkbook);
  const recovered = await deliverWhatsAppReplies(f.env, async (url, options) => {
    if (options?.method === "POST") {
      sends++;
      assert.equal(new URL(url).pathname, "/send-media");
      const body = JSON.parse(options.body);
      assert.equal(body.paths.length, 1);
      assert.deepEqual(await fs.readFile(body.paths[0]), syntheticWorkbook);
    }
    return new Response(JSON.stringify({ ok: true, ids: ["synthetic-staging-ack"] }), { headers: { "content-type": "application/json" } });
  });
  assert.equal(recovered.delivered.length, 1);
  assert.equal(sends, 1);
  const final = (await listThreadMessages(f.thread.id, f.env)).find(item => item.id === reply.id);
  assert.equal(final.outboundAttachmentStaging.state, "ready");
  assert.equal(final.deliveryState, "delivered");
  const cleanup = await cleanupOutboundStagingJournals(f.thread, [final], f.env, { minAgeMs: 0 });
  assert.equal(cleanup.eligible.includes(final.outboundAttachmentStaging.id), false);
  assert.deepEqual(cleanup.deleted, []);
  const duplicate = await deliverWhatsAppReplies(f.env, async () => { throw new Error("duplicate delivery"); });
  assert.equal(duplicate.delivered.length, 0);
});

test("staging journal cannot be reused for a different owner, message or edited text", async t => {
  const f = await fixture(t), reply = await f.reply();
  await fs.writeFile(f.source, syntheticWorkbook);
  await assert.rejects(recoverRoutedReplyAttachments({ ...f.thread, ownerUserId: "other" }, reply, f.env), /binding_mismatch/);
  await assert.rejects(recoverRoutedReplyAttachments(f.thread, { ...reply, id: "other-message" }, f.env), /binding_mismatch/);
  await assert.rejects(recoverRoutedReplyAttachments(f.thread, { ...reply, text: "edited" }, f.env), /binding_mismatch/);
  assert.equal((await recoverRoutedReplyAttachments(f.thread, reply, f.env)).staging.state, "ready");
});

test("failed staging recovery respects persisted retry delay across mirror polls", async t => {
  const f = await fixture(t);
  f.env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS = "60000";
  const reply = await f.reply();
  await fs.writeFile(f.source, syntheticWorkbook);
  assert.equal((await recoverRoutedReplyAttachments(f.thread, reply, f.env)).staging.state, "failed_retryable");
  const root = path.join(f.home, "outbound-attachment-staging");
  const [dir] = await fs.readdir(root);
  const journal = JSON.parse(await fs.readFile(path.join(root, dir, `${reply.outboundAttachmentStaging.id}.json`), "utf8"));
  assert.equal(journal.attempts, 1);
  assert.ok(Date.parse(journal.nextAttemptAt) > Date.now());
});

test("required-encryption publication failure preserves snapshot without plaintext publication", async t => {
  const f = await fixture(t);
  const identity = await age.generateIdentity();
  const pending = await registerAttachmentEncryptionRecipient({ recipient: await age.identityToRecipient(identity), label: "Synthetic browser" }, { userId: "admin" }, f.env);
  const decrypt = new age.Decrypter(); decrypt.addIdentity(identity);
  await verifyAttachmentEncryptionRecipient(pending.key.id, await decrypt.decrypt(Buffer.from(pending.key.challenge.ciphertext, "base64"), "text"), { userId: "admin" }, f.env);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "admin" }, f.env);
  await fs.writeFile(f.source, syntheticWorkbook);
  const published = path.join(f.home, "uploads", f.thread.id, "published");
  await fs.mkdir(path.dirname(published), { recursive: true });
  await fs.writeFile(published, "synthetic publication blocker");
  const reply = await f.reply();
  assert.equal(reply.outboundAttachmentStaging.state, "failed_retryable");
  assert.equal(reply.attachments, undefined);
  await fs.unlink(f.source); // Recovery must use the already-journaled snapshot.
  await fs.unlink(published);
  const recovered = await recoverRoutedReplyAttachments(f.thread, reply, f.env);
  assert.equal(recovered.staging.state, "ready");
  assert.equal(recovered.attachments.length, 1);
  assert.equal(recovered.attachments[0].encrypted, true);
  assert.deepEqual(await fs.readFile(recovered.attachments[0].deliverySource.path), syntheticWorkbook);
  const visible = publicEncryptedAttachmentMessage({ ...reply, attachments: recovered.attachments });
  assert.equal(visible.attachments[0].deliverySource, undefined);
  assert.equal(visible.attachments[0].path, undefined);
});
