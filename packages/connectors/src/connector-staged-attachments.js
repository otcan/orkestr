import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function clean(value = "") {
  return String(value || "").trim();
}

function stageRoot(env = process.env) {
  const home = clean(env.ORKESTR_HOME);
  if (!home) throw Object.assign(new Error("orkestr_home_required"), { statusCode: 503 });
  return path.resolve(clean(env.ORKESTR_CONNECTOR_STAGE_DIR) || path.join(home, "data", "connector-stage"));
}

function safeFilename(value = "attachment") {
  return path.basename(clean(value) || "attachment").replace(/[^A-Za-z0-9_. -]/g, "_").slice(0, 200) || "attachment";
}

function refPath(ref = "", env = process.env) {
  const value = clean(ref);
  if (!/^att_[A-Za-z0-9_-]{20,120}$/.test(value)) throw Object.assign(new Error("connector_attachment_ref_invalid"), { statusCode: 400 });
  return path.join(stageRoot(env), `${value}.json`);
}

export async function stageConnectorAttachment({ bytes, filename = "attachment", mimeType = "application/octet-stream", expiresAt = "" } = {}, env = process.env) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const maxBytes = Math.max(1, Number(env.ORKESTR_CONNECTOR_STAGE_MAX_BYTES || 25 * 1024 * 1024) || 25 * 1024 * 1024);
  if (!payload.length) throw Object.assign(new Error("connector_attachment_empty"), { statusCode: 400 });
  if (payload.length > maxBytes) throw Object.assign(new Error("connector_attachment_too_large"), { statusCode: 413 });
  const root = stageRoot(env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const ref = `att_${crypto.randomBytes(24).toString("base64url")}`;
  const filePath = path.join(root, `${ref}-${safeFilename(filename)}`);
  const metadataPath = refPath(ref, env);
  await fs.writeFile(filePath, payload, { mode: 0o600, flag: "wx" });
  await fs.writeFile(metadataPath, JSON.stringify({
    ref,
    filename: safeFilename(filename),
    mimeType: clean(mimeType) || "application/octet-stream",
    filePath,
    size: payload.length,
    createdAt: new Date().toISOString(),
    expiresAt: clean(expiresAt) || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }), { mode: 0o600, flag: "wx" });
  return { ref, filename: safeFilename(filename), mimeType: clean(mimeType), size: payload.length };
}

export async function resolveConnectorAttachmentRefs(refs = [], env = process.env) {
  const root = stageRoot(env);
  const resolved = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const metadata = JSON.parse(await fs.readFile(refPath(ref, env), "utf8"));
    if (clean(metadata.ref) !== clean(ref)) throw Object.assign(new Error("connector_attachment_ref_mismatch"), { statusCode: 403 });
    if (Date.parse(metadata.expiresAt || "") <= Date.now()) throw Object.assign(new Error("connector_attachment_ref_expired"), { statusCode: 410 });
    const filePath = path.resolve(clean(metadata.filePath));
    if (!filePath.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("connector_attachment_scope_denied"), { statusCode: 403 });
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size !== Number(metadata.size)) throw Object.assign(new Error("connector_attachment_invalid"), { statusCode: 409 });
    resolved.push({ ref: clean(ref), path: filePath, filename: safeFilename(metadata.filename), mimeType: clean(metadata.mimeType), size: stats.size });
  }
  return resolved;
}
