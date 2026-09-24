import path from "node:path";
import { userDataPaths } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { normalizeUserId } from "./users.js";

function clean(value = "") {
  return String(value || "").trim();
}

function normalizedOwner(value = "") {
  const raw = clean(value);
  return raw ? normalizeUserId(raw) : "";
}

function storePath(ownerUserId, env = process.env) {
  return path.join(userDataPaths(normalizedOwner(ownerUserId), env).secrets, "claude-code-sessions.json");
}

async function readSessions(ownerUserId, env = process.env) {
  const state = await readJson(storePath(ownerUserId, env), { sessions: [] });
  return Array.isArray(state?.sessions) ? state.sessions : [];
}

function exactBinding(thread = {}) {
  return {
    ownerUserId: normalizedOwner(thread.ownerUserId || thread.userId),
    threadId: clean(thread.id),
    profileId: clean(thread?.executor?.accountProfileId || thread?.executor?.metadata?.accountProfileId),
  };
}

function validBinding(binding = {}) {
  return Boolean(binding.ownerUserId && binding.threadId && binding.profileId);
}

export async function getClaudeCodeSession(thread = {}, env = process.env) {
  const binding = exactBinding(thread);
  if (!validBinding(binding)) return "";
  const found = (await readSessions(binding.ownerUserId, env)).find((entry) =>
    entry.threadId === binding.threadId &&
    entry.profileId === binding.profileId &&
    entry.ownerUserId === binding.ownerUserId,
  );
  return clean(found?.sessionId);
}

export async function setClaudeCodeSession(thread = {}, sessionId = "", env = process.env) {
  const binding = exactBinding(thread);
  const nextSessionId = clean(sessionId);
  if (!validBinding(binding) || !nextSessionId || nextSessionId.length > 512) {
    const error = new Error("claude_code_session_invalid");
    error.code = "claude_code_session_invalid";
    throw error;
  }
  const file = storePath(binding.ownerUserId, env);
  return withStorageFileLock(file, async () => {
    const sessions = await readSessions(binding.ownerUserId, env);
    const existing = sessions.find((entry) => entry.threadId === binding.threadId);
    const record = { ...binding, sessionId: nextSessionId, updatedAt: new Date().toISOString() };
    if (existing) Object.assign(existing, record);
    else sessions.push(record);
    await writeSecretJson(file, { version: 1, sessions, updatedAt: record.updatedAt });
    return true;
  }, { timeoutMs: 15_000, staleMs: 60_000, heartbeatMs: 5_000 });
}

export async function clearClaudeCodeSession(thread = {}, env = process.env) {
  const binding = exactBinding(thread);
  if (!validBinding(binding)) return false;
  const file = storePath(binding.ownerUserId, env);
  return withStorageFileLock(file, async () => {
    const sessions = await readSessions(binding.ownerUserId, env);
    const next = sessions.filter((entry) => !(
      entry.threadId === binding.threadId &&
      entry.profileId === binding.profileId &&
      entry.ownerUserId === binding.ownerUserId
    ));
    if (next.length === sessions.length) return false;
    await writeSecretJson(file, { version: 1, sessions: next, updatedAt: new Date().toISOString() });
    return true;
  }, { timeoutMs: 15_000, staleMs: 60_000, heartbeatMs: 5_000 });
}
