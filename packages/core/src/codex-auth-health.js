import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

const AUTH_REFRESH_MTIME_SKEW_MS = 10;

export function codexRuntimeAuthInvalidReason(value = "") {
  const text = clean(value);
  if (!text) return "";
  if (/refresh token (?:was )?already used/i.test(text)) return "codex_refresh_token_reused";
  if (/access token could not be refreshed/i.test(text) && /(?:log out|sign in|refresh token)/i.test(text)) {
    return "codex_refresh_token_invalid";
  }
  if (/\btoken_invalidated\b/i.test(text) || /authentication token has been invalidated/i.test(text)) {
    return "codex_token_invalidated";
  }
  if (/authentication failed/i.test(text) && /(?:codex login|sign in again|log in again)/i.test(text)) {
    return "codex_runtime_auth_invalid";
  }
  if (/MCP client for [`'"]?codex_apps[`'"]?\s+failed to start/i.test(text) && /\b(?:401|auth|token|sign in)\b/i.test(text)) {
    return "codex_apps_auth_invalid";
  }
  if (/MCP startup incomplete\s*\(failed:\s*codex_apps\)/i.test(text) && /\b(?:401|auth|token|sign in)\b/i.test(text)) {
    return "codex_apps_auth_invalid";
  }
  return "";
}

export function codexAuthHealthPath(env = process.env) {
  return path.join(dataPaths(env).home, "codex-auth-health.json");
}

export async function readCodexAuthHealth(env = process.env) {
  return await readJson(codexAuthHealthPath(env), null).catch(() => null);
}

export async function activeCodexRuntimeAuthInvalid({ env = process.env, codexAuthPath = "" } = {}) {
  const health = await readCodexAuthHealth(env);
  if (!health || typeof health !== "object") return null;
  if (clean(health.state).toLowerCase() !== "broken") return null;
  const reason = clean(health.reason).toLowerCase();
  if (!reason.includes("auth") && !reason.includes("token")) return null;

  const detectedMs = Date.parse(clean(health.detectedAt || health.updatedAt));
  if (codexAuthPath && Number.isFinite(detectedMs) && detectedMs > 0) {
    const authStat = await fs.stat(codexAuthPath).catch(() => null);
    if (authStat?.mtimeMs > detectedMs + AUTH_REFRESH_MTIME_SKEW_MS) return null;
  }
  return health;
}

export async function recordCodexRuntimeAuthInvalidSignal({ thread = {}, progress = {} } = {}, env = process.env) {
  if (progress?.codexAuthInvalid !== true) return null;
  const detectedAt = nowIso();
  const payload = {
    state: "broken",
    reason: clean(progress.codexAuthInvalidReason) || "codex_runtime_auth_invalid",
    summary: clean(progress.codexAuthInvalidMessage) || clean(progress.summary) || "Codex sign-in needs to be refreshed.",
    detectedAt,
    updatedAt: detectedAt,
    threadId: clean(thread.id),
    threadName: clean(thread.name),
    paneId: clean(progress.paneId),
    sessionName: clean(progress.sessionName),
    tailHash: clean(progress.tailHash),
  };
  const current = await readCodexAuthHealth(env);
  const sameSignal = current?.state === payload.state &&
    current?.reason === payload.reason &&
    current?.threadId === payload.threadId &&
    current?.tailHash === payload.tailHash;
  if (sameSignal) return current;
  await writeJson(codexAuthHealthPath(env), payload);
  await appendEvent({
    type: "codex_runtime_auth_invalid",
    reason: payload.reason,
    threadId: payload.threadId,
    paneId: payload.paneId,
    tailHash: payload.tailHash,
  }, env).catch(() => {});
  return payload;
}

export async function recordCodexRuntimeAuthFailureSignal({ thread = {}, error = "", turnId = "" } = {}, env = process.env) {
  const errorText = clean(error);
  const reason = codexRuntimeAuthInvalidReason(errorText);
  if (!reason) return null;
  const detectedAt = nowIso();
  const payload = {
    state: "broken",
    reason,
    summary: errorText || "Codex sign-in needs to be refreshed.",
    detectedAt,
    updatedAt: detectedAt,
    threadId: clean(thread.id),
    threadName: clean(thread.name),
    turnId: clean(turnId),
    paneId: "",
    sessionName: "",
    tailHash: "",
  };
  const current = await readCodexAuthHealth(env);
  const sameSignal = current?.state === payload.state &&
    current?.reason === payload.reason &&
    current?.threadId === payload.threadId &&
    current?.turnId === payload.turnId;
  if (sameSignal) return current;
  await writeJson(codexAuthHealthPath(env), payload);
  await appendEvent({
    type: "codex_runtime_auth_invalid",
    reason: payload.reason,
    threadId: payload.threadId,
    turnId: payload.turnId,
  }, env).catch(() => {});
  return payload;
}
