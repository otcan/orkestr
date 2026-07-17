import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function clean(value = "") {
  return String(value || "").trim();
}

function mediaMaxBytes(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTOR_INBOX_MEDIA_MAX_BYTES || env.ORKESTR_WHATSAPP_INBOUND_MEDIA_FORWARD_MAX_BYTES || 25 * 1024 * 1024);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

function safeFileName(value = "", fallback = "attachment.bin") {
  const name = path.basename(clean(value) || fallback)
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 120);
  return name || fallback;
}

function localAttachmentPath(attachment = {}) {
  return clean(
    attachment.path ||
    attachment.saved_path ||
    attachment.savedPath ||
    attachment.filePath ||
    attachment.localPath,
  );
}

function mediaRoots(env = process.env) {
  const home = path.resolve(clean(env.ORKESTR_HOME) || ".");
  return [
    path.join(home, "whatsapp-bridge", "inbound-media"),
    path.join(home, "data", "connector-inbox-media"),
  ];
}

function pathWithin(filePath = "", root = "") {
  const relative = path.relative(root, filePath);
  return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readAllowedMedia(filePath = "", env = process.env) {
  const resolved = await fs.realpath(filePath).catch(() => "");
  if (!resolved) throw Object.assign(new Error("connector_inbox_media_source_missing"), { statusCode: 502 });
  const allowed = mediaRoots(env).some((root) => pathWithin(resolved, path.resolve(root)));
  if (!allowed) throw Object.assign(new Error("connector_inbox_media_source_forbidden"), { statusCode: 403 });
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error("connector_inbox_media_source_missing"), { statusCode: 502 });
  const maxBytes = mediaMaxBytes(env);
  if (stat.size > maxBytes) {
    throw Object.assign(new Error("connector_inbox_media_source_too_large"), {
      statusCode: 413,
      size: stat.size,
      maxBytes,
    });
  }
  return { path: resolved, buffer: await fs.readFile(resolved), size: stat.size };
}

function inboundMediaTarget(target = "") {
  try {
    const url = new URL(clean(target));
    url.pathname = "/api/connectors/whatsapp/inbound-media";
    url.search = "";
    url.hash = "";
    return String(url);
  } catch {
    return "";
  }
}

export function parseConnectorInboxMediaMetadata(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

export async function stageConnectorInboxMedia(files = [], metadata = [], body = {}, env = process.env) {
  if (!Array.isArray(files) || !files.length) {
    throw Object.assign(new Error("connector_inbox_media_files_required"), { statusCode: 400 });
  }
  const maxBytes = mediaMaxBytes(env);
  const home = path.resolve(clean(env.ORKESTR_HOME) || ".");
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(home, "data", "connector-inbox-media", date);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const attachments = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] || {};
    const meta = metadata[index] || {};
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);
    if (!buffer.length) throw Object.assign(new Error("connector_inbox_media_empty"), { statusCode: 400 });
    if (buffer.length > maxBytes) throw Object.assign(new Error("connector_inbox_media_too_large"), { statusCode: 413 });
    const filename = safeFileName(file.originalname || meta.filename || meta.name);
    const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}-${filename}`;
    const savedPath = path.join(outDir, storedName);
    await fs.writeFile(savedPath, buffer, { mode: 0o600 });
    attachments.push({
      name: clean(meta.name || filename),
      filename,
      mimetype: clean(file.mimetype || meta.mimetype || meta.type || "application/octet-stream"),
      kind: clean(meta.kind || "file"),
      size: buffer.length,
      path: savedPath,
      saved_path: savedPath,
      source: "connector_mcp_inbound_media_upload",
      sourceEventId: clean(body.eventId || meta.sourceEventId),
      chatId: clean(body.chatId || meta.chatId),
      accountId: clean(body.accountId || meta.accountId),
      uploadedAt: new Date().toISOString(),
    });
  }
  return attachments;
}

export async function prepareConnectorInboxMediaDelivery(payload = {}, route = {}, env = process.env, fetchImpl = fetch) {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!attachments.length) return payload;
  const target = inboundMediaTarget(route.target);
  if (!target) throw Object.assign(new Error("connector_inbox_media_target_missing"), { statusCode: 503 });
  if (payload.attachmentsUploadedToTarget === true && clean(payload.attachmentUploadTarget) === target) return payload;
  if (typeof FormData !== "function" || typeof Blob !== "function") {
    throw Object.assign(new Error("connector_inbox_media_formdata_unavailable"), { statusCode: 500 });
  }

  const form = new FormData();
  const slots = [];
  const metadata = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index] || {};
    const filePath = localAttachmentPath(attachment);
    if (!filePath) continue;
    const file = await readAllowedMedia(filePath, env);
    const filename = safeFileName(attachment.filename || attachment.name || path.basename(file.path));
    const mimetype = clean(attachment.mimetype || attachment.type || "application/octet-stream");
    form.append("files", new Blob([file.buffer], { type: mimetype }), filename);
    metadata.push({
      filename,
      name: clean(attachment.name || filename),
      mimetype,
      type: mimetype,
      kind: clean(attachment.kind || "file"),
      size: file.size,
      sourceEventId: clean(payload.eventId || payload.id || payload.messageId),
      chatId: clean(payload.chatId || payload.fromChatId),
      accountId: clean(payload.accountId),
    });
    slots.push(index);
  }
  if (!slots.length) return payload;
  form.append("metadata", JSON.stringify(metadata));
  form.append("eventId", clean(payload.eventId || payload.id || payload.messageId));
  form.append("chatId", clean(payload.chatId || payload.fromChatId));
  form.append("accountId", clean(payload.accountId));

  const response = await fetchImpl(target, {
    method: "POST",
    headers: route.token ? { authorization: `Bearer ${route.token}` } : {},
    body: form,
    signal: AbortSignal.timeout(Math.max(1000, Number(env.ORKESTR_CONNECTOR_INBOX_DELIVERY_TIMEOUT_MS || 60_000) || 60_000)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    const error = new Error(clean(result?.error) || `connector_inbox_media_http_${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const uploaded = Array.isArray(result.attachments) ? result.attachments : [];
  if (uploaded.length !== slots.length) {
    throw Object.assign(new Error("connector_inbox_media_upload_incomplete"), { statusCode: 502 });
  }
  let cursor = 0;
  const replaced = attachments.map((attachment, index) => slots.includes(index) ? uploaded[cursor++] : attachment);
  return {
    ...payload,
    attachments: replaced,
    attachmentsUploadedToTarget: true,
    attachmentUploadTarget: target,
  };
}
