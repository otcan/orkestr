import crypto from "node:crypto";
import fs from "node:fs/promises";

const rolloutRuntimeKeys = [
  "operatorRolloutPath",
  "operatorRolloutGeneration",
  "operatorRolloutOffset",
  "operatorRolloutSyncedAt",
  "operatorRolloutSyncError",
  "operatorRolloutIdentity",
  "operatorRolloutLookbackApplied",
  "operatorRolloutLookbackBytes",
  "operatorRolloutLookbackScannedAt",
  "operatorRolloutLookbackScannedFrom",
];

function clean(value) {
  return String(value || "").trim();
}

export function codexGenerationCandidates(thread = {}) {
  return {
    runtime: clean(thread?.runtime?.codexThreadId),
    executor: clean(thread?.executor?.codexThreadId),
    root: clean(thread?.codexThreadId),
    metadata: clean(thread?.executor?.metadata?.codexThreadId),
  };
}

export function resolveCurrentCodexGeneration(thread = {}) {
  const fields = codexGenerationCandidates(thread);
  const generations = [...new Set(Object.values(fields).filter(Boolean))];
  return {
    generation: generations.length === 1 ? generations[0] : "",
    consistent: generations.length <= 1,
    ambiguous: generations.length > 1,
    fields,
    generations,
  };
}

export function currentCodexGeneration(thread = {}) {
  return resolveCurrentCodexGeneration(thread).generation;
}

export function codexGenerationFencingMode(env = process.env) {
  const value = clean(env.ORKESTR_CODEX_GENERATION_FENCING).toLowerCase();
  if (["1", "true", "on", "enforce", "enabled"].includes(value)) return "enforce";
  if (["shadow", "validate", "report"].includes(value)) return "shadow";
  return "off";
}

export function clearCodexRolloutRuntime(runtime = {}) {
  const next = { ...(runtime && typeof runtime === "object" ? runtime : {}) };
  for (const key of rolloutRuntimeKeys) delete next[key];
  return next;
}

export function clearCodexRolloutMetadata(metadata = {}) {
  const next = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  for (const key of ["codexRolloutPath", "codexRolloutGeneration", "codexRolloutIdentity"]) delete next[key];
  return next;
}

export function codexGenerationChanged(thread = {}, nextGeneration = "") {
  const before = resolveCurrentCodexGeneration(thread);
  const next = clean(nextGeneration);
  return before.ambiguous || (Boolean(before.generation) && before.generation !== next);
}

export function rolloutPathFingerprint(filePath = "") {
  const value = clean(filePath);
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function inspectRolloutIdentity(filePath, options = {}) {
  const path = clean(filePath);
  const maxBytesValue = Number(options.maxBytes || 64 * 1024);
  const maxBytes = Number.isFinite(maxBytesValue) ? Math.max(1024, Math.min(1024 * 1024, Math.floor(maxBytesValue))) : 64 * 1024;
  const fingerprint = rolloutPathFingerprint(path);
  if (!path) return { ok: false, reason: "codex_rollout_path_missing", generation: "", pathFingerprint: fingerprint, bytesRead: 0 };
  const stats = await fs.stat(path).catch(() => null);
  if (!stats?.isFile()) return { ok: false, reason: "codex_rollout_path_missing", generation: "", pathFingerprint: fingerprint, bytesRead: 0 };
  const length = Math.min(Number(stats.size || 0), maxBytes);
  if (length <= 0) return { ok: false, reason: "codex_rollout_session_meta_missing", generation: "", pathFingerprint: fingerprint, bytesRead: 0 };
  const handle = await fs.open(path, "r");
  let body = "";
  let bytesRead = 0;
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    bytesRead = result.bytesRead;
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
  const completeBody = Number(stats.size || 0) <= bytesRead || body.endsWith("\n") ? body : body.slice(0, Math.max(0, body.lastIndexOf("\n") + 1));
  let malformed = false;
  for (const line of completeBody.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (parsed?.type !== "session_meta") continue;
    const generation = clean(parsed?.payload?.id);
    if (!generation) {
      return { ok: false, reason: "codex_rollout_session_meta_malformed", generation: "", pathFingerprint: fingerprint, bytesRead };
    }
    return { ok: true, reason: "", generation, pathFingerprint: fingerprint, bytesRead };
  }
  return {
    ok: false,
    reason: malformed ? "codex_rollout_session_meta_malformed" : "codex_rollout_session_meta_missing",
    generation: "",
    pathFingerprint: fingerprint,
    bytesRead,
  };
}

export async function verifyRolloutGeneration(filePath, expectedGeneration, options = {}) {
  const expected = clean(expectedGeneration);
  const identity = await inspectRolloutIdentity(filePath, options);
  if (!identity.ok) return { ...identity, expectedGeneration: expected };
  if (!expected || identity.generation !== expected) {
    return {
      ...identity,
      ok: false,
      reason: "codex_rollout_generation_mismatch",
      expectedGeneration: expected,
      observedGeneration: identity.generation,
    };
  }
  return { ...identity, expectedGeneration: expected, observedGeneration: identity.generation };
}

export function codexGenerationTransitionPatch(thread = {}, nextGeneration = "", nextSessionId = "") {
  const generation = clean(nextGeneration);
  const sessionId = clean(nextSessionId || generation);
  const metadata = clearCodexRolloutMetadata(thread?.executor?.metadata);
  const runtime = clearCodexRolloutRuntime(thread?.runtime);
  return {
    codexThreadId: generation || null,
    codexSessionId: sessionId || null,
    codexRolloutPath: null,
    executor: {
      ...(thread?.executor || {}),
      codexThreadId: generation || null,
      codexSessionId: sessionId || null,
      metadata: {
        ...metadata,
        codexThreadId: generation || null,
        codexSessionId: sessionId || null,
      },
    },
    runtime: {
      ...runtime,
      codexThreadId: generation || null,
      codexSessionId: sessionId || null,
    },
  };
}
