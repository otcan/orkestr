import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as age from "age-encryption";
import { syntheticWorkbook } from "./fixtures/synthetic-workbook.js";
import { requiredOutboundSnapshots, snapshotRoutedAttachments, validateOutboundSnapshots } from "../packages/core/src/outbound-attachment-snapshots.js";
import { resolveThreadAttachments } from "../packages/core/src/thread-attachments.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { registerAttachmentEncryptionRecipient, verifyAttachmentEncryptionRecipient, setAttachmentEncryptionPolicy } from "../packages/core/src/attachment-encryption-registry.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies, sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outbound-snapshot-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  const thread = await createThread({ id: "snapshot-thread", name: "Snapshot test", ownerUserId: "admin",
    binding: { connector: "whatsapp", chatId: "synthetic-chat", responderAccountId: "synthetic-account",
      outboundAccountId: "synthetic-account", mirrorToWhatsApp: true } }, env);
  const source = path.join(home, "report.xlsx");
  const bytes = Buffer.from(syntheticWorkbook);
  await fs.writeFile(source, bytes);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.example.invalid" }, env);
  return { home, env, thread, source, bytes };
}

async function enableEncryption(env) {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const pending = await registerAttachmentEncryptionRecipient({ recipient, label: "Synthetic browser" }, { userId: "admin" }, env);
  const decrypter = new age.Decrypter(); decrypter.addIdentity(identity);
  const proof = await decrypter.decrypt(Buffer.from(pending.key.challenge.ciphertext, "base64"), "text");
  await verifyAttachmentEncryptionRecipient(pending.key.id, proof, { userId: "admin" }, env);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "admin" }, env);
}

for (const encrypted of [false, true]) test(`routed document survives original removal with encryption=${encrypted}`, async t => {
  const { env, thread, source, bytes } = await fixture(t);
  if (encrypted) await enableEncryption(env);
  const parent = await appendThreadMessage(thread.id, { role: "user", source: "whatsapp_inbound", connector: "whatsapp",
    chatId: "synthetic-chat", text: "Send document", state: "completed" }, env);
  const text = `Document: [report.xlsx](${source})`;
  const reply = await appendThreadMessage(thread.id, { role: "assistant", source: "codex-app-server", connector: "whatsapp",
    chatId: "synthetic-chat", phase: "final_answer", state: "completed", parentMessageId: parent.id, text }, env);
  const stored = (await listThreadMessages(thread.id, env)).find(x => x.id === reply.id);
  const snapshot = encrypted ? stored.attachments[0].deliverySource : stored.attachments[0];
  assert.notEqual(snapshot.path, source);
  assert.match(snapshot.path, /uploads\/snapshot-thread\/artifacts\//);
  assert.equal((await fs.stat(snapshot.path)).mode & 0o777, 0o600);
  await fs.rm(source);
  // Exercise persisted metadata again after the original producer file is gone.
  await updateThreadMessage(thread.id, reply.id, { text: text + "\nReady." }, env);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      calls.push({ url: new URL(url), body });
      assert.equal(body.paths.length, 1);
      assert.deepEqual(await fs.readFile(body.paths[0]), bytes);
    }
    return new Response(JSON.stringify({ ok: true, ids: ["synthetic-media-ack"] }), { headers: { "content-type": "application/json" } });
  };
  const result = await deliverWhatsAppReplies(env, fetchImpl);
  assert.equal(result.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.doesNotMatch(calls[0].body.text, /Attachment not sent|protected attachment/);
  assert.ok(calls[0].body.text.includes(text));
  const outbox = await readConnectorOutbox(env);
  const jobs = Array.isArray(outbox) ? outbox : outbox.jobs;
  assert.ok(jobs.some(job => job.state === "delivered" && job.payload.attachments.length === 1));
  const duplicate = await deliverWhatsAppReplies(env, async () => { throw new Error("duplicate send"); });
  assert.equal(duplicate.delivered.length, 0);
});

for (const encrypted of [false, true]) test(`missing snapshot remains retryable until restored with encryption=${encrypted}`, async t => {
  const { env, thread, source, bytes } = await fixture(t);
  env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS = "0";
  if (encrypted) await enableEncryption(env);
  const parent = await appendThreadMessage(thread.id, { role: "user", connector: "whatsapp", source: "whatsapp_inbound",
    chatId: "synthetic-chat", text: "Document please", state: "completed" }, env);
  const reply = await appendThreadMessage(thread.id, { role: "assistant", connector: "whatsapp", source: "codex-app-server",
    chatId: "synthetic-chat", parentMessageId: parent.id, phase: "final_answer", state: "completed",
    text: `[report](${source})` }, env);
  const snapshot = encrypted ? reply.attachments[0].deliverySource : reply.attachments[0];
  await fs.rm(snapshot.path);
  await assert.rejects(updateThreadMessage(thread.id, reply.id, { text: reply.text + "\nEdited" }, env), /snapshot_integrity_failed/);
  let calls = 0;
  const forbidden = async () => { calls++; throw new Error("must not send text-only"); };
  const failed = await deliverWhatsAppReplies(env, forbidden);
  assert.equal(failed.delivered.length, 0);
  assert.equal(failed.failed.length, 1);
  assert.match(failed.failed[0].error, /snapshot_integrity_failed/);
  assert.equal(calls, 0);
  const jobs = (await readConnectorOutbox(env)).jobs;
  const job = jobs.find(item => item.sourceMessageId === reply.id);
  assert.equal(job.state, "failed_retryable");
  assert.equal(job.payload.requiredAttachmentSnapshots[0].outboundSnapshot.sha256, snapshot.outboundSnapshot.sha256);
  const persisted = (await listThreadMessages(thread.id, env)).find(item => item.id === reply.id);
  assert.match(persisted.deliveryError, /snapshot_integrity_failed/);
  assert.equal(persisted.attachments.length, 1);
  // The original still exists, but retry must not silently substitute it.
  await deliverWhatsAppReplies(env, forbidden);
  assert.equal(calls, 0);
  await fs.writeFile(snapshot.path, bytes, { mode: 0o600 });
  const recovered = await deliverWhatsAppReplies(env, async (url, options) => {
    if (options?.method !== "POST") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    calls++;
    assert.equal(new URL(url).pathname, "/send-media");
    assert.deepEqual(JSON.parse(options.body).paths, [snapshot.path]);
    return new Response(JSON.stringify({ ok: true, ids: ["synthetic-recovery-ack"] }), { headers: { "content-type": "application/json" } });
  });
  assert.equal(recovered.delivered.length, 1);
  assert.equal(calls, 1);
  const duplicate = await deliverWhatsAppReplies(env, forbidden);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls, 1);
});

