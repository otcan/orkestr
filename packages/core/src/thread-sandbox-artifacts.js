import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";

const markdownLinkPattern = /!?\[[^\]\n]*]\(([^)\n]+)\)/g;
const plainSandboxUriPattern = /(?:sandbox:\/(?!\/)|file:\/\/\/)[^\s<>"'`\])}]+/gi;
const trailingUriPunctuationPattern = /[.,;:!?]+$/;

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

export function safeSandboxArtifactFilename(value = "artifact") {
  return path.basename(String(value || "artifact"))
    .replace(/[^a-zA-Z0-9_. -]/g, "_")
    .slice(0, 200) || "artifact";
}

export function sandboxArtifactMaxBytes(env = process.env) {
  const value = Number(
    env.ORKESTR_THREAD_ATTACHMENT_MAX_BYTES ||
      env.ORKESTR_THREAD_ARTIFACT_MAX_BYTES ||
      25 * 1024 * 1024,
  );
  return Number.isFinite(value) && value > 0 ? value : 25 * 1024 * 1024;
}

function uriReferenceHash(scheme, filePath) {
  return crypto.createHash("sha256").update(`${scheme}\n${filePath}`).digest("hex");
}

function parseSandboxArtifactUri(value = "") {
  const target = String(value || "").trim().replace(/^<|>$/g, "");
  const match = target.match(/^(sandbox:|file:)(.*)$/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const suffix = match[2];
  const supported = scheme === "sandbox:"
    ? suffix.startsWith("/") && !suffix.startsWith("//")
    : suffix.startsWith("///") && !suffix.startsWith("////");
  if (!supported) {
    return { ok: false, reason: "attachment_uri_not_absolute", scheme, filename: "artifact" };
  }
  const encodedPath = scheme === "file:" ? suffix.slice(2) : suffix;
  if (encodedPath.includes("?") || encodedPath.includes("#")) {
    return { ok: false, reason: "attachment_uri_ambiguous", scheme, filename: "artifact" };
  }
  let decoded = "";
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return { ok: false, reason: "attachment_uri_invalid_encoding", scheme, filename: "artifact" };
  }
  const filename = safeSandboxArtifactFilename(path.basename(decoded));
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || !path.isAbsolute(decoded)) {
    return { ok: false, reason: "attachment_uri_not_absolute", scheme, filename };
  }
  if (decoded.split(/[\\/]+/g).includes("..")) {
    return { ok: false, reason: "attachment_uri_traversal", scheme, filename };
  }
  const filePath = path.resolve(decoded);
  return {
    ok: true,
    scheme,
    path: filePath,
    filename,
    uriHash: uriReferenceHash(scheme, filePath),
  };
}

function referenceForMatch({ raw, target, start, end, source }) {
  const parsed = parseSandboxArtifactUri(target);
  if (!parsed) return null;
  return { ...parsed, raw, target, start, end, source };
}

export function extractSandboxArtifactUriReferences(text = "") {
  const source = String(text || "");
  const references = [];
  const markdownRanges = [];
  for (const match of source.matchAll(markdownLinkPattern)) {
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    const reference = referenceForMatch({
      raw: match[0],
      target: match[1],
      start,
      end,
      source: "sandbox_markdown_uri",
    });
    if (!reference) continue;
    references.push(reference);
    markdownRanges.push([start, end]);
  }
  for (const match of source.matchAll(plainSandboxUriPattern)) {
    const start = Number(match.index || 0);
    if (markdownRanges.some(([left, right]) => start >= left && start < right)) continue;
    const raw = match[0].replace(trailingUriPunctuationPattern, "");
    const reference = referenceForMatch({
      raw,
      target: raw,
      start,
      end: start + raw.length,
      source: "sandbox_plain_uri",
    });
    if (reference) references.push(reference);
  }
  return references.sort((left, right) => left.start - right.start);
}

export function sandboxArtifactPathCandidates(text = "") {
  return extractSandboxArtifactUriReferences(text).map((reference) => reference.ok
    ? {
        path: reference.path,
        raw: reference.raw,
        filename: reference.filename,
        sandboxArtifact: true,
        sandboxUriHash: reference.uriHash,
        source: reference.source,
      }
    : {
        invalid: true,
        raw: reference.raw,
        filename: reference.filename,
        reason: reference.reason,
        sandboxArtifact: true,
        source: reference.source,
      });
}

export function rewriteSandboxArtifactUris(text = "", references = [], acceptedUriHashes = new Set()) {
  let rewritten = String(text || "");
  for (const reference of [...references].sort((left, right) => right.start - left.start)) {
    const accepted = reference.ok && acceptedUriHashes.has(reference.uriHash);
    const replacement = accepted
      ? `Attached: ${safeSandboxArtifactFilename(reference.filename)}`
      : "Attachment unavailable";
    rewritten = `${rewritten.slice(0, reference.start)}${replacement}${rewritten.slice(reference.end)}`;
  }
  return rewritten;
}

