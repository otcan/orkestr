import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as age from "age-encryption";
import {
  attachmentEncryptionStatus,
  registerAttachmentEncryptionRecipient,
  revokeAttachmentEncryptionRecipient,
  setAttachmentEncryptionPolicy,
  verifyAttachmentEncryptionRecipient,
} from "../packages/core/src/attachment-encryption-registry.js";
import {
  encryptedPublishedAttachmentPath,
  encryptedAttachmentDeliveryGate,
  publishThreadAttachmentsEncrypted,
  validateEncryptedPublishedAttachment,
  validateEncryptedWhatsAppDeliverySource,
} from "../packages/core/src/encrypted-attachment-publication.js";
import { publicEncryptedAttachment } from "../packages/core/src/encrypted-attachment-projection.js";
import { reissueEncryptedThreadAttachment } from "../packages/core/src/encrypted-attachment-reissue.js";
import { migrateThreadAttachmentsToEncryption } from "../packages/core/src/attachment-encryption-migration.js";
import { attachmentEncryptionDoctorCheck } from "../packages/core/src/attachment-encryption-doctor.js";
import { ensureAutomaticAttachmentEnrollment } from "../packages/core/src/browser-attachment-auto-enrollment.js";
import { decodeOrkestrAttachmentPayload } from "../packages/core/src/browser-attachment-payload.js";
import {
  browserAttachmentRecipientFingerprint,
  browserAttachmentRecipientMatch,
} from "../packages/core/src/browser-attachment-payload.js";
import { appendThreadMessage, createThread, deleteThreadMessage, getThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import {
  appendWebUiEncryptedAttachmentNotice,
  webUiEncryptedAttachmentDelivery,
} from "../packages/connectors/src/whatsapp-webui-encrypted-attachments.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function env(home, extra = {}) {
  return { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "tenant-a", ...extra };
}

async function enroll(runtimeEnv, label = "Test key") {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const registered = await registerAttachmentEncryptionRecipient({ recipient, label }, { userId: "tenant-a" }, runtimeEnv);
  const ciphertext = Buffer.from(registered.key.challenge.ciphertext, "base64");
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  const proof = await decrypter.decrypt(ciphertext, "text");
  const verified = await verifyAttachmentEncryptionRecipient(registered.key.id, proof, { userId: "tenant-a" }, runtimeEnv);
  return { identity, recipient, key: verified.key };
}

function decodePublishedPayload(value) {
  const bytes = Buffer.from(value);
  const first = bytes.indexOf(10);
  const second = bytes.indexOf(10, first + 1);
  assert.equal(bytes.subarray(0, first).toString("utf8"), "ORKESTR-ATTACHMENT-PAYLOAD/1");
  const headerLength = Number(bytes.subarray(first + 1, second).toString("utf8"));
  const headerStart = second + 1;
  return {
    metadata: JSON.parse(bytes.subarray(headerStart, headerStart + headerLength).toString("utf8")),
    content: bytes.subarray(headerStart + headerLength),
  };
}

test("recipient activation requires private-key possession and public status omits recipient material", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-key-"));
  const runtimeEnv = env(home);
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const registered = await registerAttachmentEncryptionRecipient({ recipient, label: "Laptop" }, { userId: "tenant-a" }, runtimeEnv);

  assert.equal(registered.key.status, "pending_verification");
  await assert.rejects(
    setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv),
    /attachment_encryption_verified_recipient_required/,
  );
  await assert.rejects(
    verifyAttachmentEncryptionRecipient(registered.key.id, "wrong proof", { userId: "tenant-a" }, runtimeEnv),
    /attachment_encryption_challenge_invalid/,
  );

  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  const proof = await decrypter.decrypt(Buffer.from(registered.key.challenge.ciphertext, "base64"), "text");
  await verifyAttachmentEncryptionRecipient(registered.key.id, proof, { userId: "tenant-a" }, runtimeEnv);
  const status = await attachmentEncryptionStatus("tenant-a", runtimeEnv);

  assert.equal(status.keys[0].status, "active");
  assert.equal("recipient" in status.keys[0], false);
  assert.equal(status.keys[0].challenge, null);
});

