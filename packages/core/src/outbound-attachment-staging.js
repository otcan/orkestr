import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { resourceOwnerUserId } from "./policy.js";
import { classifyThreadAttachmentPath, resolveThreadAttachments } from "./thread-attachments.js";
import { snapshotRoutedAttachments } from "./outbound-attachment-snapshots.js";
import { publishThreadAttachmentsEncrypted } from "./encrypted-attachment-publication.js";

const hash = value => createHash("sha256").update(value).digest("hex");
export const stagingFailureNotice = "File could not be attached. Delivery is pending and will retry; no attachment has been sent.";
const routed = (thread, message) => message.role === "assistant" &&
  (message.connector === "whatsapp" || thread.binding?.connector === "whatsapp");
const binding = (thread, message, env) => ({ ownerUserId: resourceOwnerUserId(thread, env), threadId: thread.id, messageId: message.id });
const directory = (thread, env) => path.join(dataPaths(env).home, "outbound-attachment-staging", hash(`${resourceOwnerUserId(thread, env)}\n${thread.id}`));
const fileFor = (thread, id, env) => {
  if (!/^stg_[a-f0-9]{64}$/.test(id || "")) throw new Error("outbound_attachment_staging_invalid");
  return path.join(directory(thread, env), `${id}.json`);
};

