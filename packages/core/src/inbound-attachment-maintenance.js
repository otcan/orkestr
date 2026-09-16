import fsp from "node:fs/promises";
import path from "node:path";
import { inboundAttachmentCiphertextPath, inboundAttachmentQuarantineRoot } from "./inbound-attachment-files.js";

async function removeStaleTemporaryCiphertext(env, policy, removeOwnedArtifact) {
  const root = path.join(inboundAttachmentQuarantineRoot(env), "ciphertext");
  const cutoff = Date.now() - policy.partialUploadTtlMs;
  let removed = 0;
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".tmp")) {
        const stat = await fsp.stat(target).catch(() => null);
        if (stat && stat.mtimeMs <= cutoff && await removeOwnedArtifact(target, root)) removed += 1;
      }
    }
  }
  await visit(root);
  return removed;
}

export async function runInboundAttachmentMaintenance({ env, startup }, {
  policyFor, mutateStore, isReceivingExpired, processingStates,
  isProcessingLeaseExpired, staleProcessingLease, leaseArtifactPaths,
  isReleaseExpired, clean, nowIso, removeArtifacts, removeOwnedArtifact,
}) {
  const policy = policyFor(env);
  const now = Date.now();
  const sweep = await mutateStore(env, async (store) => {
    let changed = false;
    const artifacts = [];
    const ciphertext = [];
    const retainedAt = now - policy.terminalRetentionMs;
    for (const session of store.sessions) {
      if (isReceivingExpired(session, now)) {
        session.state = "expired";
        session.error = "inbound_upload_session_expired";
        session.updatedAt = nowIso(now);
        changed = true;
      }
      if (processingStates.has(session.state) && isProcessingLeaseExpired(session, now) && await staleProcessingLease(session)) {
        artifacts.push(...leaseArtifactPaths(session, session.processingToken, env));
        session.state = "retryable";
        session.error = "restart_reconciliation_required";
        delete session.processingToken;
        delete session.processingLease;
        session.updatedAt = nowIso(now);
        changed = true;
      }
      if (isReleaseExpired(session, now)) {
        artifacts.push(clean(session.release?.path));
        session.state = "expired";
        session.error = "plaintext_lease_expired";
        session.updatedAt = nowIso(now);
        changed = true;
      }
      const updatedAt = Date.parse(clean(session.updatedAt || session.createdAt));
      if (["rejected", "cancelled", "expired"].includes(session.state) && Number.isFinite(updatedAt) && updatedAt <= retainedAt) {
        ciphertext.push(inboundAttachmentCiphertextPath(session, env));
      }
    }
    return { changed, value: { sessions: store.sessions, artifacts, ciphertext } };
  });
  const removedPlaintext = await removeArtifacts(sweep.artifacts, env);
  for (const target of sweep.ciphertext) await removeOwnedArtifact(target, path.join(inboundAttachmentQuarantineRoot(env), "ciphertext"));
  const removedTemporaryCiphertext = await removeStaleTemporaryCiphertext(env, policy, removeOwnedArtifact);
  return {
    retryable: sweep.sessions.filter((session) => session.state === "retryable").length,
    expired: sweep.sessions.filter((session) => session.state === "expired").length,
    removedPlaintext,
    removedTemporaryCiphertext,
    startup,
  };
}