test("global mandatory mode fails closed before automatic browser enrollment completes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-required-bootstrap-"));
  const runtimeEnv = env(home, { ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED: "1" });
  await createThread({ id: "thread-required-bootstrap", ownerUserId: "tenant-a", name: "Required bootstrap" }, runtimeEnv);
  const sourcePath = path.join(home, "future.txt");
  await fs.writeFile(sourcePath, "future ciphertext", { mode: 0o600 });

  assert.equal((await attachmentEncryptionStatus("tenant-a", runtimeEnv)).policy.required, true);
  await assert.rejects(
    appendThreadMessage("thread-required-bootstrap", {
      role: "assistant",
      source: "codex-app-server",
      state: "completed",
      text: "Before enrollment",
      attachments: [{ path: sourcePath, name: "future.txt" }],
    }, runtimeEnv),
    /attachment_encryption_verified_recipient_required/,
  );

  await enroll(runtimeEnv);
  const published = await appendThreadMessage("thread-required-bootstrap", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "After enrollment",
    attachments: [{ path: sourcePath, name: "future.txt" }],
  }, runtimeEnv);
  assert.equal(published.attachments[0].encrypted, true);
});

test("doctor ignores pre-enforcement plaintext but rejects plaintext published after enforcement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-doctor-cutoff-"));
  const runtimeEnv = env(home);
  const enforcedEnv = { ...runtimeEnv, ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED: "1" };
  await createThread({ id: "thread-doctor-cutoff", ownerUserId: "tenant-a", name: "Doctor cutoff" }, runtimeEnv);
  const sourcePath = path.join(home, "legacy.txt");
  await fs.writeFile(sourcePath, "legacy plaintext", { mode: 0o600 });

  const historical = await appendThreadMessage("thread-doctor-cutoff", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "Historical",
    attachments: [{ path: sourcePath, name: "legacy.txt" }],
  }, runtimeEnv);
  await updateThreadMessage("thread-doctor-cutoff", historical.id, {
    createdAt: String(Math.floor(Date.parse(historical.createdAt) / 1_000)),
  }, runtimeEnv);
  await enroll(enforcedEnv);

  const afterEnrollment = await attachmentEncryptionDoctorCheck(enforcedEnv);
  assert.equal(afterEnrollment.status, "ok");
  assert.equal(afterEnrollment.historicalPlaintextMessageAttachments, 1);

  await appendThreadMessage("thread-doctor-cutoff", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "Policy bypass simulation",
    attachments: [{ path: sourcePath, name: "legacy.txt" }],
  }, runtimeEnv);
  const bypass = await attachmentEncryptionDoctorCheck(enforcedEnv);
  assert.equal(bypass.status, "error");
  assert.equal(bypass.plaintextMessageAttachments, 1);
  assert.equal(bypass.historicalPlaintextMessageAttachments, 1);
});

