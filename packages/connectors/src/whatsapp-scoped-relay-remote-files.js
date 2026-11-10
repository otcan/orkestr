// Files of a remote-runtime (V2) reply for the scoped group relay.
//
// A remote reply names its files as descriptors only (no path, no bytes); the
// remote backend serves the bytes. The relay sends reply files from plaintext
// snapshots under `<uploads>/<threadId>/artifacts/<sha256>-<name>` (the
// worker's `replyMediaRoot` layout, re-hashed by the worker before sending),
// so each descriptor is fetched through the authenticated remote pipeline of
// this thread's own binding, checked against the declared digest and the
// worker's type and size limits, and staged there. A file that fails any step
// is left out; the relay then skips it once instead of sending something else.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRemoteThreadAttachmentDescriptor } from "../../core/src/thread-attachments.js";
import { materializeSandboxArtifact } from "../../core/src/thread-sandbox-artifacts.js";
import { materializeRemoteWhatsAppAttachments } from "./whatsapp-remote-artifacts.js";
import { SCOPED_FILE_MAX_BYTES, SCOPED_FILE_MIMETYPES } from "./whatsapp-scoped-reply-files.js";

// The relay waits 15 s for this answer; leave room for the response.
const REMOTE_FILES_BUDGET_MS = 10_000;
const SHA256 = /^[0-9a-f]{64}$/;
const FILENAME = /^[^/\\\0\r\n]{1,180}$/;

const baseType = (value) => String(value || "").split(";")[0].trim().toLowerCase();

function candidate(attachment) {
  if (!attachment?.id || attachment.encrypted === true || attachment.outboundSnapshot) return false;
  return isRemoteThreadAttachmentDescriptor(attachment);
}

async function stageOne({ thread, message, attachment, env, fetchImpl }) {
  const mimetype = baseType(attachment.mimetype);
  const declared = String(attachment.sha256 || "");
  const filename = path.basename(String(attachment.filename || attachment.name || ""));
  if (!SCOPED_FILE_MIMETYPES.has(mimetype) || (declared && !SHA256.test(declared)) ||
      !FILENAME.test(filename) || filename.startsWith(".") ||
      Number(attachment.size || 0) > SCOPED_FILE_MAX_BYTES) return null;
  const fetched = await materializeRemoteWhatsAppAttachments({ thread, message, attachments: [attachment], env, fetchImpl });
  const [staged] = fetched.attachments;
  if (!staged?.path || fetched.skipped.length) return null;
  try {
    const buffer = await fs.readFile(staged.path);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (!buffer.length || buffer.length > SCOPED_FILE_MAX_BYTES || (declared && sha256 !== declared)) return null;
    const stored = await materializeSandboxArtifact({ thread, filename, buffer, sha256, env });
    return { id: String(attachment.id), path: stored.path, filename, mimetype, sha256 };
  } finally {
    // The relay sends from the uploads snapshot only; keep one plaintext copy.
    await fs.rm(staged.path, { force: true }).catch(() => {});
  }
}

export async function scopedRelayRemoteReplyFiles({ thread = {}, message = {}, env = process.env, fetchImpl = fetch, budgetMs = REMOTE_FILES_BUDGET_MS } = {}) {
  if (String(message?.role || "").trim().toLowerCase() !== "assistant") return [];
  const remote = (Array.isArray(message.attachments) ? message.attachments : []).filter(candidate);
  const deadline = Date.now() + budgetMs;
  const files = [];
  for (const attachment of remote) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); });
    const file = await Promise.race([stageOne({ thread, message, attachment, env, fetchImpl }).catch(() => null), late]);
    clearTimeout(timer);
    if (file) files.push(file);
  }
  return files;
}
