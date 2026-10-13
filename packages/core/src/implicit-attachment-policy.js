import path from "node:path";

// A path mentioned in prose is not approval to export configuration/credentials.
// Explicit attachments still pass the canonical owner/path/sanitizer checks.
export function implicitAttachmentSensitive(filePath = "") {
  const name = path.basename(String(filePath)).toLowerCase();
  return /^\.env(?:\.|$)/.test(name) || /^(?:credentials?|tokens?|secrets?)\.(?:json|ya?ml|toml|ini)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name) || /\.(?:pem|key|p12|pfx|kdbx)$/.test(name)
    || [".npmrc", ".netrc", ".pgpass", "kubeconfig"].includes(name);
}

export function implicitAttachmentSource(source) {
  return ["markdown_link", "plain_path", "sandbox_markdown_uri", "sandbox_plain_uri"].includes(source);
}

// A bare path in prose is never an attachment request. A Markdown link is one
// when its label describes the file ("[three pending drafts](/…/drafts.md)"),
// but not when the label is just the file's name or path, which is how agents
// cite source files ("[server.ts](/repo/src/server.ts)") in coding threads.
export function isProseFilesystemMention(source) {
  return source === "plain_path";
}

function normalizedLabel(label = "") {
  return String(label || "").trim().replace(/^`+|`+$/g, "").replace(/:\d+(?::\d+)?$/, "").toLowerCase();
}

export function markdownLinkNamesFile(label = "", filePath = "") {
  const text = normalizedLabel(label);
  if (!text) return true;
  const base = path.basename(String(filePath)).toLowerCase();
  const full = String(filePath).toLowerCase();
  if (text === base || text === full) return true;
  // Path-like labels ("src/server.ts", "./README.md") are citations.
  return /[\\/]/.test(text) && full.endsWith(text.replace(/^\.\//, ""));
}

export function rejectImplicitAttachment(candidate, filePath, skipped, roots = null) {
  // The prose/citation rules judge links found in message text. A stored
  // attachment (re-resolved during staging) keeps its source tag but not its
  // label, and was already accepted, so only the sensitive-file check applies.
  const fromText = !candidate.attachment;
  const citation = fromText && candidate.source === "markdown_link" && markdownLinkNamesFile(candidate.label, filePath);
  if ((fromText && isProseFilesystemMention(candidate.source)) || citation) {
    skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
    return true;
  }
  if (!implicitAttachmentSource(candidate.source)) return false;
  const reason = roots ? implicitTextPathRefusal(filePath, roots) : implicitAttachmentSensitive(filePath) ? "attachment_requires_explicit_selection" : "";
  if (!reason) return false;
  skipped.push({ path: "", raw: "", reason });
  return true;
}

const internalDataExtension = /\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$|\.(?:jsonl|ndjson)(?:\.gz)?$/i;
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// A file linked or named in message text is never attached from Orkestr's own
// data directory (roots.home) unless it is in a shareable folder inside it
// (uploads, WhatsApp media, the thread's workspace). Audit replies cite
// databases and logs as evidence; that is not a request to export them. A
// broader allowed root that contains the data directory (tmp, /home) does not
// exempt it. Explicit attachments keep the regular owner/path policy.
export function implicitInternalDataPath(filePath = "", roots = {}) {
  const home = roots.home ? path.resolve(roots.home) : "";
  const resolved = path.resolve(String(filePath || ""));
  if (!home || !inside(home, resolved)) return false;
  const shareable = (roots.allowed || []).filter((root) => root !== home && inside(home, root));
  if (shareable.some((root) => inside(root, resolved))) return false;
  return path.dirname(resolved) === home || internalDataExtension.test(path.basename(resolved));
}

// Why a text-sourced path must not be attached implicitly, or "".
export function implicitTextPathRefusal(filePath = "", roots = {}) {
  if (implicitAttachmentSensitive(filePath)) return "attachment_requires_explicit_selection";
  return implicitInternalDataPath(filePath, roots) ? "attachment_internal_data_requires_explicit_selection" : "";
}