test("mandatory publication exposes only opaque age ciphertext and leaves the source untouched", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-publish-"));
  const runtimeEnv = env(home);
  const enrolled = await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  await createThread({ id: "thread-encrypted", ownerUserId: "tenant-a", name: "Encrypted" }, runtimeEnv);
  const sourcePath = path.join(home, "confidential-report.txt");
  await fs.writeFile(sourcePath, "private attachment bytes", { mode: 0o600 });

  const message = await appendThreadMessage("thread-encrypted", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "Encrypted report attached.",
    attachments: [{ path: sourcePath, name: "board-plan.txt", mimetype: "text/plain" }],
  }, runtimeEnv);
  const attachment = message.attachments[0];
  const publicAttachment = publicEncryptedAttachment(attachment);

  assert.equal(await fs.readFile(sourcePath, "utf8"), "private attachment bytes");
  assert.equal(attachment.encrypted, true);
  assert.equal(attachment.mimetype, "application/age");
  assert.match(attachment.filename, /^attachment-[0-9a-f-]+\.age$/);
  assert.equal(attachment.deliverySource.path, await fs.realpath(sourcePath));
  assert.equal(attachment.deliverySource.filename, "board-plan.txt");
  assert.equal(publicAttachment.displayFilename, "board-plan.txt");
  assert.equal(publicEncryptedAttachment({
    ...attachment,
    deliverySource: { ...attachment.deliverySource, filename: "../../private/board-plan.txt" },
  }).displayFilename, "board-plan.txt");
  assert.equal(JSON.stringify(publicAttachment).includes("text/plain"), false);
  assert.equal("deliverySource" in publicAttachment, false);
  assert.equal("sourceAttachmentId" in publicAttachment, false);
  assert.equal("path" in attachment, false);
  assert.equal("saved_path" in attachment, false);
  assert.equal((await validateEncryptedPublishedAttachment(attachment, { thread: await getThread("thread-encrypted", runtimeEnv), env: runtimeEnv })).ok, true);
  const whatsAppSource = await validateEncryptedWhatsAppDeliverySource(attachment, {
    thread: await getThread("thread-encrypted", runtimeEnv),
    env: runtimeEnv,
  });
  assert.equal(whatsAppSource.ok, true);
  assert.equal(whatsAppSource.attachment.path, await fs.realpath(sourcePath));
  assert.equal(whatsAppSource.attachment.filename, "board-plan.txt");

  const decrypter = new age.Decrypter();
  decrypter.addIdentity(enrolled.identity);
  const plaintext = await decrypter.decrypt(await fs.readFile(
    encryptedPublishedAttachmentPath(await getThread("thread-encrypted", runtimeEnv), attachment, runtimeEnv),
  ));
  const payload = decodePublishedPayload(plaintext);
  assert.equal(payload.metadata.filename, "board-plan.txt");
  assert.equal(payload.metadata.mimetype, "text/plain");
  assert.equal(payload.content.toString("utf8"), "private attachment bytes");
  assert.equal((await attachmentEncryptionDoctorCheck(runtimeEnv)).status, "ok");

  await fs.writeFile(
    encryptedPublishedAttachmentPath(await getThread("thread-encrypted", runtimeEnv), attachment, runtimeEnv),
    "corrupt ciphertext",
  );
  const doctor = await attachmentEncryptionDoctorCheck(runtimeEnv);
  assert.equal(doctor.status, "error");
  assert.equal(doctor.undeliverableCiphertextAttachments, 1);
});

test("assistant message updates do not publish duplicate ciphertext for an existing source", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-update-dedup-"));
  const runtimeEnv = env(home);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-update-dedup", ownerUserId: "tenant-a", name: "Update dedupe", cwd: home }, runtimeEnv);
  const sourcePath = path.join(home, "report.zip");
  await fs.writeFile(sourcePath, "one report", { mode: 0o600 });
  const text = `[report.zip](${sourcePath})`;

  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text,
  }, runtimeEnv);
  const unchanged = await updateThreadMessage(thread.id, message.id, { text }, runtimeEnv);
  const revised = await updateThreadMessage(thread.id, message.id, { text: `Ready: ${text}` }, runtimeEnv);
  const publicationDir = path.dirname(encryptedPublishedAttachmentPath(thread, message.attachments[0], runtimeEnv));

  assert.equal(message.attachments.length, 1);
  assert.ok(message.attachments[0].sourceAttachmentId);
  assert.equal(unchanged.attachments.length, 1);
  assert.equal(unchanged.attachments[0].id, message.attachments[0].id);
  assert.equal(revised.attachments.length, 1);
  assert.equal(revised.attachments[0].id, message.attachments[0].id);
  assert.deepEqual(await fs.readdir(publicationDir), [message.attachments[0].filename]);
});

