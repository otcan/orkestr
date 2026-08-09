import fs from "node:fs/promises";
import { listThreads, listThreadMessages, updateThread } from "./threads.js";
import { resolveCurrentCodexGeneration, rolloutPathFingerprint, verifyRolloutGeneration } from "./codex-generation-lineage.js";
import { ensureCodexFinalProjectionDelivery } from "./codex-final-projection.js";
import { whatsappOrigin } from "./codex-app-server-whatsapp.js";

function clean(value) {
  return String(value || "").trim();
}

function rolloutPathForThread(thread = {}) {
  return clean(thread.codexRolloutPath || thread.executor?.metadata?.codexRolloutPath || thread.runtime?.operatorRolloutPath);
}

export async function doctorCodexGenerationResources({ env = process.env, repair = false, resolveVerifiedRollout } = {}) {
  const issues = [];
  const actions = [];
  let checked = 0;
  let skippedAmbiguous = 0;
  const threads = await listThreads(env).catch(() => []);
  for (const thread of threads) {
    const appServer = clean(thread.executor?.transport || thread.runtime?.runtimeKind || thread.runtimeKind).toLowerCase().includes("app-server");
    if (!appServer) continue;
    checked += 1;
    const lineage = resolveCurrentCodexGeneration(thread);
    if (lineage.ambiguous) {
      skippedAmbiguous += 1;
      issues.push({ severity: "error", code: "codex_generation_fields_conflict", threadId: thread.id, observedGenerations: lineage.generations, message: "Codex generation fields conflict; automatic identity selection is unsafe." });
      continue;
    }
    const generation = lineage.generation;
    const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
    const rolloutPath = rolloutPathForThread(thread);
    if (generation && (rolloutPath || runtime.operatorRolloutGeneration)) {
      const identity = rolloutPath
        ? await verifyRolloutGeneration(rolloutPath, generation).catch(() => ({ ok: false, reason: "codex_rollout_path_missing" }))
        : { ok: false, reason: "codex_rollout_path_missing" };
      const generationStamped = clean(runtime.operatorRolloutGeneration) === generation;
      if (!identity.ok || !generationStamped) {
        const code = !identity.ok ? identity.reason : "codex_rollout_generation_mismatch";
        issues.push({
          severity: "error",
          code,
          threadId: thread.id,
          expectedGeneration: generation,
          observedGeneration: identity.observedGeneration || identity.generation || runtime.operatorRolloutGeneration || null,
          pathFingerprint: identity.pathFingerprint || rolloutPathFingerprint(rolloutPath),
          message: "Codex rollout lineage does not match the current generation.",
        });
        if (repair && typeof resolveVerifiedRollout === "function") {
          const verified = await resolveVerifiedRollout(thread, generation, { preferredPath: rolloutPath }, env);
          if (verified.ok) {
            const stats = await fs.stat(verified.rolloutPath).catch(() => null);
            const sameVerifiedPath = verified.rolloutPath === clean(runtime.operatorRolloutPath);
            const nextOffset = sameVerifiedPath && identity.ok
              ? Math.min(Math.max(0, Number(runtime.operatorRolloutOffset || 0) || 0), Number(stats?.size || 0))
              : 0;
            await updateThread(thread.id, {
              codexRolloutPath: verified.rolloutPath,
              executor: { ...(thread.executor || {}), metadata: { ...(thread.executor?.metadata || {}), codexRolloutPath: verified.rolloutPath, codexRolloutGeneration: generation } },
              runtime: { ...runtime, operatorRolloutPath: verified.rolloutPath, operatorRolloutGeneration: generation, operatorRolloutOffset: nextOffset, operatorRolloutSyncedAt: new Date().toISOString(), operatorRolloutSyncError: null },
            }, env);
            actions.push({ action: "rebound_codex_rollout", code, threadId: thread.id, expectedGeneration: generation, pathFingerprint: verified.pathFingerprint });
          }
        }
      }
    }
    const messages = await listThreadMessages(thread.id, env).catch(() => []);
    const finals = messages.filter((message) =>
      clean(message.role).toLowerCase() === "assistant" &&
      clean(message.phase || "final_answer").toLowerCase() === "final_answer" &&
      (!generation || !clean(message.codexThreadId || message.executorThreadId) || clean(message.codexThreadId || message.executorThreadId) === generation)
    );
    const latestFinal = finals.at(-1) || null;
    const completedTurnId = clean(runtime.lastTurnId);
    if (clean(runtime.lastTurnStatus).toLowerCase() === "completed" && completedTurnId && !finals.some((message) => clean(message.codexTurnId || message.executorTurnId) === completedTurnId)) {
      issues.push({ severity: "error", code: "completed_turn_missing_final_projection", threadId: thread.id, expectedGeneration: generation || null, turnId: completedTurnId, message: "A completed Codex turn has no projected final assistant message." });
    }
    if (latestFinal && whatsappOrigin(latestFinal) && clean(runtime.finalDelivery?.messageId) !== clean(latestFinal.id)) {
      issues.push({ severity: "error", code: "final_message_missing_outbox", threadId: thread.id, expectedGeneration: generation || null, turnId: latestFinal.codexTurnId || null, messageId: latestFinal.id, message: "The latest WhatsApp final is missing durable final-delivery state." });
      if (repair) {
        const repaired = await ensureCodexFinalProjectionDelivery(thread, latestFinal, { runtimeGeneration: generation, turnId: latestFinal.codexTurnId, source: "doctor", forceSignal: true }, env);
        if (repaired.ok) actions.push({ action: "backfilled_final_delivery", code: "final_message_missing_outbox", threadId: thread.id, messageId: latestFinal.id });
      }
    }
  }
  return { checked, skippedAmbiguous, issues, actions };
}
