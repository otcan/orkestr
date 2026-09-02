import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as age from "age-encryption";
import { startServer } from "../apps/server/src/server.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";

const envKeys = [
  "ORKESTR_HOME",
  "ORKESTR_ADMIN_USER_ID",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
];

function snapshotEnv() {
  return new Map(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("attachment encryption API verifies a recipient and exposes only ciphertext download metadata", async () => {
  const prior = snapshotEnv();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-attachment-api-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_ADMIN_USER_ID = "tenant-a";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const invalidResponse = await fetch(`${baseUrl}/attachment-encryption/recipients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient, label: "API test", privateIdentity: identity }),
    });
    assert.equal(invalidResponse.status, 400);
    const registeredResponse = await fetch(`${baseUrl}/attachment-encryption/recipients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient, label: "API test" }),
    });
    const registered = await registeredResponse.json();
    assert.equal(registeredResponse.status, 201);
    assert.equal("recipient" in registered.key, false);

    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    const proof = await decrypter.decrypt(Buffer.from(registered.key.challenge.ciphertext, "base64"), "text");
    const verifyResponse = await fetch(`${baseUrl}/attachment-encryption/recipients/${registered.key.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof }),
    });
    assert.equal(verifyResponse.status, 201);
    const policyResponse = await fetch(`${baseUrl}/attachment-encryption/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, required: true }),
    });
    assert.equal(policyResponse.status, 200);

    await createThread({ id: "thread-attachment-api", ownerUserId: "tenant-a", name: "Attachment API" }, process.env);
    const sourcePath = path.join(home, "plain-source.txt");
    await fs.writeFile(sourcePath, "server download proof", { mode: 0o600 });
    const stored = await appendThreadMessage("thread-attachment-api", {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      state: "completed",
      text: `Encrypted file: [download](${sourcePath})`,
      attachments: [{ path: sourcePath, name: "secret-name.txt", mimetype: "text/plain" }],
    }, process.env);

    const pageResponse = await fetch(`${baseUrl}/threads/thread-attachment-api/messages`);
    const page = await pageResponse.json();
    const projected = page.messages.find((message) => message.id === stored.id).attachments[0];
    assert.equal(projected.encrypted, true);
    assert.equal("path" in projected, false);
    assert.equal("saved_path" in projected, false);
    assert.equal(JSON.stringify(projected).includes("secret-name.txt"), false);
    assert.match(projected.downloadUrl, /\/attachments\/[^/]+\/download$/);

    const historyResponse = await fetch(`${baseUrl}/threads/thread-attachment-api/history`);
    const history = await historyResponse.json();
    const historyAttachment = history.messages.find((message) => message.id === stored.id).attachments[0];
    assert.equal("path" in historyAttachment, false);
    assert.equal("saved_path" in historyAttachment, false);

    const downloadResponse = await fetch(`http://127.0.0.1:${server.address().port}${projected.downloadUrl}`);
    const ciphertext = new Uint8Array(await downloadResponse.arrayBuffer());
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/age");
    assert.match(downloadResponse.headers.get("content-disposition"), /attachment-[0-9a-f-]+\.age/);
    const decryptDownload = new age.Decrypter();
    decryptDownload.addIdentity(identity);
    const decrypted = await decryptDownload.decrypt(ciphertext);
    assert.equal(Buffer.from(decrypted).includes(Buffer.from("server download proof")), true);

    const laterIdentity = await age.generateIdentity();
    const laterRecipient = await age.identityToRecipient(laterIdentity);
    const laterRegisteredResponse = await fetch(`${baseUrl}/attachment-encryption/recipients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: laterRecipient, label: "Later API browser" }),
    });
    const laterRegistered = await laterRegisteredResponse.json();
    const laterChallengeDecrypter = new age.Decrypter();
    laterChallengeDecrypter.addIdentity(laterIdentity);
    const laterProof = await laterChallengeDecrypter.decrypt(Buffer.from(laterRegistered.key.challenge.ciphertext, "base64"), "text");
    const laterVerifyResponse = await fetch(`${baseUrl}/attachment-encryption/recipients/${laterRegistered.key.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: laterProof }),
    });
    assert.equal(laterVerifyResponse.status, 201);

    const reissueResponse = await fetch(
      `http://127.0.0.1:${server.address().port}${projected.downloadUrl.replace(/\/download$/, "/reissue")}`,
      { method: "POST" },
    );
    const reissued = await reissueResponse.json();
    assert.equal(reissueResponse.status, 200);
    assert.equal(reissued.attachment.encryption.recipientIds.length, 2);
    assert.equal("sourceAttachmentId" in reissued.attachment, false);
    const reissuedDownload = await fetch(`http://127.0.0.1:${server.address().port}${reissued.attachment.downloadUrl}`);
    const laterDecrypter = new age.Decrypter();
    laterDecrypter.addIdentity(laterIdentity);
    const laterPlaintext = await laterDecrypter.decrypt(new Uint8Array(await reissuedDownload.arrayBuffer()));
    assert.equal(Buffer.from(laterPlaintext).includes(Buffer.from("server download proof")), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
