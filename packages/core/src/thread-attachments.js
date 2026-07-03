import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAdminPrincipal, resourceOwnerUserId } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";
import { dataPaths } from "../../storage/src/paths.js";

const explicitPathKeys = ["path", "saved_path", "filePath", "localPath"];
const markdownLinkPattern = /!?\[[^\]\n]*]\(([^)\n]+)\)/g;
const plainAbsolutePathPattern = /(^|[\s([{"'`])((?:\/[^\s()[\]{}<>"'`|]+)+)/g;
const trailingPathPunctuationPattern = /[.,;:!?]+$/;
const applicationRoutePrefixes = new Set(["api"]);
const registeredSlashCommands = new Set([
  "approve",
  "code",
  "codex",
  "coding",
  "connect",
  "deny",
  "hard-reset",
  "hard_reset",
  "help",
  "implement",
  "interrupt",
  "now",
  "plan",
  "planning",
  "reset",
  "restart",
  "safe-reset",
  "safe_reset",
  "stop",
]);

const mimeByExtension = new Map([
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function truthyEnv(value = "") {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function safeFileName(value = "attachment") {
  return path.basename(String(value || "attachment")).replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 240) || "attachment";
}

function normalizeRoot(value = "") {
  const resolved = path.resolve(String(value || ""));
  return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, "");
}

function pathInside(root, candidate) {
  if (!root || !candidate) return false;
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingRoot(value = "") {
  const text = String(value || "").trim();
  return text ? normalizeRoot(text) : "";
}

function addRoot(roots, value) {
  const root = existingRoot(value);
  if (root && !roots.includes(root)) roots.push(root);
}

function addAllowedRoot(roots, value) {
  const root = existingRoot(value);
  if (!root || root === path.parse(root).root) return;
  if (!roots.includes(root)) roots.push(root);
}

function configuredAttachmentAllowedRoots(env = process.env) {
  const configured = pickString(
    env.ORKESTR_THREAD_ATTACHMENT_ALLOWED_ROOTS,
    env.ORKESTR_ADMIN_THREAD_ATTACHMENT_ALLOWED_ROOTS,
  );
  const defaults = [
    os.tmpdir(),
    path.sep === "/" ? "/var/tmp" : "",
  ];
  const extra = configured
    .split(/[,\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...defaults, ...extra];
}

function adminOwnedThread(thread = {}, env = process.env) {
  return normalizeUserId(resourceOwnerUserId(thread, env)) === normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function adminAttachmentAllowAnyPath(thread = {}, env = process.env) {
  if (!adminOwnedThread(thread, env)) return false;
  return truthyEnv(
    env.ORKESTR_ADMIN_THREAD_ATTACHMENT_ALLOW_ANY_PATH ||
      env.ORKESTR_THREAD_ATTACHMENT_ALLOW_ANY_PATH,
  );
}

function threadAttachmentRoots(thread = {}, env = process.env) {
  const paths = dataPaths(env);
  const allowed = [];
  const denied = [];
  const home = normalizeRoot(paths.home);
  const threadId = pickString(thread.id, thread.threadId);

  addRoot(allowed, path.join(home, "uploads", threadId));
  addRoot(allowed, path.join(home, "uploads", safeThreadId(threadId)));
  addRoot(allowed, path.join(home, "whatsapp-bridge", "outbound-media"));
  addRoot(allowed, path.join(home, "whatsapp-bridge", "inbound-media"));
  for (const key of ["cwd", "workspace", "repoPath", "worktreePath"]) {
    addAllowedRoot(allowed, thread[key]);
  }
  if (adminOwnedThread(thread, env)) {
    for (const root of configuredAttachmentAllowedRoots(env)) addAllowedRoot(allowed, root);
  }

  addRoot(denied, paths.secrets);
  addRoot(denied, paths.oauth);
  addRoot(denied, paths.browsers);
  addRoot(denied, path.join(home, "whatsapp-bridge", "sessions"));
  addRoot(denied, path.join(home, "whatsapp-bridge", "web-cache"));
  addRoot(denied, path.join(home, "whatsapp-bridge", "qrs"));
  addRoot(denied, env.ORKESTR_OVERLAY_DIR);
  addRoot(denied, env.CODEX_HOME && path.join(env.CODEX_HOME, "auth.json"));

  return { allowed, denied, home };
}

function userPrivatePathDenied(candidate, home) {
  const usersRoot = path.join(home, "users");
  if (!pathInside(usersRoot, candidate)) return false;
  const parts = path.relative(usersRoot, candidate).split(path.sep).filter(Boolean);
  return ["secrets", "oauth", "browsers"].includes(parts[1]);
}

export function classifyThreadAttachmentPath(filePath, { thread = {}, env = process.env } = {}) {
  const resolved = normalizeRoot(filePath);
  if (!path.isAbsolute(resolved)) return { ok: false, reason: "attachment_path_not_absolute", path: resolved };
  const roots = threadAttachmentRoots(thread, env);
  const deniedRoot = roots.denied.find((root) => pathInside(root, resolved));
  if (deniedRoot) return { ok: false, reason: "attachment_path_forbidden", path: resolved, deniedRoot };
  if (userPrivatePathDenied(resolved, roots.home)) return { ok: false, reason: "attachment_path_forbidden", path: resolved };
  if (adminAttachmentAllowAnyPath(thread, env)) return { ok: true, path: resolved, allowedRoot: "", allowAnyPath: true };
  const allowedRoot = roots.allowed.find((root) => pathInside(root, resolved));
  if (!allowedRoot) return { ok: false, reason: "attachment_path_not_allowed", path: resolved };
  return { ok: true, path: resolved, allowedRoot };
}

function decodePathCandidate(value = "") {
  const raw = String(value || "").trim().replace(/^<|>$/g, "");
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.toLowerCase().startsWith("file://")) return "";
  const local = raw.toLowerCase().startsWith("file://") ? raw.slice("file://".length) : raw;
  try {
    return decodeURIComponent(local);
  } catch {
    return local;
  }
}

function splitSourceLineReference(value = "") {
  const text = String(value || "");
  const withoutLine = text.match(/^(.*):\d+(?::\d+)?$/)?.[1] || "";
  return withoutLine && path.extname(withoutLine)
    ? { value: withoutLine, lineReference: true }
    : { value: text, lineReference: false };
}

function applicationRouteCandidate(value = "") {
  const match = decodePathCandidate(value).replace(trailingPathPunctuationPattern, "").match(/^\/([a-z][a-z0-9_-]*)(?:\/|$)/i);
  return Boolean(match && applicationRoutePrefixes.has(match[1].toLowerCase()));
}

function resolveTextCandidate(candidate = "", thread = {}) {
  const decoded = decodePathCandidate(candidate).replace(trailingPathPunctuationPattern, "");
  if (!decoded) return "";
  if (registeredSlashCommandCandidate(decoded)) return "";
  if (applicationRouteCandidate(decoded)) return "";
  const parsed = splitSourceLineReference(decoded);
  if (path.isAbsolute(parsed.value)) {
    return { path: path.resolve(parsed.value), raw: decoded, lineReference: parsed.lineReference };
  }
  if (!parsed.value.startsWith("./") && !parsed.value.startsWith("../")) return "";
  const base = pickString(thread.cwd, thread.workspace, thread.repoPath, thread.worktreePath);
  return base ? { path: path.resolve(base, parsed.value), raw: decoded, lineReference: parsed.lineReference } : "";
}

export function registeredSlashCommandCandidate(value = "") {
  const decoded = decodePathCandidate(value).replace(trailingPathPunctuationPattern, "");
  const match = decoded.match(/^\/([a-z][a-z0-9_-]*)(?:$|[\s:.,!?])/i) || decoded.match(/^\/([a-z][a-z0-9_-]*)$/i);
  if (!match) return false;
  return registeredSlashCommands.has(match[1].toLowerCase());
}

function textCandidateSource(source = "") {
  return source === "markdown_link" || source === "plain_path";
}

function shouldReportMissingCandidate(candidate = {}) {
  return !textCandidateSource(candidate.source) || (!candidate.lineReference && Boolean(path.extname(candidate.path)));
}

function attachmentPath(attachment = {}) {
  for (const key of explicitPathKeys) {
    const text = decodePathCandidate(attachment?.[key]);
    if (text) return text;
  }
  return "";
}

function remoteAttachmentId(attachment = {}) {
  return pickString(attachment.remoteAttachmentId, attachment.remoteArtifactId, attachment.artifactId);
}

export function isRemoteThreadAttachmentDescriptor(attachment = {}) {
  if (attachmentPath(attachment)) return false;
  const source = pickString(attachment.source).toLowerCase();
  return attachment.remote === true ||
    source === "remote_runtime_attachment" ||
    source === "remote_artifact" ||
    Boolean(remoteAttachmentId(attachment));
}

function remoteAttachmentDescriptorId(attachment = {}) {
  const existing = pickString(attachment.id);
  if (existing) return existing;
  const key = [
    pickString(attachment.remoteBackend),
    pickString(attachment.remoteThreadId),
    pickString(attachment.remoteMessageId),
    remoteAttachmentId(attachment),
  ].join("\n");
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return `ratt_${hash.slice(0, 32)}`;
}

function metadataForRemoteAttachment(attachment = {}) {
  if (!isRemoteThreadAttachmentDescriptor(attachment)) return null;
  const remoteId = remoteAttachmentId(attachment);
  const remoteThreadId = pickString(attachment.remoteThreadId);
  if (!remoteId || !remoteThreadId) return null;
  const filename = safeFileName(pickString(attachment.filename, attachment.name, remoteId));
  const mimetype = inferMimeType(filename, pickString(attachment.mimetype, attachment.type));
  const remoteDownloadUrl = pickString(attachment.remoteDownloadUrl, attachment.downloadUrl);
  return {
    id: remoteAttachmentDescriptorId(attachment),
    kind: inferKind(mimetype, attachment.kind),
    filename,
    name: pickString(attachment.name, filename),
    mimetype,
    size: Number(attachment.size || 0) || 0,
    source: pickString(attachment.source, "remote_runtime_attachment"),
    downloadable: false,
    remote: true,
    remoteBackend: pickString(attachment.remoteBackend),
    remoteThreadId,
    remoteMessageId: pickString(attachment.remoteMessageId),
    remoteAttachmentId: remoteId,
    ...(pickString(attachment.remoteArtifactId, attachment.artifactId) ? { remoteArtifactId: pickString(attachment.remoteArtifactId, attachment.artifactId) } : {}),
    ...(remoteDownloadUrl ? { remoteDownloadUrl } : {}),
    ...(pickString(attachment.sha256) ? { sha256: pickString(attachment.sha256) } : {}),
  };
}

export function extractThreadAttachmentPathCandidates({ text = "", attachments = [], thread = {} } = {}) {
  const candidates = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const filePath = attachmentPath(attachment);
    if (filePath) candidates.push({ path: path.resolve(filePath), attachment, source: pickString(attachment.source, "explicit_attachment") });
  }

  const source = String(text || "");
  for (const match of source.matchAll(markdownLinkPattern)) {
    const candidate = resolveTextCandidate(match[1], thread);
    if (candidate) candidates.push({ ...candidate, source: "markdown_link" });
  }
  for (const match of source.matchAll(plainAbsolutePathPattern)) {
    const candidate = resolveTextCandidate(match[2], thread);
    if (candidate) candidates.push({ ...candidate, source: "plain_path" });
  }
  return candidates;
}

function canExposeOrdinaryThreadPath({ thread = {}, principal = null, env = process.env } = {}) {
  if (principal) return isAdminPrincipal(principal);
  const owner = normalizeUserId(thread.ownerUserId || thread.userId || "");
  if (owner) return owner === normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  return resourceOwnerUserId(thread, env) === normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function localPathRedactionEnabled(env = process.env) {
  const raw = String(
    env.ORKESTR_REDACT_LOCAL_FILE_PATHS ||
      env.ORKESTR_OMIT_LOCAL_FILE_PATHS ||
      env.ORKESTR_LOCAL_FILE_PATH_OMISSION ||
      "",
  ).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function classifyThreadAttachmentPathRedaction(filePath, { thread = {}, principal = null, env = process.env } = {}) {
  const policy = classifyThreadAttachmentPath(filePath, { thread, env });
  const redactionEnabled = localPathRedactionEnabled(env);
  if (policy.ok) {
    return {
      ...policy,
      category: "ordinary_allowed",
      redact: redactionEnabled && !canExposeOrdinaryThreadPath({ thread, principal, env }),
    };
  }
  if (policy.reason === "attachment_path_forbidden") {
    return {
      ...policy,
      category: "sensitive_denied",
      redact: redactionEnabled,
    };
  }
  return {
    ...policy,
    category: "ordinary_denied",
    redact: redactionEnabled,
  };
}

function attachmentId(filePath, stats) {
  const hash = crypto
    .createHash("sha256")
    .update(`${filePath}\n${Number(stats?.size || 0)}\n${Number(stats?.mtimeMs || 0)}`)
    .digest("hex");
  return `att_${hash.slice(0, 32)}`;
}

function inferMimeType(filePath, fallback = "") {
  return pickString(fallback, mimeByExtension.get(path.extname(filePath).toLowerCase()), "application/octet-stream");
}

function inferKind(mimetype = "", fallback = "") {
  const kind = String(fallback || "").trim();
  if (kind) return kind;
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("text/")) return "document";
  return "file";
}

function metadataForAttachment(candidate, filePath, stats) {
  const original = candidate.attachment || {};
  const mimetype = inferMimeType(filePath, pickString(original.mimetype, original.type));
  const filename = safeFileName(pickString(original.filename, original.name, path.basename(filePath)));
  return {
    ...original,
    id: pickString(original.id) || attachmentId(filePath, stats),
    kind: inferKind(mimetype, original.kind),
    path: filePath,
    saved_path: filePath,
    filename,
    name: pickString(original.name, filename),
    mimetype,
    size: Number(stats.size || original.size || 0) || 0,
    source: pickString(original.source, candidate.source, "path_reference"),
    downloadable: original.downloadable === false ? false : true,
  };
}

function dedupeAttachments(attachments = []) {
  const byKey = new Map();
  for (const attachment of attachments) {
    const key = pickString(attachment.id, attachment.path);
    if (!key) continue;
    byKey.set(key, attachment);
  }
  return [...byKey.values()];
}

export async function resolveThreadAttachments({ thread = {}, text = "", attachments = [], env = process.env } = {}) {
  const remoteDescriptors = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const descriptor = metadataForRemoteAttachment(attachment);
    if (descriptor) remoteDescriptors.push(descriptor);
  }
  const resolved = [];
  const skipped = [];
  const seenPaths = new Set();
  for (const candidate of extractThreadAttachmentPathCandidates({ text, attachments, thread })) {
    if (textCandidateSource(candidate.source) && candidate.lineReference) continue;
    let realPath = path.resolve(candidate.path);
    try {
      realPath = await fs.realpath(realPath);
    } catch {
      if (shouldReportMissingCandidate(candidate)) {
        skipped.push({ path: candidate.path, raw: candidate.raw || "", reason: "attachment_path_missing" });
      }
      continue;
    }
    let stats = null;
    if (textCandidateSource(candidate.source)) {
      stats = await fs.stat(realPath).catch(() => null);
      if (!stats?.isFile()) {
        continue;
      }
    }
    if (seenPaths.has(realPath)) {
      continue;
    }
    const policy = classifyThreadAttachmentPath(realPath, { thread, env });
    if (!policy.ok) {
      skipped.push({ path: realPath, raw: candidate.raw || "", reason: policy.reason });
      continue;
    }
    seenPaths.add(realPath);
    stats ||= await fs.stat(realPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      skipped.push({ path: realPath, raw: candidate.raw || "", reason: "attachment_path_not_file" });
      continue;
    }
    resolved.push(metadataForAttachment(candidate, realPath, stats));
  }
  return { attachments: dedupeAttachments([...remoteDescriptors, ...resolved]), skipped };
}

export function attachmentDownloadUrl(threadId, attachment = {}) {
  const id = pickString(attachment.id);
  if (!id || attachment.downloadable === false) return "";
  return `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(id)}/download`;
}

export function addAttachmentDownloadUrls(thread = {}, message = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) return message;
  return {
    ...message,
    attachments: attachments.map((attachment) => {
      const downloadUrl = attachmentDownloadUrl(thread.id, attachment);
      return downloadUrl ? { ...attachment, downloadUrl } : { ...attachment };
    }),
  };
}

export async function resolveStoredThreadAttachment({ thread = {}, messages = [], attachmentId = "", env = process.env } = {}) {
  const wanted = pickString(attachmentId);
  if (!wanted) return { found: false, reason: "attachment_id_required" };
  for (const message of messages || []) {
    for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
      if (pickString(attachment.id) !== wanted) continue;
      const storedPath = attachmentPath(attachment);
      if (!storedPath) return { found: true, allowed: false, reason: "attachment_path_missing", attachment, message };
      const filePath = path.resolve(storedPath);
      const policy = classifyThreadAttachmentPath(filePath, { thread, env });
      if (!policy.ok) return { found: true, allowed: false, reason: policy.reason, attachment, message };
      const realPath = await fs.realpath(filePath).catch(() => "");
      if (!realPath) return { found: true, allowed: false, reason: "attachment_path_missing", attachment, message };
      const realPolicy = classifyThreadAttachmentPath(realPath, { thread, env });
      if (!realPolicy.ok) return { found: true, allowed: false, reason: realPolicy.reason, attachment, message };
      const stats = await fs.stat(realPath).catch(() => null);
      if (!stats?.isFile()) return { found: true, allowed: false, reason: "attachment_path_not_file", attachment, message };
      return {
        found: true,
        allowed: true,
        attachment: metadataForAttachment({ attachment, source: attachment.source }, realPath, stats),
        message,
        path: realPath,
      };
    }
  }
  return { found: false, reason: "attachment_not_found" };
}

export function redactDeniedThreadAttachmentPaths(text = "", { thread = {}, principal = null, env = process.env } = {}) {
  const source = String(text || "");
  let redacted = source;
  const denied = extractThreadAttachmentPathCandidates({ text: source, attachments: [], thread })
    .filter((candidate) => {
      const decision = classifyThreadAttachmentPathRedaction(candidate.path, { thread, principal, env });
      return decision.redact;
    })
    .map((candidate) => candidate.raw || candidate.path)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const raw of denied) {
    redacted = redacted.split(raw).join("[local file path omitted]");
  }
  return redacted;
}