async function save(file, intent) {
  await writeSecretJson(file, intent);
  const handle = await fs.open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== "win32") {
    const dir = await fs.open(path.dirname(file), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

function checkBinding(intent, thread, message, env) {
  const expected = binding(thread, message, env);
  if (!intent || Object.entries(expected).some(([key, value]) => intent[key] !== value) ||
      intent.textHash !== hash(message.text || "")) throw new Error("outbound_attachment_staging_binding_mismatch");
}

function publicResult(intent) {
  const ready = intent.state === "ready";
  return {
    attachments: ready ? intent.attachments : [],
    encrypted: ready && intent.encrypted === true,
    staging: { id: intent.id, state: intent.state, ...(ready ? {} : { notice: stagingFailureNotice }) },
  };
}

async function attempt(file, intent, thread, message, env) {
  intent.attempts = (intent.attempts || 0) + 1;
  intent.updatedAt = new Date().toISOString();
  try {
    const resolved = await resolveThreadAttachments({ thread, attachments: intent.sources, env });
    if (resolved.skipped.length || resolved.attachments.length !== intent.sources.length) throw new Error("staging_source_unavailable");
    // Journal each successful copy so a later file/publication failure does not
    // make recovery depend on producer files already copied successfully.
    for (let index = 0; index < resolved.attachments.length; index++) {
      const [snapshot] = await snapshotRoutedAttachments({ thread, message, attachments: [resolved.attachments[index]], env });
      intent.sources[index] = snapshot;
      await save(file, intent);
    }
    const published = await publishThreadAttachmentsEncrypted({ thread, attachments: intent.sources, env });
    Object.assign(intent, { state: "ready", attachments: published.attachments, encrypted: published.encrypted === true, error: "" });
  } catch {
    // Never put source paths, filenames or provider errors in the public notice.
    Object.assign(intent, { state: "failed_retryable", attachments: [], error: "outbound_attachment_staging_failed" });
  }
  const configuredDelay = Number(env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS ?? 30_000);
  const delay = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 30_000;
  intent.nextAttemptAt = intent.state === "failed_retryable" ? new Date(Date.now() + Math.min(delay, 3600_000)).toISOString() : null;
  await save(file, intent);
  return publicResult(intent);
}

export async function prepareRoutedReplyAttachments({ thread, message, resolution, env = process.env }) {
  if (!routed(thread, message)) return message.role === "assistant"
    ? publishThreadAttachmentsEncrypted({ thread, attachments: resolution.attachments, env })
    : { attachments: resolution.attachments };
  // Remote runtime descriptors are materialized by their authenticated fetch
  // pipeline. A remote namespace path is not a missing local producer file.
  if (message.remoteBackend && message.remoteMessageId) {
    const attachments = await snapshotRoutedAttachments({ thread, message, attachments: resolution.attachments, env });
    return publishThreadAttachmentsEncrypted({ thread, attachments, env });
  }
  const missing = resolution.skipped.filter(item => item.reason === "attachment_path_missing" && item.path &&
    classifyThreadAttachmentPath(item.path, { thread, env }).ok)
    .map(item => ({ path: item.path, filename: path.basename(item.path), source: "explicit_attachment" }));
  const sources = [...new Map([...resolution.attachments, ...missing].map(item => [item.path || item.id || JSON.stringify(item), item])).values()];
  if (!sources.length) return { attachments: [] };
  if (sources.length > 20) throw new Error("outbound_attachment_staging_limit");
  const identity = { ...binding(thread, message, env), textHash: hash(message.text || ""), sources };
  const id = `stg_${hash(JSON.stringify(identity))}`;
  const file = fileFor(thread, id, env);
  return withStorageFileLock(file, async () => {
    let intent = await readJson(file, null);
    if (intent) checkBinding(intent, thread, message, env);
    else {
      intent = { version: 1, id, ...identity, state: "preparing", createdAt: new Date().toISOString() };
      await save(file, intent); // Durable private intent BEFORE source reads/copies.
    }
    return attempt(file, intent, thread, message, env);
  });
}

export function applyReplyAttachmentStaging(message, prepared) {
  if (prepared.staging) message.outboundAttachmentStaging = prepared.staging;
  else delete message.outboundAttachmentStaging;
  if (prepared.staging?.state === "failed_retryable") {
    message.deliveryState = "failed_retryable";
    message.deliveryError = stagingFailureNotice;
  } else if (message.deliveryError === stagingFailureNotice) {
    message.deliveryError = "";
    message.deliveryState = "pending";
  }
}

export async function recoverRoutedReplyAttachments(thread, message, env = process.env) {
  if (!routed(thread, message) || !message.outboundAttachmentStaging?.id) return null;
  const file = fileFor(thread, message.outboundAttachmentStaging.id, env);
  return withStorageFileLock(file, async () => {
    const intent = await readJson(file, null);
    checkBinding(intent, thread, message, env);
    if (intent.state === "ready" || Date.parse(intent.nextAttemptAt) > Date.now()) return publicResult(intent);
    return attempt(file, intent, thread, message, env);
  });
}

export function assertReplyAttachmentStagingReady(message) {
  if (message?.outboundAttachmentStaging && message.outboundAttachmentStaging.state !== "ready") {
    const error = new Error(stagingFailureNotice);
    error.retryable = true;
    throw error;
  }
}

// Conservative manifest retention: only unreferenced, completed journals are
// eligible. Pending journals and all actual artifact files are always retained.
export async function cleanupOutboundStagingJournals(thread, messages, env = process.env, options = {}) {
  if (!Array.isArray(messages)) throw new Error("staging_cleanup_reference_inventory_required");
  const referenced = new Set(messages.map(item => item.outboundAttachmentStaging?.id).filter(Boolean));
  const dir = directory(thread, env);
  const files = await fs.readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const eligible = [];
  for (const name of files) {
    const id = name.replace(/\.json$/, "");
    if (!/^stg_[a-f0-9]{64}\.json$/.test(name) || referenced.has(id)) continue;
    const file = fileFor(thread, id, env);
    await withStorageFileLock(file, async () => {
      const intent = await readJson(file, null);
      if (!intent || intent.ownerUserId !== resourceOwnerUserId(thread, env) || intent.threadId !== thread.id ||
          intent.state !== "ready" || !Number.isFinite(Date.parse(intent.updatedAt)) ||
          Date.parse(intent.updatedAt) > Date.now() - (options.minAgeMs ?? 7 * 86400_000)) return;
      eligible.push(id);
      // Report-only: an exclusive authoritative message/outbox inventory is
      // needed before enabling deletion; caller snapshots can race new claims.
    });
  }
  return { eligible, deleted: [], dryRun: true };
}