export async function readSandboxArtifactSource(filePath, maxBytes) {
  const expectedPath = path.resolve(String(filePath || ""));
  const confirmedPath = await fs.realpath(expectedPath).catch(() => "");
  if (!confirmedPath) return { ok: false, reason: "attachment_path_missing" };
  if (confirmedPath !== expectedPath) return { ok: false, reason: "attachment_path_changed" };
  let handle = null;
  try {
    handle = await fs.open(expectedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, reason: "attachment_path_not_file" };
    if (stats.size > maxBytes) {
      return { ok: false, reason: "attachment_too_large", size: stats.size, maxBytes };
    }
    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) {
      return { ok: false, reason: "attachment_too_large", size: buffer.length, maxBytes };
    }
    return { ok: true, buffer, stats };
  } catch {
    return { ok: false, reason: "attachment_read_failed" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function materializeSandboxArtifact({ thread = {}, filename = "artifact", buffer, sha256 = "", env = process.env } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const digest = pickString(sha256) || crypto.createHash("sha256").update(bytes).digest("hex");
  const paths = dataPaths(env);
  const artifactDir = path.join(paths.home, "uploads", safeThreadId(pickString(thread.id, thread.threadId)), "artifacts");
  const storedName = `${digest}-${safeSandboxArtifactFilename(filename)}`;
  const destination = path.join(artifactDir, storedName);
  await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await fs.chmod(artifactDir, 0o700);
  const existingStats = await fs.lstat(destination).catch(() => null);
  const existing = existingStats?.isFile() && !existingStats.isSymbolicLink()
    ? await fs.readFile(destination).catch(() => null)
    : null;
  if (existing && crypto.createHash("sha256").update(existing).digest("hex") === digest) {
    return { path: destination, sha256: digest, reused: true };
  }
  const temporary = path.join(artifactDir, `.${storedName}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (error?.code !== "EEXIST") throw error;
    const concurrentStats = await fs.lstat(destination).catch(() => null);
    const concurrent = concurrentStats?.isFile() && !concurrentStats.isSymbolicLink()
      ? await fs.readFile(destination).catch(() => null)
      : null;
    if (!concurrent || crypto.createHash("sha256").update(concurrent).digest("hex") !== digest) {
      throw new Error("sandbox_artifact_materialization_conflict");
    }
  }
  await fs.chmod(destination, 0o600).catch(() => {});
  return { path: destination, sha256: digest, reused: false };
}

export async function resolveSandboxArtifactCandidate({ candidate, thread, env, classifyPath, metadataForPath } = {}) {
  const outcome = (status, reason = "", extra = {}) => ({
    status,
    filename: safeSandboxArtifactFilename(candidate?.filename || "artifact"),
    reason,
    ...extra,
  });
  let realPath = path.resolve(String(candidate?.path || ""));
  try {
    realPath = await fs.realpath(realPath);
  } catch {
    return {
      skipped: { path: candidate?.path || "", raw: "", reason: "attachment_path_missing" },
      outcome: outcome("skipped", "attachment_path_missing"),
    };
  }
  const policy = classifyPath(realPath);
  if (!policy.ok) {
    return {
      skipped: { path: realPath, raw: "", reason: policy.reason },
      outcome: outcome("skipped", policy.reason),
    };
  }
  const source = await readSandboxArtifactSource(realPath, sandboxArtifactMaxBytes(env));
  if (!source.ok) {
    const details = {
      ...(source.size ? { size: source.size } : {}),
      ...(source.maxBytes ? { maxBytes: source.maxBytes } : {}),
    };
    return {
      skipped: { path: realPath, raw: "", reason: source.reason, ...details },
      outcome: outcome("skipped", source.reason, details),
    };
  }
  const sha256 = crypto.createHash("sha256").update(source.buffer).digest("hex");
  const materialized = await materializeSandboxArtifact({
    thread,
    filename: candidate.filename || path.basename(realPath),
    buffer: source.buffer,
    sha256,
    env,
  });
  const durableStats = await fs.stat(materialized.path);
  const attachment = metadataForPath({
    ...candidate,
    attachment: {
      filename: candidate.filename || path.basename(realPath),
      source: "sandbox_artifact",
      sandboxUriHash: candidate.sandboxUriHash,
      sha256,
      materialized: true,
    },
  }, materialized.path, durableStats);
  return {
    attachment,
    outcome: outcome(materialized.reused ? "reused" : "materialized", "", {
      attachmentId: attachment.id,
      size: attachment.size,
    }),
  };
}