test("snapshot and live source do not become duplicate attachments", async t => {
  const { env, thread, source } = await fixture(t);
  const snapshot = await snapshotRoutedAttachments({ thread, message: { role: "assistant", connector: "whatsapp" },
    attachments: [{ path: source, filename: "report.xlsx" }], env });
  const resolved = await resolveThreadAttachments({ thread, attachments: snapshot, text: `[report](${source})`, env });
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.skipped.length, 0);
  assert.deepEqual(await snapshotRoutedAttachments({ thread, message: { role: "assistant" }, attachments: snapshot, env }), snapshot);
});

test("changed snapshot fails before any bridge operation", async t => {
  const { env, thread, source } = await fixture(t);
  const attachments = await snapshotRoutedAttachments({ thread, message: { role: "assistant" }, attachments: [{ path: source }], env });
  await fs.writeFile(attachments[0].path, "changed");
  let calls = 0;
  await assert.rejects(sendWhatsAppText({ chatId: "synthetic-chat", text: "Document", attachments, env,
    fetchImpl: async () => { calls++; } }), /snapshot_integrity_failed/);
  assert.equal(calls, 0);
});

test("bridge size limits cannot downgrade a snapshot to text-only", async t => {
  const { env, thread, source } = await fixture(t);
  const attachments = await snapshotRoutedAttachments({ thread, message: { role: "assistant" }, attachments: [{ path: source }], env });
  let calls = 0;
  for (const local of [false, true]) {
    await assert.rejects(sendWhatsAppText({ chatId: "synthetic-chat", text: "Document", attachments,
      config: local ? { bridgeMode: "local" } : { bridgeMode: "external", bridgeUrl: "http://wa.example.invalid" },
      env: { ...env, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "0",
        ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_INLINE_ATTACHMENT_MAX_BYTES: "1", ORKESTR_WHATSAPP_LOCAL_BRIDGE_ATTACHMENT_MAX_BYTES: "1" },
      fetchImpl: async () => { calls++; },
    }), /snapshot_not_sendable/);
  }
  assert.equal(calls, 0);
});

test("remote bridge receives inline workbook bytes from the surviving snapshot", async t => {
  const { env, thread, source, bytes } = await fixture(t);
  const attachments = await snapshotRoutedAttachments({ thread, message: { role: "assistant" }, attachments: [{ path: source }], env });
  await fs.rm(source);
  let sent = 0;
  await sendWhatsAppText({ chatId: "synthetic-chat", text: "Document", attachments,
    env: { ...env, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "0" },
    fetchImpl: async (url, options) => {
      if (options?.method === "POST") {
        sent++;
        assert.equal(new URL(url).pathname, "/send-media");
        const body = JSON.parse(options.body);
        assert.equal(body.paths, undefined);
        assert.equal(body.attachments.length, 1);
        assert.deepEqual(Buffer.from(body.attachments[0].data, "base64"), bytes);
      }
      return new Response(JSON.stringify({ ok: true, ids: ["synthetic-inline-ack"] }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(sent, 1);
});

test("snapshot scope, source symlinks and size bounds fail closed", async t => {
  const { env, thread, source, home } = await fixture(t);
  const run = (attachments, extra = {}) => snapshotRoutedAttachments({ thread, message: { role: "assistant" }, attachments, env, ...extra });
  const attachments = await run([{ path: source }]);
  await assert.rejects(run(attachments, { thread: { ...thread, ownerUserId: "other-owner" } }), /snapshot_integrity_failed/);
  const symlink = path.join(home, "linked.xlsx"); await fs.symlink(source, symlink);
  await assert.rejects(run([{ path: symlink }]), /snapshot_attachment_path_changed/);
  await assert.rejects(run([{ path: source }], { env: { ...env, ORKESTR_THREAD_ATTACHMENT_MAX_BYTES: "4" } }), /snapshot_attachment_too_large/);
  await fs.rm(attachments[0].path);
  await assert.rejects(validateOutboundSnapshots(attachments, env), /snapshot_integrity_failed/);
});

test("inbound and non-routed messages retain their original paths", async t => {
  const { env, thread, source } = await fixture(t);
  const attachments = [{ path: source }];
  assert.equal(await snapshotRoutedAttachments({ thread, message: { role: "user" }, attachments, env }), attachments);
  assert.equal(await snapshotRoutedAttachments({ thread: { ...thread, binding: null }, message: { role: "assistant" }, attachments, env }), attachments);
  assert.deepEqual(requiredOutboundSnapshots(null), []);
  assert.deepEqual(requiredOutboundSnapshots([null, {}]), []);
});
