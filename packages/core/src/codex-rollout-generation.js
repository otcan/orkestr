import fs from "node:fs/promises";
import { appendEvent } from "../../storage/src/store.js";
import { rolloutGenerationMode, rolloutPathFingerprint } from "./codex-generation.js";

function sessionMetaReadBytes(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_GENERATION_ROLLOUT_META_MAX_BYTES || 64 * 1024);
  return Number.isFinite(parsed) ? Math.max(1024, Math.min(1024 * 1024, Math.floor(parsed))) : 64 * 1024;
}

function validSessionId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id) ? id : "";
}

/** Read only a bounded prefix; rollout records must not be loaded wholesale. */
export async function readCodexRolloutSessionMeta(rolloutPath, env = process.env) {
  const maxBytes = sessionMetaReadBytes(env);
  const handle = await fs.open(rolloutPath, "r").catch(() => null);
  if (!handle) return { ok: false, reason: "rollout_unreadable" };
  let body = "";
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
  for (const rawLine of body.split("\n")) {
    if (!rawLine.trim()) continue;
    if (Buffer.byteLength(rawLine, "utf8") > maxBytes) return { ok: false, reason: "session_meta_line_too_large" };
    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (parsed?.type !== "session_meta") continue;
    const id = validSessionId(parsed?.payload?.id);
    return id ? { ok: true, id } : { ok: false, reason: "session_meta_id_malformed" };
  }
  return { ok: false, reason: "session_meta_missing" };
}

/**
 * Validate that a rollout file belongs to the current Codex generation.
 * Shadow mode records legacy metadata but only explicit generation mismatches
 * are rejected; enforce mode also rejects missing or malformed session meta.
 */
export async function validateCodexRolloutGeneration({ thread, generation = "", rolloutPath, surface, env = process.env }) {
  const mode = rolloutGenerationMode(env);
  if (mode === "off") return { accepted: true, mode, reason: "generation_guard_off", sessionId: "" };
  const session = await readCodexRolloutSessionMeta(rolloutPath, env);
  const expected = String(generation || "").trim();
  let accepted = session.ok;
  let reason = session.ok ? "current_generation" : session.reason;
  if (session.ok && expected && session.id !== expected) {
    accepted = false;
    reason = "session_meta_generation_mismatch";
  } else if (session.ok && !expected) {
    accepted = mode !== "enforce";
    reason = accepted ? "generation_unavailable_shadow" : "current_generation_missing";
  } else if (!session.ok && mode === "shadow") {
    accepted = true;
  }
  if (mode === "shadow") accepted = true;
  const result = { accepted, mode, reason, sessionId: session.id || "" };
  await appendEvent({
    type: accepted ? "codex_rollout_generation_validated" : "codex_rollout_generation_rejected",
    threadId: thread?.id || null,
    expectedGeneration: expected || null,
    observedGeneration: session.id || null,
    reason,
    mode,
    surface,
    rolloutPathFingerprint: rolloutPathFingerprint(rolloutPath),
  }, env).catch(() => {});
  return result;
}
