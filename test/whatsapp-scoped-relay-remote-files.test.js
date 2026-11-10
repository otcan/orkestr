import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as age from "age-encryption";

// Files of a remote-runtime reply reach the scoped group relay: V1 imports the
// reply's descriptors (also under required attachment encryption) and the
// relay's file endpoint stages each one where the worker's reply-file check
// accepts it. All hosts, ids and bytes are synthetic.
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const REFERENCE = "00000000-0000-4000-8000-0000000000f1";
const PDF = Buffer.from("%PDF-1.4 synthetic one-page report\n");

async function isolatedEnv(t, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-relay-remote-files-"));
  const env = {
    HOME: home, ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({ example: { baseUrl: "http://runtime.example.test", token: "public-test-token" } }),
    ...extra,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { home, env };
}

async function enroll(env) {
  const { registerAttachmentEncryptionRecipient, verifyAttachmentEncryptionRecipient } =
    await import("../dist/server/packages/core/src/attachment-encryption-registry.js");
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const registered = await registerAttachmentEncryptionRecipient({ recipient, label: "Synthetic key" }, { userId: "admin" }, env);
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  const proof = await decrypter.decrypt(Buffer.from(registered.key.challenge.ciphertext, "base64"), "text");
  await verifyAttachmentEncryptionRecipient(registered.key.id, proof, { userId: "admin" }, env);
}

const binding = {
  connector: "whatsapp", chatId: "example-group@g.us", enabled: true, mirrorToWhatsApp: false,
  inboundAccountId: "example-account", remoteBackend: "example", remoteThreadId: "example-remote",
};
const descriptor = (extra = {}) => ({ id: REFERENCE, filename: "report.pdf", mimetype: "application/pdf", size: PDF.length, sha256: sha(PDF), ...extra });

test("a remote reply's file is imported under required encryption and staged for the relay worker", async (t) => {
  const { home, env } = await isolatedEnv(t, { ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED: "1" });
  await enroll(env);
  const { appendThreadMessage, createThread, listThreadMessages } = await import("../dist/server/packages/core/src/threads.js");
  const { syncRemoteWhatsAppThreadMessages } = await import("../dist/server/packages/connectors/src/whatsapp-remote-runtime.js");
  const { readReplyFile } = await import("../dist/server/packages/connectors/src/whatsapp-scoped-reply-files.js");
  const { ThreadMessagesController } = await import("../dist/server/apps/server/src/modules/threads/thread-messages.controller.js");
  await createThread({ id: "example-delegated", ownerUserId: "admin", binding }, env);
  const input = await appendThreadMessage("example-delegated", {
    role: "user", source: "whatsapp_inbound", connector: "whatsapp", chatId: binding.chatId, text: "send the report",
    remoteBackend: "example", remoteThreadId: "example-remote", remoteMessageId: "example-remote-user",
  }, env);
  const remoteMessages = [
    { id: "example-remote-user", role: "user", state: "delivered", deliveryState: "delivered", publicMessageId: input.id },
    { id: "example-remote-reply", role: "assistant", state: "completed", phase: "final_answer", source: "rust-v2-pilot",
      parentMessageId: "example-remote-user", text: "Here is the report.", exportSequence: 1, attachments: [descriptor()] },
  ];
  const downloads = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.host, "runtime.example.test");
    if (parsed.pathname === "/threads/example-remote/messages") return Response.json({ ok: true, messages: remoteMessages });
    if (parsed.pathname === `/threads/example-remote/attachments/${REFERENCE}/download`) {
      assert.equal(options.headers.authorization, "Bearer public-test-token");
      downloads.push(parsed.pathname);
      return new Response(PDF, { headers: { "content-type": "application/pdf" } });
    }
    return Response.json({ ok: false, error: "route_not_found" }, { status: 404 });
  };

  const synced = await syncRemoteWhatsAppThreadMessages(env, globalThis.fetch, { threadIds: ["example-delegated"], push: true });
  assert.equal(synced.results[0].error, undefined, "the reply with a file is imported, not refused for encryption");
  const reply = (await listThreadMessages("example-delegated", env)).find((m) => m.remoteMessageId === "example-remote-reply");
  assert.ok(reply, "the remote reply is in the V1 thread");
  assert.equal(reply.attachments.length, 1);
  assert.equal(reply.attachments[0].remote, true);
  assert.equal(reply.attachments[0].remoteAttachmentId, REFERENCE);

  const controller = new ThreadMessagesController({});
  const first = await controller.scopedRelayFiles({}, "example-delegated", reply.id);
  assert.equal(first.files.length, 1, "exactly one file for the relay");
  const [file] = first.files;
  assert.equal(file.id, reply.attachments[0].id);
  assert.equal(file.sha256, sha(PDF));
  assert.equal(file.mimetype, "application/pdf");
  assert.equal(file.filename, "report.pdf");
  const artifacts = path.join(home, "uploads", "example-delegated", "artifacts");
  assert.equal(path.dirname(file.path), artifacts);
  assert.equal(path.basename(file.path), `${sha(PDF)}-report.pdf`);
  // The relay sends exactly these four fields; the worker re-reads and re-hashes.
  const sent = { path: file.path, filename: file.filename, mimetype: file.mimetype, sha256: file.sha256 };
  assert.deepEqual(readReplyFile(sent, { root: path.join(home, "uploads"), threadId: "example-delegated" }), PDF,
    "the worker's own reply-file check accepts the staged snapshot");
  await assert.rejects(fs.stat(path.join(home, "whatsapp-bridge", "outbound-media", "remote-artifacts", "example-delegated", reply.id)
    .concat(`/${sha(PDF).slice(0, 16)}-report.pdf`)), "no second plaintext copy stays behind");

  // A relay retry names the same file at the same snapshot; nothing new is staged.
  const again = await controller.scopedRelayFiles({}, "example-delegated", reply.id);
  assert.deepEqual(again.files, first.files);
  assert.deepEqual(await fs.readdir(artifacts), [path.basename(file.path)]);
  assert.equal(downloads.length, 2);
});

