import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { withThreadMessageMutation } from "../../core/src/thread-message-mutation.js";
import { getThread } from "../../core/src/threads.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { connectorOutboxPostgresMode, readConnectorOutbox } from "./connector-outbox.js";
import { withConnectorOutboxMutation } from "./connector-outbox-lock.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const journalName = /^stg_[a-f0-9]{64}\.json$/;

async function strictJson(file, fallback, maxBytes = 64 * 1024 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("staging_retention_invalid_inventory");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  } finally { await handle?.close(); }
}

async function safeDirectory(dir, { create = false } = {}) {
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== path.resolve(dir)) {
    throw new Error("staging_retention_unsafe_directory");
  }
}

async function referenceInventory(threadId, env) {
  const repository = createThreadMessageRepository(env);
  // Validate legacy inputs even before lazy SQLite migration can consume them.
  const legacy = await strictJson(await repository.pathForThread(threadId), []);
  if (!Array.isArray(legacy)) throw new Error("staging_retention_invalid_inventory");
  const messages = await repository.usesSqlite() ? await repository.list(threadId) : legacy;
  const legacyOutbox = await strictJson(dataPaths(env).connectorOutbox, { jobs: [] });
  const rawJobs = Array.isArray(legacyOutbox) ? legacyOutbox : legacyOutbox?.jobs;
  if (!Array.isArray(messages) || !Array.isArray(rawJobs)) throw new Error("staging_retention_invalid_inventory");
  if (rawJobs.some(job => !job || typeof job !== "object" || Array.isArray(job))) {
    throw new Error("staging_retention_invalid_inventory");
  }
  const outbox = await readConnectorOutbox(env);
  // Do not use the legacy reader's retention-pruned projection for safety.
  const jobs = outbox.backend === "sqlite" ? outbox.jobs : rawJobs;
  if (!Array.isArray(jobs)) throw new Error("staging_retention_invalid_inventory");
  if ([...legacy, ...messages].some(message => !message || typeof message.id !== "string" || !message.id) ||
      jobs.some(job => !job || typeof job !== "object" || Array.isArray(job))) {
    throw new Error("staging_retention_invalid_inventory");
  }
  return {
    // Legacy snapshots can be rehydrated later. Pin both stores, never infer
    // deletion eligibility from a filtered UI or a retention-pruned projection.
    journals: new Set([...legacy, ...messages].map(message => message?.outboundAttachmentStaging?.id).filter(Boolean)),
    messages: new Set([...legacy, ...messages].map(message => message?.id).filter(Boolean)),
    // Include terminal, uncertain and incompletely scoped historical jobs.
    outboxMessages: new Set([...rawJobs, ...jobs].map(job => job.sourceMessageId).filter(Boolean)),
  };
}

// Quarantine completed orphan JOURNALS only. Never removes an attachment or
// published ciphertext; transport obligations cannot lose their underlying bytes.
export async function retainOutboundStagingJournals({ threadId, ownerUserId, apply = false,
  minAgeMs = 7 * 86400_000, maxItems = 100, afterId = "", env = process.env } = {}) {
  if (!ownerUserId || !threadId) throw new Error("staging_retention_scope_required");
  if (!Number.isFinite(minAgeMs) || minAgeMs < 7 * 86400_000 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000 ||
      (afterId && !/^stg_[a-f0-9]{64}$/.test(afterId))) {
    throw new Error("staging_retention_invalid_bounds");
  }
  if (connectorOutboxPostgresMode(env)) throw new Error("staging_retention_distributed_backend_unsupported");
  if (apply && env.ORKESTR_STAGING_RETENTION_FENCED !== "1") throw new Error("staging_retention_coordinated_writers_required");
  const thread = await getThread(threadId, env);
  if (!thread || thread.id !== threadId || resourceOwnerUserId(thread, env) !== ownerUserId) {
    throw new Error("staging_retention_scope_mismatch");
  }
  const root = path.join(dataPaths(env).home, "outbound-attachment-staging");
  const dir = path.join(root, hash(`${ownerUserId}\n${threadId}`));
  const quarantine = path.join(dir, "retained");
  // Lock order matches normal message preparation: message -> outbox -> journal.
  return withThreadMessageMutation(threadId, env, () => withConnectorOutboxMutation(env, async () => {
    const inventory = await referenceInventory(threadId, env);
    try { await safeDirectory(root); await safeDirectory(dir); }
    catch (error) { if (error.code === "ENOENT") return { eligible: [], quarantined: [], dryRun: !apply, nextCursor: null }; throw error; }
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter(item => item.isFile() && journalName.test(item.name) && item.name.slice(0, -5) > afterId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const batch = entries.slice(0, maxItems);
    const result = { eligible: [], quarantined: [], dryRun: !apply,
      nextCursor: entries.length > batch.length ? batch.at(-1).name.slice(0, -5) : null };
    for (const entry of batch) {
      const id = entry.name.slice(0, -5);
      if (inventory.journals.has(id)) continue;
      const file = path.join(dir, entry.name);
      await withStorageFileLock(file, async () => {
        const intent = await strictJson(file, null, 2 * 1024 * 1024);
        if (!intent || intent.id !== id || intent.version !== 1 || intent.ownerUserId !== ownerUserId ||
            intent.threadId !== threadId || intent.state !== "ready" || !intent.messageId ||
            inventory.messages.has(intent.messageId) || inventory.outboxMessages.has(intent.messageId) ||
            !Number.isFinite(Date.parse(intent.updatedAt)) || Date.parse(intent.updatedAt) > Date.now() - minAgeMs) return;
        result.eligible.push(id);
        if (!apply) return;
        await safeDirectory(quarantine, { create: true });
        const target = path.join(quarantine, entry.name);
        // link is no-clobber and preserves the full original as rollback material.
        try { await fs.link(file, target); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const [source, retained] = await Promise.all([fs.lstat(file), fs.lstat(target)]);
          if (!retained.isFile() || source.dev !== retained.dev || source.ino !== retained.ino) {
            throw new Error("staging_retention_quarantine_conflict");
          }
        }
        const targetDir = await fs.open(quarantine, "r");
        try { await targetDir.sync(); } finally { await targetDir.close(); }
        await fs.unlink(file);
        const sourceDir = await fs.open(dir, "r");
        try { await sourceDir.sync(); } finally { await sourceDir.close(); }
        result.quarantined.push(id);
      });
    }
    return result;
  }));
}
