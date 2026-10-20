import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverWhatsAppReplies, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { remoteMirrorAckReport } from "../packages/connectors/src/whatsapp-remote-mirror-ack.js";
import { remoteAttachmentFilename, remoteAttachmentMediaType } from "../packages/connectors/src/whatsapp-remote-attachment-upload.js";
import { shouldMirrorWhatsAppProgress, shouldMirrorWhatsAppReply } from "../packages/connectors/src/whatsapp-mirror-policy.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

// A synthetic acknowledging runtime: replies stay listed until a terminal report.
async function fixture(t, { binding = {}, backend = {}, mirrorAck = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mirror-ack-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const env = {
    HOME: home,
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "sqlite",
    ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      example: { baseUrl: "http://runtime.example.test", token: "public-test-token", ...backend },
    }),
  };
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external", bridgeUrl: "http://bridge.example.test", apiToken: "public-test-token",
  }, env);
  await createThread({
    id: "example-thread", name: "Example thread",
    binding: {
      connector: "whatsapp", chatId: "example-chat", responderAccountId: "example-account",
      remoteBackend: "example", remoteThreadId: "example-remote-thread", ...binding,
    },
  }, env);
  const runtime = { inputs: [], uploads: [], acks: [], exports: [], rejectAcks: 0, failAcks: 0, user: null };
  const sends = [];
  let sequence = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "runtime.example.test") {
      const body = options.body ? JSON.parse(options.body) : null;
      if (parsed.pathname.endsWith("/attachments")) {
        runtime.uploads.push(body);
        return Response.json({ ok: true, upload: { uploadId: `upload-${runtime.uploads.length}`, sha256: body.sha256 } }, { status: 201 });
      }
      if (parsed.pathname.endsWith("/input")) {
        runtime.inputs.push(body);
        runtime.user = {
          id: "example-remote-user", role: "user", source: "whatsapp_inbound", connector: "whatsapp",
          publicMessageId: body.publicMessageId, publicThreadId: body.publicThreadId, state: "delivered",
        };
        return Response.json({ ok: true, message: { id: runtime.user.id, state: "delivered", deliveryState: "delivered" } }, { status: 202 });
      }
      if (parsed.pathname.endsWith("/mirror-acks")) {
        if (runtime.failAcks > 0) {
          runtime.failAcks -= 1;
          return Response.json({ ok: false, error: "synthetic_unavailable" }, { status: 503 });
        }
        if (runtime.rejectAcks > 0) {
          runtime.rejectAcks -= 1;
          return Response.json({ ok: false, error: "ack_conflict" }, { status: 409 });
        }
        runtime.acks.push(body);
        const row = runtime.exports.find((item) => item.id === body.remoteMessageId);
        if (["delivered", "suppressed", "no_reply", "failed"].includes(body.outcome)) row.acked = body.outcome;
        return Response.json({ ok: true, sequence: row.exportSequence, ackedThrough: row.exportSequence });
      }
      if (parsed.pathname.endsWith("/messages")) {
        const rows = runtime.user ? [runtime.user, ...runtime.exports.filter((row) => !row.acked)] : [];
        return Response.json({ ok: true, messages: rows, ...(mirrorAck ? { mirrorAck: { version: 1, ackedThrough: 0 } } : {}) });
      }
    }
    if (parsed.host === "bridge.example.test" && parsed.pathname === "/send-text") {
      sends.push(JSON.parse(options.body));
      return Response.json({ ok: true, ids: [`example-sent-${sends.length}`] });
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  const exportRow = (row) => {
    sequence += 1;
    runtime.exports.push({
      role: "assistant", state: "completed", parentMessageId: "example-remote-user", exportSequence: sequence,
      source: "rust-v2-pilot", ...row,
    });
  };
  const route = (extra = {}) => routeWhatsAppInbound({
    eventId: "example-source-event", chatId: "example-chat", accountId: "example-account",
    from: "example-participant@lid", text: "An exact synthetic input.", ...extra,
  }, env, fetchImpl);
  return { env, home, runtime, sends, fetchImpl, exportRow, route };
}

const deliver = (f) => deliverWhatsAppReplies(f.env, f.fetchImpl);

test("a delivered reply is acknowledged once with its outbox receipt and then stays settled", async t => {
  const f = await fixture(t);
  const routed = await f.route();
  f.exportRow({ id: "example-final", phase: "final_answer", text: "The accepted synthetic answer." });
  await deliver(f);
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.acks.length, 0, "no report before the outbox decided");
  await deliver(f);
  assert.equal(f.runtime.acks.length, 1);
  const [ack] = f.runtime.acks;
  assert.equal(ack.outcome, "delivered");
  assert.equal(ack.remoteMessageId, "example-final");
  assert.equal(ack.parentPublicMessageId, routed.message.id);
  assert.equal(ack.publicThreadId, "example-thread");
  assert.ok(ack.outboxJobId);
  assert.deepEqual(ack.connectorMessageIds, ["example-sent-1"]);
  await deliver(f);
  assert.equal(f.runtime.acks.length, 1);
  assert.equal(f.sends.length, 1);
  const reply = (await listThreadMessages("example-thread", f.env)).find((row) => row.role === "assistant");
  assert.equal(reply.remoteMirrorAck.outcome, "delivered");
  assert.equal(reply.remoteExportSequence, "1");
});

