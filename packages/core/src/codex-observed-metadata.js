import { normalizeCodexModel, normalizeCodexServiceTier, normalizeReasoningEffort } from "./codex-app-server-common.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";
import { getThread, updateThread } from "./threads.js";

// Historical turn metadata must not overwrite explicit next-turn settings,
// including a user's reset-to-default. Prefer the newest persisted snapshot.
export function explicitCodexSettings(thread = {}) {
  const candidates = [thread, thread.executor?.metadata || {}]
    .filter((source) => Number.isFinite(Date.parse(source.codexModelUpdatedAt || "")))
    .sort((a, b) => Date.parse(b.codexModelUpdatedAt) - Date.parse(a.codexModelUpdatedAt));
  const source = candidates[0];
  if (!source) return {};
  return {
    codexModel: normalizeCodexModel(source.codexModel) || null,
    codexReasoningEffort: normalizeReasoningEffort(source.codexReasoningEffort) || null,
    codexServiceTier: normalizeCodexServiceTier(source.codexServiceTier) || null,
    codexModelUpdatedAt: source.codexModelUpdatedAt,
  };
}

export function codexMetadataUpdatePatch(thread = {}, codexMetadata = {}) {
  const observed = { ...codexMetadata, ...explicitCodexSettings(thread) };
  const executorMetadata = { ...(thread.executor?.metadata || {}), ...observed };
  if (codexMetadata.codexRolloutPath && codexMetadata.codexThreadId) {
    executorMetadata.codexRolloutGeneration = codexMetadata.codexThreadId;
  }
  if (!normalizeCodexModel(executorMetadata.codexModel)) delete executorMetadata.codexModel;
  if (!normalizeReasoningEffort(executorMetadata.codexReasoningEffort)) delete executorMetadata.codexReasoningEffort;
  const provider = String(executorMetadata.codexModelProvider || "").trim();
  if (provider.startsWith("/") || provider.toLowerCase().endsWith(".jsonl")) delete executorMetadata.codexModelProvider;
  const patch = {
    ...observed,
    executor: {
      ...(thread.executor || {}),
      codexThreadId: codexMetadata.codexThreadId || thread.executor?.codexThreadId || "",
      metadata: executorMetadata,
    },
  };
  if (!observed.codexModel && thread.codexModel && !normalizeCodexModel(thread.codexModel)) patch.codexModel = null;
  if (!observed.codexReasoningEffort && thread.codexReasoningEffort && !normalizeReasoningEffort(thread.codexReasoningEffort)) patch.codexReasoningEffort = null;
  const threadProvider = String(thread.codexModelProvider || "").trim();
  if (!observed.codexModelProvider && threadProvider && (threadProvider.startsWith("/") || threadProvider.toLowerCase().endsWith(".jsonl"))) {
    patch.codexModelProvider = null;
  }
  return patch;
}

export async function persistObservedCodexMetadata(threadId, metadata, env = process.env) {
  // Re-read settings under the same reentrant lock as updateThread: a slow
  // metadata read must not overwrite a command that completed in the meantime.
  return withCanonicalPublicReferenceLock(async () => {
    const current = await getThread(threadId, env);
    if (!current) throw new Error("thread_not_found");
    return updateThread(threadId, codexMetadataUpdatePatch(current, metadata), env);
  }, env);
}