test("publication streams content across age chunk boundaries and cleans a partially failed batch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-stream-"));
  const runtimeEnv = env(home);
  const enrolled = await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-streamed", ownerUserId: "tenant-a", name: "Streamed" }, runtimeEnv);
  const sourcePath = path.join(home, "large.bin");
  const content = Buffer.alloc((64 * 1024 * 3) + 17, 0x5a);
  await fs.writeFile(sourcePath, content, { mode: 0o600 });

  const result = await publishThreadAttachmentsEncrypted({
    thread,
    attachments: [{ path: sourcePath, name: "large.bin", mimetype: "application/octet-stream" }],
    env: runtimeEnv,
  });
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(enrolled.identity);
  const plaintext = await decrypter.decrypt(await fs.readFile(
    encryptedPublishedAttachmentPath(thread, result.attachments[0], runtimeEnv),
  ));
  assert.deepEqual(decodePublishedPayload(plaintext).content, content);

  await assert.rejects(
    publishThreadAttachmentsEncrypted({
      thread,
      attachments: [
        { path: sourcePath, name: "large.bin" },
        { path: path.join(home, "missing.bin"), name: "missing.bin" },
      ],
      env: runtimeEnv,
    }),
    /attachment_encryption_source_file_required/,
  );
  const publishedDir = path.dirname(encryptedPublishedAttachmentPath(thread, result.attachments[0], runtimeEnv));
  assert.deepEqual((await fs.readdir(publishedDir)).sort(), [result.attachments[0].filename]);
});

test("each active recipient can decrypt the immutable publication snapshot", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-multi-recipient-"));
  const runtimeEnv = env(home);
  const primary = await enroll(runtimeEnv, "Primary");
  const recovery = await enroll(runtimeEnv, "Recovery");
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-multi-recipient", ownerUserId: "tenant-a", name: "Multi recipient" }, runtimeEnv);
  const sourcePath = path.join(home, "multi.txt");
  await fs.writeFile(sourcePath, "recoverable ciphertext", { mode: 0o600 });
  const result = await publishThreadAttachmentsEncrypted({
    thread,
    attachments: [{ path: sourcePath, name: "multi.txt", mimetype: "text/plain" }],
    env: runtimeEnv,
  });
  const attachment = result.attachments[0];
  const ciphertext = await fs.readFile(encryptedPublishedAttachmentPath(thread, attachment, runtimeEnv));

  assert.equal(attachment.encryption.recipientIds.length, 2);
  assert.equal(attachment.encryption.recipientFingerprints.length, 2);
  for (const enrolled of [primary, recovery]) {
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(enrolled.identity);
    assert.equal(decodePublishedPayload(await decrypter.decrypt(ciphertext)).content.toString("utf8"), "recoverable ciphertext");
  }
});

test("a newly enrolled browser can reissue an unchanged source without server-side private keys", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-reissue-"));
  const runtimeEnv = env(home);
  const primary = await enroll(runtimeEnv, "Primary");
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-reissue", ownerUserId: "tenant-a", name: "Reissue", cwd: home }, runtimeEnv);
  const sourcePath = path.join(home, "reissue.txt");
  await fs.writeFile(sourcePath, "reissue me", { mode: 0o600 });
  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: `[reissue.txt](${sourcePath})`,
  }, runtimeEnv);
  const previousPath = encryptedPublishedAttachmentPath(thread, message.attachments[0], runtimeEnv);
  const later = await enroll(runtimeEnv, "Later browser");
  assert.equal(message.attachments[0].encryption.recipientIds.length, 1);

  const reissued = await reissueEncryptedThreadAttachment({
    thread,
    attachmentId: message.attachments[0].id,
    env: runtimeEnv,
  });
  const current = (await listThreadMessages(thread.id, runtimeEnv)).find((candidate) => candidate.id === message.id);
  const ciphertext = await fs.readFile(encryptedPublishedAttachmentPath(thread, reissued.attachment, runtimeEnv));
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(later.identity);

  assert.equal(reissued.attachment.encryption.recipientIds.length, 2);
  assert.equal(current.attachments.length, 1);
  assert.equal(current.attachments[0].id, reissued.attachment.id);
  assert.equal(await fs.stat(previousPath).then(() => true).catch(() => false), false);
  assert.equal(decodePublishedPayload(await decrypter.decrypt(ciphertext)).content.toString("utf8"), "reissue me");
  assert.equal(await fs.readFile(sourcePath, "utf8"), "reissue me");
  assert.ok(primary.key.id);
});

