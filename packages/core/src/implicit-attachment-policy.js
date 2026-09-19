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

export function rejectImplicitAttachment(candidate, filePath, skipped) {
  if (!implicitAttachmentSource(candidate.source) || !implicitAttachmentSensitive(filePath)) return false;
  skipped.push({ path: "", raw: "", reason: "attachment_requires_explicit_selection" });
  return true;
}