test("an exact NO_REPLY is never sent and is acknowledged as no_reply", async t => {
  const f = await fixture(t);
  await f.route();
  f.exportRow({ id: "example-silent", phase: "final_answer", text: "NO_REPLY", noReply: true });
  await deliver(f);
  await deliver(f);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.runtime.acks.map((ack) => ack.outcome), ["no_reply"]);
});

test("remote progress follows the thread's update suppression and is reported", async t => {
  for (const suppress of [false, true]) {
    await t.test(`suppressWhatsAppUpdates=${suppress}`, async (t) => {
      const f = await fixture(t, { binding: suppress ? { suppressWhatsAppUpdates: true } : {} });
      await f.route();
      f.exportRow({ id: "example-progress", kind: "progress", phase: "commentary", text: "Still working." });
      await deliver(f);
      await deliver(f);
      assert.equal(f.sends.length, suppress ? 0 : 1);
      assert.deepEqual(f.runtime.acks.map((ack) => ack.outcome), [suppress ? "suppressed" : "delivered"]);
      f.exportRow({ id: "example-final", phase: "final_answer", text: "Finished." });
      await deliver(f);
      await deliver(f);
      assert.equal(f.sends.at(-1).text.includes("Finished."), true);
      assert.equal(f.runtime.acks.at(-1).outcome, "delivered");
    });
  }
});

test("a runtime without mirror acknowledgement support receives no reports", async t => {
  const f = await fixture(t, { mirrorAck: false });
  await f.route();
  f.exportRow({ id: "example-final", phase: "final_answer", text: "Answer." });
  await deliver(f);
  await deliver(f);
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.acks.length, 0);
});

test("transient report failures retry; definite refusals are recorded and not resubmitted", async t => {
  const f = await fixture(t);
  await f.route();
  f.exportRow({ id: "example-final", phase: "final_answer", text: "Answer." });
  await deliver(f);
  f.runtime.failAcks = 1;
  await deliver(f);
  assert.equal(f.runtime.acks.length, 0);
  f.runtime.rejectAcks = 1;
  await deliver(f);
  await deliver(f);
  assert.equal(f.runtime.acks.length, 0);
  const reply = (await listThreadMessages("example-thread", f.env)).find((row) => row.role === "assistant");
  assert.equal(reply.remoteMirrorAck.rejected, "ack_conflict");
  assert.equal(f.sends.length, 1, "a refused report never causes another send");
});

test("accepted inbound files are uploaded by content and referenced without local paths", async t => {
  const f = await fixture(t, { backend: { attachmentUpload: true } });
  const media = path.join(f.home, "whatsapp-bridge", "inbound-media");
  await fs.mkdir(media, { recursive: true });
  const file = path.join(media, "photo.jpg");
  const content = Buffer.from("synthetic image bytes");
  await fs.writeFile(file, content);
  await f.route({ attachments: [{ path: file, filename: "photo.jpg", mimetype: "image/jpeg", kind: "image" }] });
  assert.equal(f.runtime.uploads.length, 1);
  const [upload] = f.runtime.uploads;
  assert.equal(upload.filename, "photo.jpg");
  assert.equal(upload.mediaType, "image/jpeg");
  assert.equal(upload.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.equal(Buffer.from(upload.contentBase64, "base64").equals(content), true);
  const [input] = f.runtime.inputs;
  assert.deepEqual(input.attachments, [{ uploadId: "upload-1", sha256: upload.sha256 }]);
  assert.equal(JSON.stringify(input).includes(f.home), false);
});

test("report mapping uses only existing delivery evidence", () => {
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x" }), null);
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x", deliveryState: "delivered" }), null);
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x", deliveryState: "mirror_claimed" }), null);
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x", deliveryState: "failed_retryable" }), null);
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x", deliveryState: "delivery_uncertain" }).outcome, "uncertain");
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x", deliveryState: "partial_delivery" }).outcome, "failed");
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: "x" }, { status: "skipped", error: "updates_suppressed" }).reason, "updates_suppressed");
  assert.equal(remoteMirrorAckReport({ role: "assistant", text: " NO_REPLY " }).outcome, "no_reply");
});

test("only explicitly remote progress changes mirror policy", () => {
  const progress = { role: "assistant", remoteKind: "progress", remoteMessageId: "r", phase: "commentary", text: "x" };
  assert.equal(shouldMirrorWhatsAppProgress(progress), true);
  assert.equal(shouldMirrorWhatsAppReply(progress), false);
  const remoteCommentary = { role: "assistant", remoteMessageId: "r", phase: "commentary", text: "x" };
  assert.equal(shouldMirrorWhatsAppProgress(remoteCommentary), false);
  assert.equal(shouldMirrorWhatsAppReply(remoteCommentary), true);
  assert.equal(remoteAttachmentFilename("../a:b\u0001.txt"), "a_b_.txt");
  assert.equal(remoteAttachmentMediaType("image/jpeg; charset=x"), "image/jpeg");
  assert.equal(remoteAttachmentMediaType("not a type"), "application/octet-stream");
});