test("attachment reissue fails closed when the original source has changed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-reissue-changed-"));
  const runtimeEnv = env(home);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-reissue-changed", ownerUserId: "tenant-a", name: "Changed source", cwd: home }, runtimeEnv);
  const sourcePath = path.join(home, "changed.txt");
  await fs.writeFile(sourcePath, "original", { mode: 0o600 });
  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: `[changed.txt](${sourcePath})`,
  }, runtimeEnv);
  await fs.writeFile(sourcePath, "replacement with different bytes", { mode: 0o600 });

  await assert.rejects(
    reissueEncryptedThreadAttachment({ thread, attachmentId: message.attachments[0].id, env: runtimeEnv }),
    /attachment_reissue_source_unavailable/,
  );
  const current = (await listThreadMessages(thread.id, runtimeEnv)).find((candidate) => candidate.id === message.id);
  assert.equal(current.attachments[0].id, message.attachments[0].id);
  assert.equal((await validateEncryptedPublishedAttachment(current.attachments[0], { thread, env: runtimeEnv })).ok, true);
});

test("message deletion purges ciphertext and attachment metadata without touching the source", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-delete-"));
  const runtimeEnv = env(home);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-encrypted-delete", ownerUserId: "tenant-a", name: "Delete" }, runtimeEnv);
  const sourcePath = path.join(home, "delete-source.txt");
  await fs.writeFile(sourcePath, "source stays", { mode: 0o600 });
  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "Delete ciphertext",
    attachments: [{ path: sourcePath, name: "delete-source.txt", mimetype: "text/plain" }],
  }, runtimeEnv);
  const ciphertextPath = encryptedPublishedAttachmentPath(thread, message.attachments[0], runtimeEnv);

  const deleted = await deleteThreadMessage(thread.id, message.id, { deletedBy: "operator" }, runtimeEnv);

  assert.equal("attachments" in deleted, false);
  assert.equal(await fs.stat(ciphertextPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "source stays");
});

test("revocation is future-only and mandatory delivery never falls back to plaintext", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-revoke-"));
  const runtimeEnv = env(home);
  const enrolled = await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  await createThread({ id: "thread-revoke", ownerUserId: "tenant-a", name: "Revoke" }, runtimeEnv);
  const sourcePath = path.join(home, "artifact.zip");
  await fs.writeFile(sourcePath, "zip bytes", { mode: 0o600 });
  const first = await appendThreadMessage("thread-revoke", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "First",
    attachments: [{ path: sourcePath, name: "artifact.zip", mimetype: "application/zip" }],
  }, runtimeEnv);

  await revokeAttachmentEncryptionRecipient(enrolled.key.id, "rotation", { userId: "tenant-a" }, runtimeEnv);
  assert.equal((await validateEncryptedPublishedAttachment(first.attachments[0], { thread: await getThread("thread-revoke", runtimeEnv), env: runtimeEnv })).ok, true);
  assert.equal((await encryptedAttachmentDeliveryGate(await getThread("thread-revoke", runtimeEnv), first.attachments, runtimeEnv)).allowed, true);
  assert.equal((await encryptedAttachmentDeliveryGate(await getThread("thread-revoke", runtimeEnv), [{ path: sourcePath }], runtimeEnv)).allowed, false);
  await assert.rejects(
    appendThreadMessage("thread-revoke", {
      role: "assistant",
      source: "codex-app-server",
      state: "completed",
      text: "Second",
      attachments: [{ path: sourcePath, name: "artifact.zip", mimetype: "application/zip" }],
    }, runtimeEnv),
    /attachment_encryption_verified_recipient_required/,
  );
});

test("legacy plaintext assistant attachments migrate atomically after policy activation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-migrate-"));
  const runtimeEnv = env(home);
  await createThread({ id: "thread-migrate", ownerUserId: "tenant-a", name: "Migrate" }, runtimeEnv);
  const sourcePath = path.join(home, "legacy.pdf");
  await fs.writeFile(sourcePath, "legacy pdf bytes", { mode: 0o600 });
  const legacy = await appendThreadMessage("thread-migrate", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "Legacy",
    attachments: [{ path: sourcePath, name: "legacy.pdf", mimetype: "application/pdf" }],
  }, runtimeEnv);
  assert.notEqual(legacy.attachments[0].encrypted, true);

  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const dryRun = await migrateThreadAttachmentsToEncryption("thread-migrate", { dryRun: true }, runtimeEnv);
  const migrated = await migrateThreadAttachmentsToEncryption("thread-migrate", { dryRun: false }, runtimeEnv);
  const messages = await listThreadMessages("thread-migrate", runtimeEnv);
  const updated = messages.find((message) => message.id === legacy.id);

  assert.equal(dryRun.plan.candidateAttachments, 1);
  assert.equal(migrated.migratedAttachments, 1);
  assert.equal(updated.attachments[0].encrypted, true);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "legacy pdf bytes");
});

