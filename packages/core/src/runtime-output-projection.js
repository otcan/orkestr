import { runtimeOutputBodyKey, runtimeOutputItemKey, runtimeOutputMetadata } from "../../shared/src/runtime-output-identity.js";

const sources = new Set(["codex-app-server", "codex-app-server-import", "codex-rollout"]);
const clean = value => String(value || "").trim();
const completed = row => !row.state || row.state === "completed";
const finalAnswer = row => clean(row.role) === "assistant" && clean(row.phase || "final_answer") === "final_answer";

// Called under the thread-message mutation lock, including rollout writers.
// Existing rows and their attachments/delivery receipts are never rewritten.
export async function existingRuntimeOutput(repository, thread, input, ownerUserId) {
  if (!sources.has(input.source) || (input.state && input.state !== "completed")) return null;
  const key = runtimeOutputItemKey(input);
  if (!key) return existingTurnOutput(repository, thread, input, ownerUserId);
  const identity = runtimeOutputMetadata(input);
  if (await repository.usesSqlite()) {
    const existing = await repository.find(thread.id, {
      role: "assistant", phase: "final_answer",
      codexThreadId: identity.runtimeGeneration,
      codexTurnId: identity.runtimeTurnId,
      codexItemId: identity.runtimeItemId,
    });
    if (existing && (existing.ownerUserId || ownerUserId) === ownerUserId &&
        completed(existing) && runtimeOutputItemKey(existing) === key) return existing;
  } else {
    // JSON repositories do not implement field-indexed find.
    return (await repository.list(thread.id)).find(row =>
      (row.ownerUserId || ownerUserId) === ownerUserId && completed(row) &&
      runtimeOutputItemKey(row) === key) || null;
  }
  return null;
}

// Rollout projections usually carry generation+turn but no item ID, and their
// parent is re-derived on every scan. Without this, a copy whose chosen parent
// differs from the stored final escapes rolloutFinalDuplicateKey and becomes a
// second routable final. Match only the same runtime turn and identical
// normalized source text; parents, event IDs and timestamps are ignored.
async function existingTurnOutput(repository, thread, input, ownerUserId) {
  let identity;
  try { identity = runtimeOutputMetadata(input); } catch { return null; }
  const body = runtimeOutputBodyKey(input);
  if (!identity.runtimeGeneration || !identity.runtimeTurnId || identity.runtimeItemId || !body) return null;
  const matches = row => finalAnswer(row) && completed(row) &&
    (row.ownerUserId || ownerUserId) === ownerUserId &&
    clean(row.codexThreadId || row.executorThreadId) === identity.runtimeGeneration &&
    clean(row.codexTurnId || row.executorTurnId) === identity.runtimeTurnId &&
    runtimeOutputBodyKey(row) === body;
  if (await repository.usesSqlite()) {
    // Latest final in the turn only; a miss falls back to existing behavior.
    const existing = await repository.find(thread.id, {
      role: "assistant", phase: "final_answer",
      codexThreadId: identity.runtimeGeneration, codexTurnId: identity.runtimeTurnId,
    });
    return existing && matches(existing) ? { ...existing, duplicateReason: "canonical_runtime_turn_output" } : null;
  }
  const existing = (await repository.list(thread.id)).find(matches);
  return existing ? { ...existing, duplicateReason: "canonical_runtime_turn_output" } : null;
}
