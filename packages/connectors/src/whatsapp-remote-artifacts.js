import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRemoteThreadAttachmentDescriptor } from "../../core/src/thread-attachments.js";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import {
  backendForBinding,
  remoteEndpointUrl,
  remoteHeaders,
  remoteWhatsAppRuntimeBinding,
} from "./whatsapp-remote-runtime.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function safeFilePart(value = "", fallback = "attachment") {
  return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || fallback;
}

function remoteAttachmentId(attachment = {}) {
  return pickString(attachment.remoteAttachmentId, attachment.remoteArtifactId, attachment.artifactId);
}

function remoteAttachmentMaxBytes(env = process.env) {
  const value = Number(
    env.ORKESTR_WHATSAPP_REMOTE_ATTACHMENT_MAX_BYTES ||
      env.ORKESTR_REMOTE_ARTIFACT_MAX_BYTES ||
      25 * 1024 * 1024,
  );
  return Number.isFinite(value) && value > 0 ? value : 25 * 1024 * 1024;
}

function responseHeader(response, name) {
  const lower = String(name || "").toLowerCase();
  if (typeof response?.headers?.get === "function") return response.headers.get(lower) || response.headers.get(name) || "";
  return response?.headers?.[lower] || response?.headers?.[name] || "";
}

function remoteRelativeUrl(backend, value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return new URL(raw);
  if (raw.startsWith("/")) return new URL(raw, `${backend.baseUrl}/`);
  return remoteEndpointUrl(backend, raw);
}

function remoteAttachmentUrls(backend, remote, attachment = {}) {
  const urls = [];
  const add = (url) => {
    if (!url) return;
    const key = String(url);
    if (!urls.some((entry) => String(entry) === key)) urls.push(url);
  };
  add(remoteRelativeUrl(backend, pickString(attachment.remoteDownloadUrl, attachment.downloadUrl)));
  const id = encodeURIComponent(remoteAttachmentId(attachment));
  const threadId = encodeURIComponent(pickString(attachment.remoteThreadId, remote.remoteThreadId));
  if (id && threadId) {
    add(remoteEndpointUrl(backend, `threads/${threadId}/attachments/${id}/download`));
    add(remoteEndpointUrl(backend, `api/threads/${threadId}/attachments/${id}/download`));
  }
  return urls;
}

function remoteArtifactSkip(attachment = {}, reason, extra = {}) {
  return {
    reason,
    filename: pickString(attachment.filename, attachment.name, "attachment"),
    remoteAttachmentId: remoteAttachmentId(attachment),
    remoteThreadId: pickString(attachment.remoteThreadId),
    remoteBackend: pickString(attachment.remoteBackend),
    ...extra,
  };
}

async function fetchRemoteAttachment({ backend, remote, attachment, env, fetchImpl }) {
  const maxBytes = remoteAttachmentMaxBytes(env);
  const declaredSize = Number(attachment.size || 0) || 0;
  if (declaredSize > maxBytes) {
    return { skipped: remoteArtifactSkip(attachment, "remote_attachment_too_large", { size: declaredSize, maxBytes }) };
  }
  let missing = null;
  for (const url of remoteAttachmentUrls(backend, remote, attachment)) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: remoteHeaders(backend, { accept: "application/octet-stream" }),
        signal: AbortSignal.timeout(backend.timeoutMs),
      });
    } catch (error) {
      return { skipped: remoteArtifactSkip(attachment, "remote_attachment_fetch_failed", { error: error.message || String(error) }) };
    }
    if (response.status === 404) {
      missing = remoteArtifactSkip(attachment, "remote_attachment_missing", { status: response.status });
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      return { skipped: remoteArtifactSkip(attachment, "remote_attachment_forbidden", { status: response.status }) };
    }
    if (!response.ok) {
      return { skipped: remoteArtifactSkip(attachment, "remote_attachment_fetch_failed", { status: response.status }) };
    }
    if (typeof response.arrayBuffer !== "function") {
      return { skipped: remoteArtifactSkip(attachment, "remote_attachment_fetch_failed", { error: "array_buffer_unavailable" }) };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { skipped: remoteArtifactSkip(attachment, "remote_attachment_empty") };
    if (buffer.length > maxBytes) {
      return { skipped: remoteArtifactSkip(attachment, "remote_attachment_too_large", { size: buffer.length, maxBytes }) };
    }
    return {
      buffer,
      mimetype: pickString(responseHeader(response, "content-type"), attachment.mimetype, "application/octet-stream"),
    };
  }
  return { skipped: missing || remoteArtifactSkip(attachment, "remote_attachment_missing") };
}