test("migration resumes from a durable ciphertext checkpoint without republishing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-migrate-resume-"));
  const runtimeEnv = env(home);
  await createThread({ id: "thread-migrate-resume", ownerUserId: "tenant-a", name: "Resume" }, runtimeEnv);
  const sourcePath = path.join(home, "legacy-resume.pdf");
  await fs.writeFile(sourcePath, "resume bytes", { mode: 0o600 });
  const legacy = await appendThreadMessage("thread-migrate-resume", {
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    text: "Legacy resume",
    attachments: [{ path: sourcePath, name: "legacy-resume.pdf", mimetype: "application/pdf" }],
  }, runtimeEnv);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await getThread("thread-migrate-resume", runtimeEnv);
  const staged = await publishThreadAttachmentsEncrypted({ thread, attachments: legacy.attachments, env: runtimeEnv });
  await fs.writeFile(path.join(home, "attachment-encryption-migrations.json"), JSON.stringify({
    version: 1,
    checkpoints: [{
      version: 1,
      threadId: thread.id,
      messageId: legacy.id,
      phase: "ciphertext_staged",
      attachments: staged.attachments,
    }],
  }));
  const publicationDir = path.dirname(encryptedPublishedAttachmentPath(thread, staged.attachments[0], runtimeEnv));
  const before = await fs.readdir(publicationDir);

  const migrated = await migrateThreadAttachmentsToEncryption(thread.id, { dryRun: false }, runtimeEnv);
  const after = await fs.readdir(publicationDir);
  const updated = (await listThreadMessages(thread.id, runtimeEnv)).find((message) => message.id === legacy.id);

  assert.equal(migrated.migratedAttachments, 1);
  assert.deepEqual(after, before);
  assert.equal(updated.attachments[0].id, staged.attachments[0].id);
  assert.equal((await attachmentEncryptionDoctorCheck(runtimeEnv)).status, "ok");
});

