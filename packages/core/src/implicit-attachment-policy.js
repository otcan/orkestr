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

export function rejectImplicitAttachment(candidate, filePath, skipped) {
  const citation = candidate.source === "markdown_link" && markdownLinkNamesFile(candidate.label, filePath);
  if (isProseFilesystemMention(candidate.source) || citation) {
    skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
    return true;
  }
  if (!implicitAttachmentSource(candidate.source) || !implicitAttachmentSensitive(filePath)) return false;
  skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
  return true;
}