async function stageRemoteAttachment({ thread, message, attachment, buffer, mimetype, env }) {
  const paths = dataPaths(env);
  const dir = path.join(
    paths.home,
    "whatsapp-bridge",
    "outbound-media",
    "remote-artifacts",
    safeFilePart(thread?.id || "thread"),
    safeFilePart(message?.id || "message"),
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const filename = safeFilePart(pickString(attachment.filename, attachment.name, "attachment"));
  const filePath = path.join(dir, `${sha256.slice(0, 16)}-${filename}`);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  const { id: _id, path: _path, saved_path: _savedPath, savedPath: _savedPathCamel, localPath: _localPath, filePath: _filePath, downloadable: _downloadable, remote: _remote, ...rest } = attachment;
  return {
    ...rest,
    kind: pickString(attachment.kind, mimetype.startsWith("image/") ? "image" : "file"),
    filename,
    name: pickString(attachment.name, filename),
    mimetype,
    size: buffer.length,
    sha256,
    source: "remote_runtime_attachment_staged",
    path: filePath,
    saved_path: filePath,
    downloadable: true,
  };
}

function remoteAttachmentMatchesThread(attachment = {}, remote = {}) {
  const backend = pickString(attachment.remoteBackend);
  if (backend && backend !== remote.backendId) return false;
  const threadId = pickString(attachment.remoteThreadId);
  return !threadId || threadId === remote.remoteThreadId;
}

export async function materializeRemoteWhatsAppAttachments({ thread, message, attachments = [], env = process.env, fetchImpl = fetch } = {}) {
  const remoteDescriptors = (Array.isArray(attachments) ? attachments : []).filter(isRemoteThreadAttachmentDescriptor);
  if (!remoteDescriptors.length) return { attachments: [], skipped: [] };
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  const skipped = [];
  const materialized = [];
  if (!remote) {
    return {
      attachments: [],
      skipped: remoteDescriptors.map((attachment) => remoteArtifactSkip(attachment, "remote_runtime_binding_missing")),
    };
  }
  let backend;
  try {
    backend = backendForBinding(remote.binding, env);
  } catch (error) {
    return {
      attachments: [],
      skipped: remoteDescriptors.map((attachment) => remoteArtifactSkip(attachment, "remote_backend_not_configured", { error: error.message || String(error) })),
    };
  }
  for (const attachment of remoteDescriptors) {
    if (!remoteAttachmentId(attachment)) {
      skipped.push(remoteArtifactSkip(attachment, "remote_attachment_id_missing"));
      continue;
    }
    if (!remoteAttachmentMatchesThread(attachment, remote)) {
      skipped.push(remoteArtifactSkip(attachment, "remote_attachment_thread_mismatch"));
      continue;
    }
    const fetched = await fetchRemoteAttachment({ backend, remote, attachment, env, fetchImpl });
    if (fetched.skipped) {
      skipped.push(fetched.skipped);
      continue;
    }
    const staged = await stageRemoteAttachment({
      thread,
      message,
      attachment,
      buffer: fetched.buffer,
      mimetype: fetched.mimetype,
      env,
    });
    materialized.push(staged);
    await appendEvent({
      type: "whatsapp_remote_artifact_staged",
      threadId: thread?.id || null,
      messageId: message?.id || null,
      remoteBackend: remote.backendId,
      remoteThreadId: remote.remoteThreadId,
      remoteAttachmentId: remoteAttachmentId(attachment),
      filename: staged.filename,
      size: staged.size,
    }, env).catch(() => {});
  }
  for (const item of skipped) {
    await appendEvent({
      type: "whatsapp_remote_artifact_skipped",
      threadId: thread?.id || null,
      messageId: message?.id || null,
      ...item,
    }, env).catch(() => {});
  }
  return { attachments: materialized, skipped };
}