test("WhatsApp receives validated plaintext sources while WebUI attachments remain encrypted", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-whatsapp-"));
  const runtimeEnv = env(home, {
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  await createThread({
    id: "thread-encrypted-wa",
    ownerUserId: "tenant-a",
    name: "Encrypted WA",
    binding: {
      connector: "whatsapp",
      chatId: "chat-a",
      responderAccountId: "account-a",
      outboundAccountId: "account-a",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const sourcePaths = await Promise.all(["first.zip", "second.pdf", "third.csv"].map(async (filename, index) => {
    const filePath = path.join(home, filename);
    await fs.writeFile(filePath, `original attachment ${index + 1}`, { mode: 0o600 });
    return filePath;
  }));
  const parent = await appendThreadMessage("thread-encrypted-wa", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-a",
    accountId: "account-a",
    state: "completed",
    text: "Send the export",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-encrypted-wa", {
    role: "assistant",
    source: "codex-app-server",
    connector: "whatsapp",
    chatId: "chat-a",
    accountId: "account-a",
    parentMessageId: parent.id,
    phase: "final_answer",
    state: "completed",
    text: "Encrypted export attached.",
    attachments: [
      { path: sourcePaths[0], name: "first.zip", mimetype: "application/zip" },
      { path: sourcePaths[1], name: "second.pdf", mimetype: "application/pdf" },
      { path: sourcePaths[2], name: "third.csv", mimetype: "text/csv" },
    ],
  }, runtimeEnv);
  const calls = [];
  const result = await deliverWhatsAppReplies(runtimeEnv, async (url, options = {}) => {
    if (options.method === "POST") calls.push({ url: new URL(url), body: JSON.parse(String(options.body || "{}")) });
    return { ok: true, status: 200, async json() { return { ok: true, ids: ["wa-encrypted-1"] }; } };
  });

  assert.equal(result.delivered.some((delivery) => delivery.messageId === reply.id), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.deepEqual(calls[0].body.paths, sourcePaths);
  assert.equal("attachments" in calls[0].body, false);
  assert.doesNotMatch(calls[0].body.text, /protected attachment/);
  assert.equal(JSON.stringify(calls[0].body).includes(".age"), false);
  const stored = (await listThreadMessages("thread-encrypted-wa", runtimeEnv)).find((message) => message.id === reply.id);
  assert.equal(stored.attachments.length, 3);
  assert.equal(stored.attachments.every((attachment) => attachment.encrypted === true), true);
});

test("WhatsApp keeps ordinary attachments when a protected source is unavailable", async () => {
  const publication = { id: "encrypted", encrypted: true, filename: "attachment-encrypted.age" };
  const incidental = { id: "plain", path: "/tmp/incidental.txt" };
  const protectedDelivery = await webUiEncryptedAttachmentDelivery([publication, incidental]);

  assert.equal(protectedDelivery.protectedCount, 1);
  assert.equal(protectedDelivery.recoveredCount, 0);
  assert.equal(protectedDelivery.unavailableCount, 1);
  assert.deepEqual(protectedDelivery.attachments, [incidental]);
  assert.equal(
    appendWebUiEncryptedAttachmentNotice("Report ready.", protectedDelivery.unavailableCount),
    "Report ready.\n\n1 protected attachment could not be sent on WhatsApp. It remains available in the Orkestr WebUI.",
  );
});

test("WhatsApp refuses a protected source whose bytes changed after publication", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-whatsapp-changed-"));
  const runtimeEnv = env(home);
  await enroll(runtimeEnv);
  await setAttachmentEncryptionPolicy({ enabled: true, required: true }, { userId: "tenant-a" }, runtimeEnv);
  const thread = await createThread({ id: "thread-encrypted-wa-changed", ownerUserId: "tenant-a", name: "Changed WA" }, runtimeEnv);
  const sourcePath = path.join(home, "changed.zip");
  await fs.writeFile(sourcePath, "original bytes", { mode: 0o600 });
  const published = await publishThreadAttachmentsEncrypted({
    thread,
    attachments: [{ path: sourcePath, name: "changed.zip", mimetype: "application/zip" }],
    env: runtimeEnv,
  });
  await fs.writeFile(sourcePath, "changed bytes are rejected", { mode: 0o600 });

  const delivery = await webUiEncryptedAttachmentDelivery(published.attachments, { thread, env: runtimeEnv });
  assert.equal(delivery.protectedCount, 1);
  assert.equal(delivery.recoveredCount, 0);
  assert.equal(delivery.unavailableCount, 1);
  assert.deepEqual(delivery.attachments, []);
  assert.equal(delivery.unavailable[0].reason, "whatsapp_source_size_mismatch");
});

test("WebUI decrypts authenticated age payloads locally and has no historical migration control", async () => {
  const [payloadDecoder, service, bootstrap, appComponent, messageComponent, messageTemplate, settingsComponent, settingsTemplate] = await Promise.all([
    fs.readFile(new URL("../packages/core/src/browser-attachment-payload.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/attachment-decryption.service.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/attachment-encryption-bootstrap.service.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/app.component.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/thread-message-list.component.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/thread-message-list.component.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/instance-settings-page.component.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/src/app/instance-settings-page.component.html", import.meta.url), "utf8"),
  ]);
  const webUi = [payloadDecoder, service, bootstrap, appComponent, messageComponent, messageTemplate, settingsComponent, settingsTemplate].join("\n");

  assert.match(service, /new age\.Decrypter\(\)/);
  assert.match(payloadDecoder, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(service, /credentials: "same-origin"/);
  assert.match(payloadDecoder, /attachment_payload_checksum_mismatch/);
  assert.match(service, /link\.download = attachment\.filename/);
  assert.match(messageTemplate, /downloadEncryptedAttachment\(attachment\)/);
  assert.match(messageComponent, /attachment\["displayFilename"\]/);
  assert.match(messageTemplate, /\{\{ attachmentLabel\(attachment\) \}\}/);
  assert.doesNotMatch(messageTemplate, /Secure download/);
  assert.doesNotMatch(messageTemplate, /\[href\]="attachmentDownloadUrl\(attachment\)"[^\n]*encrypted/);
  assert.match(service, /age\.generateIdentity\(\)/);
  assert.match(bootstrap, /registerAttachmentEncryptionRecipient/);
  assert.match(bootstrap, /verifyAttachmentEncryptionRecipient/);
  assert.match(bootstrap, /updateAttachmentEncryptionPolicy\(\{ enabled: true, required: true \}\)/);
  assert.match(appComponent, /await this\.bootstrapAttachmentEncryption\(\)/);
  assert.match(appComponent, /setTimeout\(\(\) =>/);
  assert.match(settingsTemplate, /Protection is enrolled and enforced automatically after login/);
  assert.match(settingsTemplate, /never sends its private identity to Orkestr/i);
  assert.doesNotMatch(webUi, /migrateAttachments\(/);
  assert.doesNotMatch(settingsTemplate, /Legacy attachment migration/);
});

test("automatic browser enrollment verifies possession and enables fail-closed policy without user input", async () => {
  const calls = [];
  let policyRequired = false;
  let recipientReady = false;
  const result = await ensureAutomaticAttachmentEnrollment({
    async ensureIdentity() {
      calls.push("identity");
      return "age1browser";
    },
    async registerRecipient(recipient) {
      calls.push(`register:${recipient}`);
      return { key: { id: "key-1", status: "pending_verification", challenge: { ciphertext: "challenge" } } };
    },
    async decryptChallenge(ciphertext) {
      calls.push(`decrypt:${ciphertext}`);
      return "proof";
    },
    async verifyRecipient(recipientId, proof) {
      calls.push(`verify:${recipientId}:${proof}`);
      recipientReady = true;
    },
    async status() {
      calls.push("status");
      return { ready: recipientReady, policy: { enabled: policyRequired, required: policyRequired } };
    },
    async requirePolicy() {
      calls.push("require");
      policyRequired = true;
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.policy.required, true);
  assert.deepEqual(calls, [
    "identity",
    "register:age1browser",
    "decrypt:challenge",
    "verify:key-1:proof",
    "status",
    "require",
    "status",
  ]);
});

test("browser payload decoder restores original metadata and rejects changed plaintext", async () => {
  const content = Buffer.from("browser-local plaintext", "utf8");
  const metadata = Buffer.from(JSON.stringify({
    version: 1,
    filename: "../board/report.txt",
    mimetype: "text/plain",
    plaintextSize: content.length,
    plaintextChecksum: createHash("sha256").update(content).digest("hex"),
  }), "utf8");
  const payload = Buffer.concat([
    Buffer.from(`ORKESTR-ATTACHMENT-PAYLOAD/1\n${metadata.length}\n`, "utf8"),
    metadata,
    content,
  ]);

  const decoded = await decodeOrkestrAttachmentPayload(payload);
  assert.equal(decoded.filename, "_board_report.txt");
  assert.equal(decoded.mimetype, "text/plain");
  assert.equal(Buffer.from(decoded.bytes).toString("utf8"), "browser-local plaintext");

  const changed = Buffer.from(payload);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(decodeOrkestrAttachmentPayload(changed), /attachment_payload_checksum_mismatch/);
});

test("browser detects when an immutable publication predates its local recipient", async () => {
  const currentIdentity = await age.generateIdentity();
  const currentRecipient = await age.identityToRecipient(currentIdentity);
  const otherRecipient = await age.identityToRecipient(await age.generateIdentity());
  const currentFingerprint = await browserAttachmentRecipientFingerprint(currentRecipient);
  const otherFingerprint = await browserAttachmentRecipientFingerprint(otherRecipient);

  assert.match(currentFingerprint, /^SHA256:[a-f0-9]{32}$/);
  assert.equal(await browserAttachmentRecipientMatch({
    encryption: { recipientFingerprints: [currentFingerprint] },
  }, currentRecipient), true);
  assert.equal(await browserAttachmentRecipientMatch({
    encryption: { recipientFingerprints: [otherFingerprint] },
  }, currentRecipient), false);
  assert.equal(await browserAttachmentRecipientMatch({ encryption: {} }, currentRecipient), null);
});
