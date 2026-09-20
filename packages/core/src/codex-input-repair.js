import fs from "node:fs/promises";
import path from "node:path";
import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { writeSecretJson, readJson } from "../../storage/src/store.js";
import { getThread } from "./threads.js";
import { withThreadMessageMutation } from "./thread-message-mutation.js";
import { inputDigest, sameInputScope, submittedInputMatches } from "./codex-input-identity.js";
import { codexInputText } from "./codex-app-server-common.js";

const digest = value => inputDigest(JSON.stringify(value));
const consistentIdentity = row => [
  [row.codexThreadId, row.executorThreadId], [row.codexTurnId, row.executorTurnId],
  [row.codexItemId, row.executorItemId],
].every(([left, right]) => !left || !right || left === right);
const itemId = row => row.codexItemId || row.executorItemId;
const inThread = (row, thread) => row.ownerUserId === thread.ownerUserId && (!row.threadId || row.threadId === thread.id);

export function planInputRepair(thread, messages) {
  if (!thread?.id || !thread.ownerUserId || !Array.isArray(messages) ||
      messages.some(row => !row?.id) || new Set(messages.map(row => row.id)).size !== messages.length) {
    throw new Error("repair_invalid_inventory");
  }
  const candidates = [], skipped = [];
  for (const imported of messages.filter(row => row.role === "user" && row.source === "codex-app-server-import" && !row.supersededBy)) {
    const eligible = messages.filter(row => row.role === "user" && row.source !== "codex-app-server-import" && !row.supersededBy &&
      inThread(row, thread) && inThread(imported, thread) && consistentIdentity(row) && consistentIdentity(imported) &&
      sameInputScope(row, imported) && submittedInputMatches(row, imported.text) &&
      (!row.codexSubmission || row.codexSubmission.payloadDigest === inputDigest(codexInputText(row))));
    const canonical = eligible[0];
    const peers = messages.filter(row => row.source === "codex-app-server-import" && !row.supersededBy && sameInputScope(row, imported) && row.text === imported.text);
    const references = messages.filter(row => row.parentMessageId === imported.id);
    if (imported.state !== "completed" || !imported.codexItemId || eligible.length !== 1 || peers.length !== 1 ||
        itemId(canonical) && itemId(canonical) !== imported.codexItemId || canonical.state !== "completed" ||
        // Imported attachment claims need a separate reference review. Hiding
        // the projection must never implicitly dispose of a distinct claim.
        (imported.attachments || []).length > 0 || references.some(row => !inThread(row, thread))) {
      skipped.push({ id: imported.id, reason: "ambiguous_or_conflicting_identity" }); continue;
    }
    candidates.push({ originalId: canonical.id, importedId: imported.id, itemId: imported.codexItemId,
      parentReferences: references.map(row => row.id),
      attachmentReferences: [canonical, imported].map(row => ({ messageId: row.id, attachments: row.attachments || [] })),
    });
  }
  const plan = { version: 1, threadId: thread.id, ownerUserId: thread.ownerUserId,
    beforeDigest: digest(messages), candidates, skipped, before: messages };
  return { ...plan, approvalDigest: digest(plan) };
}

async function scopedThread(threadId, ownerUserId, env) {
  const thread = await getThread(threadId, env);
  if (!ownerUserId || !thread || thread.ownerUserId !== ownerUserId) throw new Error("repair_owner_scope_mismatch");
  return thread;
}

export async function reportInputRepair(threadId, ownerUserId, env = process.env) {
  const thread = await scopedThread(threadId, ownerUserId, env);
  return withThreadMessageMutation(thread.id, env, async () => planInputRepair(thread, await createThreadMessageRepository(env).list(thread.id)));
}

export async function saveRepairManifest(file, manifest) {
  if (!path.isAbsolute(file)) throw new Error("repair_manifest_absolute_path_required");
  await writeSecretJson(file, manifest);
  const handle = await fs.open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function applyInputRepair(report, { approvalDigest, manifestPath }, env = process.env) {
  const { approvalDigest: expected, ...plan } = report;
  if (!approvalDigest || approvalDigest !== expected || expected !== digest(plan)) throw new Error("repair_approval_mismatch");
  const thread = await scopedThread(report.threadId, report.ownerUserId, env);
  return withThreadMessageMutation(thread.id, env, async () => {
    const repo = createThreadMessageRepository(env), current = await repo.list(thread.id);
    const prior = await readJson(manifestPath, null);
    if (prior) {
      if (prior.approvalDigest !== expected || !["prepared", "applied"].includes(prior.status)) throw new Error("repair_manifest_conflict");
      if (digest(current) === prior.afterDigest) {
        await saveRepairManifest(manifestPath, { ...prior, status: "applied" });
        return { repaired: report.candidates.length, duplicate: true };
      }
    }
    if (digest(current) !== report.beforeDigest) throw new Error("repair_revision_conflict");
    const fresh = planInputRepair(thread, current);
    if (fresh.approvalDigest !== expected) throw new Error("repair_plan_changed");
    const aliases = new Map(report.candidates.map(pair => [pair.importedId, pair.originalId]));
    const originals = new Map(report.candidates.map(pair => [pair.originalId, pair.itemId]));
    const after = current.map(row => {
      return { ...row,
        ...(aliases.has(row.id) ? { visibility: "internal", supersededBy: aliases.get(row.id), supersessionId: expected } : {}),
        ...(originals.has(row.id) ? { codexItemId: originals.get(row.id), executorItemId: originals.get(row.id) } : {}),
        ...(aliases.has(row.parentMessageId) ? { parentMessageId: aliases.get(row.parentMessageId) } : {}),
      };
    });
    const manifest = { version: 1, approvalDigest: expected, threadId: thread.id, ownerUserId: thread.ownerUserId,
      before: current, beforeDigest: report.beforeDigest, afterDigest: digest(after), status: "prepared" };
    await saveRepairManifest(manifestPath, manifest); // BEFORE transactional storage replacement.
    // No append/update helpers: no hydration, delivery, notification or agent hooks.
    await repo.save(thread.id, after);
    await saveRepairManifest(manifestPath, { ...manifest, status: "applied" });
    return { repaired: report.candidates.length, duplicate: false };
  });
}

export async function rollbackInputRepair(manifestPath, approvalDigest, env = process.env) {
  const manifest = await readJson(manifestPath, null);
  if (!manifest || !approvalDigest || manifest.approvalDigest !== approvalDigest || digest(manifest.before) !== manifest.beforeDigest) throw new Error("repair_rollback_approval_mismatch");
  await scopedThread(manifest.threadId, manifest.ownerUserId, env);
  return withThreadMessageMutation(manifest.threadId, env, async () => {
    const repo = createThreadMessageRepository(env), current = await repo.list(manifest.threadId);
    if (!["prepared", "applied", "rolled_back"].includes(manifest.status)) throw new Error("repair_manifest_conflict");
    if (digest(current) === manifest.beforeDigest) {
      await saveRepairManifest(manifestPath, { ...manifest, status: "rolled_back" });
      return { rolledBack: true, duplicate: true };
    }
    if (digest(current) !== manifest.afterDigest) throw new Error("repair_rollback_revision_conflict");
    await repo.save(manifest.threadId, manifest.before);
    await saveRepairManifest(manifestPath, { ...manifest, status: "rolled_back" });
    return { rolledBack: true };
  });
}
