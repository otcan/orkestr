import crypto from "node:crypto";

function clean(value) {
  return String(value || "").trim();
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Resolve the one Codex generation which is allowed to mutate a thread.
 *
 * A live runtime identity wins over persisted compatibility copies. This is
 * intentional: a safe reset writes the new runtime first, while an older
 * executor copy may still be observed by a process which started before the
 * reset completed. If there is no live runtime identity, disagreeing durable
 * copies are ambiguous and callers must fail closed.
 */
export function resolveCurrentCodexGeneration(thread = {}) {
  const runtime = record(thread.runtime);
  const executor = record(thread.executor);
  const metadata = record(executor.metadata);
  const runtimeCodexThreadId = clean(runtime.codexThreadId);
  const durable = [
    ["executor.codexThreadId", clean(executor.codexThreadId)],
    ["thread.codexThreadId", clean(thread.codexThreadId)],
    ["executor.metadata.codexThreadId", clean(metadata.codexThreadId)],
  ].filter(([, value]) => value);
  const durableIds = [...new Set(durable.map(([, value]) => value))];
  const legacyRuntimeGeneration = clean(runtime.runtimeGeneration);

  if (runtimeCodexThreadId) {
    return {
      id: runtimeCodexThreadId,
      source: "runtime.codexThreadId",
      ambiguous: false,
      supersededIds: durableIds.filter((id) => id !== runtimeCodexThreadId),
      candidates: {
        "runtime.codexThreadId": runtimeCodexThreadId,
        ...Object.fromEntries(durable),
        ...(legacyRuntimeGeneration ? { "runtime.runtimeGeneration": legacyRuntimeGeneration } : {}),
      },
    };
  }

  if (durableIds.length === 1) {
    return {
      id: durableIds[0],
      source: durable.find(([, value]) => value === durableIds[0])?.[0] || "executor.codexThreadId",
      ambiguous: false,
      supersededIds: legacyRuntimeGeneration && legacyRuntimeGeneration !== durableIds[0] ? [legacyRuntimeGeneration] : [],
      candidates: {
        ...Object.fromEntries(durable),
        ...(legacyRuntimeGeneration ? { "runtime.runtimeGeneration": legacyRuntimeGeneration } : {}),
      },
    };
  }

  if (durableIds.length > 1) {
    return {
      id: "",
      source: "",
      ambiguous: true,
      reason: "durable_codex_generation_ambiguous",
      supersededIds: [],
      candidates: Object.fromEntries(durable),
    };
  }

  if (legacyRuntimeGeneration) {
    return {
      id: legacyRuntimeGeneration,
      source: "runtime.runtimeGeneration",
      ambiguous: false,
      supersededIds: [],
      candidates: { "runtime.runtimeGeneration": legacyRuntimeGeneration },
    };
  }

  return { id: "", source: "", ambiguous: false, reason: "codex_generation_missing", supersededIds: [], candidates: {} };
}

export function currentCodexGenerationId(thread = {}) {
  return resolveCurrentCodexGeneration(thread).id;
}

export function currentCodexGenerationMatches(thread = {}, observedGeneration = "") {
  const resolution = resolveCurrentCodexGeneration(thread);
  const observed = clean(observedGeneration);
  if (resolution.ambiguous) return { ok: false, reason: resolution.reason, resolution };
  if (!resolution.id) return { ok: false, reason: "codex_generation_missing", resolution };
  if (!observed) return { ok: false, reason: "codex_generation_required", resolution };
  if (observed !== resolution.id) return { ok: false, reason: "superseded_codex_generation", resolution };
  return { ok: true, reason: "current_codex_generation", resolution };
}

export function rolloutGenerationMode(env = process.env) {
  const value = clean(env.ORKESTR_CODEX_GENERATION_ROLLOUT_MODE || "shadow").toLowerCase();
  if (["off", "shadow", "enforce"].includes(value)) return value;
  return "shadow";
}

export function rolloutPathFingerprint(rolloutPath = "") {
  const value = clean(rolloutPath);
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function generationScopedRuntimePatch(thread = {}, generation = "", options = {}) {
  const nextGeneration = clean(generation);
  const runtime = record(thread.runtime);
  const executor = record(thread.executor);
  const metadata = record(executor.metadata);
  const previous = resolveCurrentCodexGeneration(thread).id;
  const changed = Boolean(nextGeneration && previous && previous !== nextGeneration);
  const sessionId = clean(options.codexSessionId) || nextGeneration || null;
  const generationMetadata = {
    ...metadata,
    codexThreadId: nextGeneration || null,
    codexSessionId: sessionId,
    ...(changed ? {
      codexRolloutPath: null,
      codexRolloutGeneration: null,
      previousCodexGeneration: previous,
      codexGenerationChangedAt: options.changedAt || new Date().toISOString(),
    } : {}),
  };
  return {
    codexThreadId: nextGeneration || null,
    codexSessionId: sessionId,
    executor: {
      ...executor,
      codexThreadId: nextGeneration || null,
      codexSessionId: sessionId,
      metadata: generationMetadata,
    },
    runtime: {
      ...runtime,
      codexThreadId: nextGeneration || null,
      codexSessionId: sessionId,
      runtimeGeneration: nextGeneration || null,
      ...(changed ? {
        operatorRolloutPath: null,
        operatorRolloutOffset: 0,
        operatorRolloutGeneration: null,
        operatorRolloutSyncedAt: null,
        operatorRolloutSyncError: null,
        operatorRolloutValidation: null,
        finalDelivery: null,
        liveness: null,
        checkpoint: null,
      } : {}),
    },
  };
}

export function staleGenerationRuntimeState(thread = {}) {
  const resolution = resolveCurrentCodexGeneration(thread);
  const runtime = record(thread.runtime);
  const staleRollout = Boolean(
    resolution.id &&
    clean(runtime.operatorRolloutGeneration) &&
    clean(runtime.operatorRolloutGeneration) !== resolution.id
  );
  const staleFinalDelivery = Boolean(
    resolution.id &&
    clean(runtime.finalDelivery?.runtimeGeneration) &&
    clean(runtime.finalDelivery.runtimeGeneration) !== resolution.id
  );
  return { resolution, staleRollout, staleFinalDelivery };
}
