import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

// Thread-bound vault tokens (docs/vault.md). Orkestr issues each managed
// runtime turn its own short-lived bearer token, injected into the runtime
// environment as ORKESTR_VAULT_THREAD_TOKEN. Only a SHA-256 hash is stored
// (<ORKESTR_HOME>/secrets/vault-thread-tokens.json); the agent vault endpoints
// derive the thread from the token instead of trusting a caller-supplied id.
// Tokens expire with the turn and are revoked when the turn settles.

export const VAULT_THREAD_TOKEN_ENV = "ORKESTR_VAULT_THREAD_TOKEN";
export const VAULT_THREAD_TOKEN_HEADER = "x-orkestr-thread-token";
const PREFIX = "ovt_";
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function hashToken(token) {
  return createHash("sha256").update(clean(token)).digest("base64url");
}

async function storePath(env) {
  await ensureDataDirs(env);
  return path.join(dataPaths(env).secrets, "vault-thread-tokens.json");
}

function liveRecords(raw, nowMs) {
  const records = Array.isArray(raw?.tokens) ? raw.tokens : [];
  return records.filter((entry) => entry?.hash && entry?.threadId && Date.parse(entry.expiresAt) > nowMs);
}

async function mutateTokens(env, mutate) {
  const file = await storePath(env);
  return withStorageFileLock(file, async () => {
    const nowMs = Date.now();
    const tokens = liveRecords(await readJson(file, {}), nowMs);
    const result = await mutate(tokens, nowMs);
    await writeSecretJson(file, { schemaVersion: 1, tokens: tokens.slice(-MAX_RECORDS) });
    return result;
  });
}

/** Legacy mode: accept the CLI machine credential plus a caller-named thread. */
export function vaultLegacyThreadIdAllowed(env = process.env) {
  return ["1", "true", "yes", "on"].includes(clean(env.ORKESTR_VAULT_ALLOW_LEGACY_THREAD_ID).toLowerCase());
}

/**
 * Issues a token bound to one thread (and optionally one turn attempt).
 * Returns the raw token; the caller must only place it in a child env.
 */
export async function issueVaultThreadToken({ threadId, attemptId = "", ttlMs = 30 * 60 * 1000 } = {}, env = process.env) {
  const thread = clean(threadId);
  if (!thread) throw Object.assign(new Error("vault_thread_token_thread_required"), { code: "vault_thread_token_thread_required" });
  const ttl = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Number(ttlMs) || MIN_TTL_MS));
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  await mutateTokens(env, (tokens, nowMs) => {
    tokens.push({
      hash: hashToken(token),
      threadId: thread,
      attemptId: clean(attemptId),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttl).toISOString(),
    });
  });
  return token;
}

/** Revokes tokens of a thread; limited to one attempt when attemptId is set. */
export async function revokeVaultThreadTokens({ threadId, attemptId = "" } = {}, env = process.env) {
  const thread = clean(threadId);
  const attempt = clean(attemptId);
  if (!thread) return 0;
  return mutateTokens(env, (tokens) => {
    const before = tokens.length;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (tokens[index].threadId === thread && (!attempt || tokens[index].attemptId === attempt)) tokens.splice(index, 1);
    }
    return before - tokens.length;
  });
}

/** Thread id bound to a live token, or "" for missing/unknown/expired/revoked. */
export async function threadIdForVaultToken(token, env = process.env) {
  const value = clean(token);
  if (!value.startsWith(PREFIX) || value.length > 200) return "";
  const wanted = Buffer.from(hashToken(value));
  const tokens = liveRecords(await readJson(await storePath(env), {}), Date.now());
  const match = tokens.find((entry) => {
    const candidate = Buffer.from(String(entry.hash));
    return candidate.length === wanted.length && timingSafeEqual(candidate, wanted);
  });
  return match ? clean(match.threadId) : "";
}
