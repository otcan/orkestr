import { createHash } from "node:crypto";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { classifyThreadAttachmentPath } from "./thread-attachments.js";
import { materializeSandboxArtifact, readSandboxArtifactSource, sandboxArtifactMaxBytes } from "./thread-sandbox-artifacts.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const scope = thread => digest(`${thread.ownerUserId || ""}\n${thread.id || ""}`);

function failure(reason) {
  const error = new Error(`outbound_attachment_snapshot_${reason}`);
  error.retryable = true;
  return error;
}

// Snapshot only routed assistant artifacts, never inbound uploads or arbitrary
// user-provided paths. Existing resolution and path policy remain authoritative.
export async function snapshotRoutedAttachments({ thread, message, attachments, env = process.env }) {
  if (message.role !== "assistant" ||
      (message.connector !== "whatsapp" && thread.binding?.connector !== "whatsapp")) return attachments;
  const result = [];
  for (const attachment of attachments) {
    if (attachment.encrypted === true || !attachment.path) {
      result.push(attachment);
      continue;
    }
    if (!classifyThreadAttachmentPath(attachment.path, { thread, env }).ok) throw failure("path_denied");
    const source = await readSandboxArtifactSource(attachment.path, sandboxArtifactMaxBytes(env));
    if (!source.ok) throw failure(source.reason);
    const sha256 = digest(source.buffer);
    if (attachment.outboundSnapshot && (attachment.outboundSnapshot.sha256 !== sha256 ||
        attachment.outboundSnapshot.scope !== scope(thread))) throw failure("integrity_failed");
    const remoteRoot = path.join(dataPaths(env).home, "whatsapp-bridge", "outbound-media", "remote-artifacts",
      String(thread.id || "").replace(/[^a-zA-Z0-9_.-]/g, "_")) + path.sep;
    const alreadyRemoteStaged = attachment.source === "remote_runtime_attachment_staged" &&
      path.resolve(attachment.path).startsWith(remoteRoot);
    const stored = alreadyRemoteStaged ? { path: attachment.path } : await materializeSandboxArtifact({
      thread, filename: attachment.filename || attachment.name || path.basename(attachment.path),
      buffer: source.buffer, sha256, env,
    });
    result.push({
      ...attachment, path: stored.path, saved_path: stored.path, size: source.buffer.length,
      outboundSnapshot: {
        version: 1, scope: scope(thread), sha256,
        sourcePathHash: attachment.outboundSnapshot?.sourcePathHash || digest(path.resolve(attachment.path)),
      },
    });
  }
  return result;
}

export function snapshotCoversPath(attachments, filePath) {
  if (!filePath) return false;
  const hash = digest(path.resolve(filePath));
  return attachments.some(item => item.outboundSnapshot?.sourcePathHash === hash);
}

export function requiredOutboundSnapshots(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map(item => item?.encrypted === true ? item.deliverySource : item)
    .filter(item => item?.outboundSnapshot)
    .map(item => ({ path: item.path, outboundSnapshot: item.outboundSnapshot }));
}

export function assertRequiredSnapshotsPresent(required = [], attachments = [], skipped = []) {
  for (const item of required) {
    if (skipped.some(value => value.path === item.path) || !attachments.some(value =>
      value.path === item.path && value.outboundSnapshot?.sha256 === item.outboundSnapshot.sha256)) {
      throw failure("not_sendable");
    }
  }
}

// Also run immediately before transport, including retries from durable outbox
// payloads. Do not silently send different bytes if a staged file is changed.
export async function validateOutboundSnapshots(attachments, env = process.env) {
  for (const attachment of attachments || []) {
    if (!attachment.outboundSnapshot) continue;
    const source = await readSandboxArtifactSource(attachment.path, sandboxArtifactMaxBytes(env));
    if (!source.ok || digest(source.buffer) !== attachment.outboundSnapshot.sha256) throw failure("integrity_failed");
  }
}
