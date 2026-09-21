import { runtimeOutputItemKey, runtimeOutputMetadata } from "../../shared/src/runtime-output-identity.js";

const sources = new Set(["codex-app-server", "codex-app-server-import", "codex-rollout"]);

// Called under the thread-message mutation lock, including rollout writers.
// Existing rows and their attachments/delivery receipts are never rewritten.
export async function existingRuntimeOutput(repository, thread, input, ownerUserId) {
  if (!sources.has(input.source) || (input.state && input.state !== "completed")) return null;
  const key = runtimeOutputItemKey(input);
  if (!key) return null;
  const identity = runtimeOutputMetadata(input);
  if (await repository.usesSqlite()) {
    const existing = await repository.find(thread.id, {
      role: "assistant", phase: "final_answer",
      codexThreadId: identity.runtimeGeneration,
      codexTurnId: identity.runtimeTurnId,
      codexItemId: identity.runtimeItemId,
    });
    if (existing && (existing.ownerUserId || ownerUserId) === ownerUserId &&
        (!existing.state || existing.state === "completed") && runtimeOutputItemKey(existing) === key) return existing;
  } else {
    // JSON repositories do not implement field-indexed find.
    return (await repository.list(thread.id)).find(row =>
      (row.ownerUserId || ownerUserId) === ownerUserId && (!row.state || row.state === "completed") &&
      runtimeOutputItemKey(row) === key) || null;
  }
  return null;
}
