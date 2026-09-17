import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { withInboundAttachmentMutationLock } from "./inbound-attachment-store-lock.js";
import { publicInboundAttachmentUploadSession } from "./inbound-attachment-session-projection.js";
import { resourceOwnerUserId } from "./policy.js";
import { incrementCounter } from "./observability.js";
import { inboundAttachmentKeyById } from "./inbound-attachment-keys.js";

export function draftAttachmentIds(input = {}) {
  return (Array.isArray(input.attachments) ? input.attachments : [])
    .map(item => String(item?.uploadSessionId || item?.inboundUpload?.sessionId || "")).filter(Boolean);
}

export function draftAttachmentFingerprint(input = {}) {
  const ids = draftAttachmentIds(input);
  return ids.length ? createHash("sha256").update(JSON.stringify([String(input.text || ""), ids])).digest("hex") : "";
}

function fail(code) {
  return Object.assign(new Error(code), { statusCode: 409 });
}

async function save(store, env) {
  store.revision = Number(store.revision || 0) + 1;
  store.updatedAt = new Date().toISOString();
  await writeJson(dataPaths(env).inboundAttachmentUploads, store);
  await fs.chmod(dataPaths(env).inboundAttachmentUploads, 0o600);
}

// Called while holding the upload mutation lock. A crash after message append
// must retain its bytes; a crash before append releases the reservation.
export async function reconcileDraftClaims(store, env) {
  let changed = false;
  const repository = createThreadMessageRepository(env);
  for (const session of store.sessions) {
    if (session.state !== "claiming") continue;
    const messages = await repository.list(session.threadId);
    const message = messages.find(item => item.id === session.claim?.messageId);
    session.state = message ? "claimed" : "ready";
    if (!message) delete session.claim;
    session.updatedAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}

export async function withDraftAttachmentClaims({ thread, input, messageId, env }, writeMessage) {
  const ids = draftAttachmentIds(input);
  if (!ids.length) return writeMessage(input.attachments || []);
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw fail("draft_attachment_set_invalid");
  return withInboundAttachmentMutationLock(env, async () => {
    const store = await readJson(dataPaths(env).inboundAttachmentUploads, { version: 2, sessions: [] });
    if (await reconcileDraftClaims(store, env)) await save(store, env);
    const sessions = ids.map(id => store.sessions.find(session => session.id === id));
    for (const session of sessions) {
      if (!session || session.threadId !== thread.id || session.ownerUserId !== resourceOwnerUserId(thread, env)) {
        throw fail("draft_attachment_unavailable");
      }
      if (session.state !== "ready" || !session.release?.path || !Number.isFinite(Date.parse(session.release.expiresAt)) || Date.parse(session.release.expiresAt) <= Date.now()) {
        throw fail("draft_attachment_not_ready");
      }
      const stat = await fs.lstat(session.release.path).catch(() => null);
      if (!stat?.isFile() || stat.size !== session.release.size) throw fail("draft_attachment_missing");
      const key = await inboundAttachmentKeyById(session.ownerUserId, session.keyId, env);
      if (!key || !["active", "retired"].includes(key.status)) throw fail("draft_attachment_key_unavailable");
    }
    const canonical = new Map(sessions.map(session => [session.id, publicInboundAttachmentUploadSession(session).attachment]));
    const attachments = input.attachments.map(item => {
      const id = String(item?.uploadSessionId || item?.inboundUpload?.sessionId || "");
      return id ? canonical.get(id) : item;
    });
    for (const session of sessions) {
      session.state = "claiming";
      session.claim = { messageId, createdAt: new Date().toISOString() };
    }
    await save(store, env); // Durable intent before touching the message repository.
    try {
      const result = await writeMessage(attachments);
      for (const session of sessions) session.state = "claimed";
      await save(store, env);
      incrementCounter("orkestr_draft_attachment_claims_total", { outcome: "claimed" });
      return result;
    } catch (error) {
      // Also covers append succeeding but its acknowledgement/save failing.
      // Do not blindly release a claim whose message is already durable.
      await reconcileDraftClaims(store, env);
      await save(store, env);
      throw error;
    }
  });
}