test("relay files of a remote reply refuse a wrong digest, a disallowed type, an oversized file and another backend", async (t) => {
  const { home, env } = await isolatedEnv(t);
  const { scopedRelayRemoteReplyFiles } = await import("../packages/connectors/src/whatsapp-scoped-relay-remote-files.js");
  const thread = { id: "example-delegated", ownerUserId: "admin", binding };
  const fetched = [];
  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 1);
  const fetchImpl = async (url) => {
    const id = decodeURIComponent(new URL(String(url)).pathname.split("/").at(-2));
    fetched.push(id);
    return new Response(id === "big" ? big : PDF, { headers: { "content-type": "application/pdf" } });
  };
  const remote = (extra) => ({ kind: "file", filename: "report.pdf", mimetype: "application/pdf", size: PDF.length, source: "remote_runtime_attachment",
    downloadable: false, remote: true, remoteBackend: "example", remoteThreadId: "example-remote", remoteMessageId: "example-remote-reply",
    sha256: sha(PDF), ...extra });
  const message = (attachments, role = "assistant") => ({ id: "local-reply", role, attachments });
  const files = (attachments, role) => scopedRelayRemoteReplyFiles({ thread, message: message(attachments, role), env, fetchImpl });

  assert.deepEqual(await files([remote({ id: "ratt_digest", remoteAttachmentId: "digest", sha256: "b".repeat(64) })]), []);
  assert.deepEqual(await files([remote({ id: "ratt_type", remoteAttachmentId: "type", filename: "tool.exe", mimetype: "application/x-msdownload" })]), []);
  assert.deepEqual(await files([remote({ id: "ratt_declared", remoteAttachmentId: "declared", size: 16 * 1024 * 1024 + 1 })]), []);
  assert.deepEqual(await files([remote({ id: "ratt_big", remoteAttachmentId: "big", size: 0, sha256: undefined })]), []);
  assert.deepEqual(await files([remote({ id: "ratt_other", remoteAttachmentId: "other", remoteThreadId: "another-remote" })]), []);
  assert.deepEqual(await files([remote({ id: "ratt_user", remoteAttachmentId: "user" })], "user"), []);
  assert.deepEqual(fetched, ["digest", "big"], "type, declared size, other thread and user input are refused before any fetch");
  await assert.rejects(fs.readdir(path.join(home, "uploads", "example-delegated", "artifacts")), "nothing was staged");

  // A snapshot V1 staged itself is left to the endpoint's existing branch.
  const snapshot = { id: "att-local", path: "/synthetic/uploads/example-delegated/artifacts/x-report.pdf", filename: "report.pdf",
    mimetype: "application/pdf", outboundSnapshot: { version: 1, sha256: sha(PDF) } };
  assert.deepEqual(await files([snapshot]), []);
  const accepted = await files([remote({ id: "ratt_ok", remoteAttachmentId: "ok" }), snapshot]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "ratt_ok");
});

test("the relay file endpoint still returns a snapshot V1 staged itself", async (t) => {
  const { home, env } = await isolatedEnv(t);
  const { appendThreadMessage, createThread } = await import("../dist/server/packages/core/src/threads.js");
  const { ThreadMessagesController } = await import("../dist/server/apps/server/src/modules/threads/thread-messages.controller.js");
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "totals.csv"), "a,b\n1,2\n");
  await createThread({ id: "example-local", ownerUserId: "admin", workspace, binding: { connector: "whatsapp", chatId: "local-group@g.us" } }, env);
  const reply = await appendThreadMessage("example-local", {
    role: "assistant", phase: "final_answer", state: "completed", connector: "whatsapp", chatId: "local-group@g.us",
    text: "Totals attached.", attachments: [{ path: path.join(workspace, "totals.csv"), filename: "totals.csv", source: "explicit_attachment" }],
  }, env);
  globalThis.fetch = async (url) => { throw new Error(`no remote fetch expected: ${url}`); };
  const { files } = await new ThreadMessagesController({}).scopedRelayFiles({}, "example-local", reply.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].id, reply.attachments[0].id);
  assert.equal(files[0].sha256, sha(Buffer.from("a,b\n1,2\n")));
  assert.equal(files[0].filename, "totals.csv");
  assert.ok(path.isAbsolute(files[0].path));
});
