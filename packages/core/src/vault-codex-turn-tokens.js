import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chownToCodexRuntime } from "./codex-runtime-identity.js";
import { issueVaultThreadToken, revokeVaultThreadTokens } from "./vault-thread-tokens.js";

// Thread-bound vault tokens for Codex app-server turns (docs/vault.md).
// Codex threads share one app-server process, so Orkestr cannot put a
// per-thread token into their environment. Instead each turn's token is
// written to a 0600 file under <ORKESTR_HOME>/secrets/vault-turn-tokens/,
// named after the Codex thread id. Codex exports CODEX_THREAD_ID to the
// commands it runs; `orkestr vault` uses it to find its own turn's file.
// The file and the token are removed when the turn completes.

export const CODEX_THREAD_ID_ENV = "CODEX_THREAD_ID";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function tokenDir(home) {
  return path.join(path.resolve(home), "secrets", "vault-turn-tokens");
}

/** Token file for a Codex thread; "" without an ORKESTR_HOME or Codex id. */
export function codexVaultTokenFile(codexThreadId, home) {
  const id = clean(codexThreadId);
  if (!id || !clean(home)) return "";
  return path.join(tokenDir(home), `${createHash("sha256").update(id).digest("hex")}.json`);
}

function homeOf(env) {
  return clean(env.ORKESTR_HOME);
}

function ttlMs(env) {
  const parsed = Number(env.ORKESTR_VAULT_CODEX_TOKEN_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

// A root server hands the directory and files to the user the Codex runtime
// runs as (codex-runtime-identity), keeping them 0700/0600; secrets/ itself
// only needs a traversal grant for that user.
async function writeTokenFile(file, record, env) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  await chownToCodexRuntime(dir, env);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chownToCodexRuntime(tmp, env);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readTokenFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Issues a token for the turn about to start on `codexThreadId` and writes it
 * to the thread's token file. A previous turn's token is revoked first.
 * Returns the attempt id ("" when no token could be issued).
 */
export async function issueCodexVaultTurnToken({ threadId, codexThreadId } = {}, env = process.env) {
  const file = codexVaultTokenFile(codexThreadId, homeOf(env));
  if (!file || !clean(threadId)) return "";
  await revokeCodexVaultTurnToken({ threadId, codexThreadId }, env);
  const attemptId = `codex:${clean(codexThreadId)}:${Date.now().toString(36)}`;
  const token = await issueVaultThreadToken({ threadId, attemptId, ttlMs: ttlMs(env) }, env);
  try {
    await writeTokenFile(file, { token, threadId: clean(threadId), attemptId }, env);
  } catch (error) {
    await revokeVaultThreadTokens({ threadId, attemptId }, env).catch(() => {});
    throw error;
  }
  return attemptId;
}

/** Records the Codex turn id once known, so a late completion of an older turn leaves it alone. */
export async function bindCodexVaultTurnToken({ codexThreadId, attemptId, turnId } = {}, env = process.env) {
  const file = codexVaultTokenFile(codexThreadId, homeOf(env));
  const current = file ? await readTokenFile(file) : {};
  if (!current.token || current.attemptId !== attemptId || !clean(turnId)) return;
  await writeTokenFile(file, { ...current, turnId: clean(turnId) }, env);
}

/**
 * Revokes the token of a Codex thread's current turn and removes its file.
 * With `turnId`, a file already bound to a different (newer) turn is kept.
 */
export async function revokeCodexVaultTurnToken({ threadId = "", codexThreadId, turnId = "" } = {}, env = process.env) {
  const file = codexVaultTokenFile(codexThreadId, homeOf(env));
  if (!file) return false;
  const current = await readTokenFile(file);
  if (clean(turnId) && current.turnId && current.turnId !== clean(turnId)) return false;
  const owner = clean(current.threadId || threadId);
  if (owner && current.attemptId) await revokeVaultThreadTokens({ threadId: owner, attemptId: current.attemptId }, env).catch(() => {});
  await fs.rm(file, { force: true }).catch(() => {});
  return Boolean(current.token);
}

/** CLI side: the token of the calling Codex turn, or "". */
export async function readCodexVaultTurnToken(env = process.env, home = homeOf(env)) {
  const file = codexVaultTokenFile(env?.[CODEX_THREAD_ID_ENV], home);
  if (!file) return "";
  return clean((await readTokenFile(file)).token);
}
