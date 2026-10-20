// Uploads the files of one delegated inbound message to a remote runtime that
// advertises `attachmentUpload`. Only files V1 already accepted for this thread
// are read; local paths never leave this process. Any file that cannot be
// forwarded fails the whole forward visibly instead of silently dropping it.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyThreadAttachmentPath, isRemoteThreadAttachmentDescriptor } from "../../core/src/thread-attachments.js";

export const REMOTE_ATTACHMENT_MAX_FILES = 8;
export const REMOTE_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
const mediaTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function refuse(code) {
  const error = new Error(code);
  error.statusCode = 422;
  return error;
}

export function remoteAttachmentFilename(value = "") {
  let name = path.basename(String(value || "")).replace(/[\u0000-\u001f\u007f/\\:]/g, "_").trim();
  if (!name || name === "." || name === "..") name = "attachment";
  while (Buffer.byteLength(name) > 255) name = name.slice(0, -1);
  return name;
}

export function remoteAttachmentMediaType(value = "") {
  const type = pickString(value).split(";")[0].trim();
  return type.length <= 127 && mediaTypePattern.test(type) ? type : "application/octet-stream";
}

export async function uploadRemoteInputAttachments({ thread, message, post, env = process.env } = {}) {
  const attachments = (Array.isArray(message?.attachments) ? message.attachments : [])
    .filter((attachment) => !isRemoteThreadAttachmentDescriptor(attachment));
  if (!attachments.length) return [];
  if (attachments.length > REMOTE_ATTACHMENT_MAX_FILES) throw refuse("whatsapp_remote_attachment_count");
  const prepared = [];
  let total = 0;
  for (const attachment of attachments) {
    if (attachment?.encrypted === true) throw refuse("whatsapp_remote_attachment_encrypted");
    const filePath = pickString(attachment.path, attachment.saved_path, attachment.filePath, attachment.localPath);
    if (!filePath) throw refuse("whatsapp_remote_attachment_unavailable");
    const realPath = await fs.realpath(filePath).catch(() => "");
    const policy = realPath ? classifyThreadAttachmentPath(realPath, { thread, env }) : { ok: false };
    if (!policy.ok) throw refuse("whatsapp_remote_attachment_unavailable");
    const content = await fs.readFile(realPath).catch(() => null);
    if (!content) throw refuse("whatsapp_remote_attachment_unavailable");
    total += content.length;
    if (total > REMOTE_ATTACHMENT_MAX_BYTES) throw refuse("whatsapp_remote_attachment_too_large");
    prepared.push({
      publicMessageId: message.id,
      filename: remoteAttachmentFilename(pickString(attachment.filename, attachment.name, path.basename(realPath))),
      mediaType: remoteAttachmentMediaType(pickString(attachment.mimetype, attachment.type)),
      size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    });
  }
  const references = [];
  for (const body of prepared) {
    const payload = await post(body);
    const upload = payload?.upload || {};
    if (!pickString(upload.uploadId) || upload.sha256 !== body.sha256) throw refuse("whatsapp_remote_attachment_receipt");
    references.push({ uploadId: upload.uploadId, sha256: body.sha256 });
  }
  return references;
}
