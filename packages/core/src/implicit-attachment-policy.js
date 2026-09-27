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

// Ordinary prose mentions (a plain path or markdown link typed in a message) are not
// an attachment request; only structured attachments and explicit sandbox: / file:///
// artifact references may resolve to a file.
export function isProseFilesystemMention(source) {
  return source === "markdown_link" || source === "plain_path";
}

export function rejectImplicitAttachment(candidate, filePath, skipped) {
  if (isProseFilesystemMention(candidate.source)) {
    skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
    return true;
  }
  if (!implicitAttachmentSource(candidate.source) || !implicitAttachmentSensitive(filePath)) return false;
  skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
  return true;
}
