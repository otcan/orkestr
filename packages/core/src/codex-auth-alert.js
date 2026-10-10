// Owner-visible Codex auth failure handling: records turns rejected for Codex
// auth, raises one watcher alert per window with the exact login fix, and
// reports auth state for `orkestr doctor codex` without reading token files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { readCodexAuthHealth } from "./codex-auth-health.js";
import { codexRuntimeOwner } from "./codex-runtime-identity.js";

const maxFailedTurns = 200;

function clean(value) {
  return String(value || "").trim();
}

export function codexAuthFailedTurnsPath(env = process.env) {
  return path.join(dataPaths(env).home, "codex-auth-failed-turns.json");
}

export function codexAuthAlertWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_AUTH_ALERT_WINDOW_MS ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(60_000, parsed) : 6 * 60 * 60 * 1000;
}

// The login must run as the OS user the Codex runtime runs as; fall back to the
// service/process user only when the runtime identity is unresolved.
export async function codexAuthFixCommand(env = process.env, deps = {}) {
  const owner = await (deps.codexRuntimeOwner || codexRuntimeOwner)(env).catch(() => null);
  let user = clean(owner?.user) || clean(env.ORKESTR_SERVICE_USER);
  if (!user) {
    try { user = os.userInfo().username; } catch { user = "<service-user>"; }
  }
  return `sudo -u ${user} -H bash -lc 'cd ~ && codex login --device-auth'`;
}

async function readStore(env) {
  const raw = await readJson(codexAuthFailedTurnsPath(env), null).catch(() => null);
  return { turns: Array.isArray(raw?.turns) ? raw.turns : [], alertedAt: clean(raw?.alertedAt) || null };
}

function threadLabel(turn) {
  return turn.threadName ? `${turn.threadName} (${turn.threadId})` : turn.threadId;
}

export function formatCodexAuthAlert(turns = [], fixCommand = "") {
  const threads = [...new Map(turns.map((turn) => [turn.threadId, turn])).values()];
  return [
    `Codex sign-in was rejected (${clean(turns.at(-1)?.reason) || "codex_auth_failed"}); Codex threads cannot run turns.`,
    `Fix: log in again: ${fixCommand}`,
    `Failed threads: ${threads.map(threadLabel).join(", ") || "none recorded"}`,
    "After login, retry the failed inputs: orkestr threads retry-failed --since 2h [--dry-run]",
  ].join("\n");
}

// Records one auth-rejected turn and alerts the owner at most once per window.
export async function recordCodexAuthFailedTurn({ thread = {}, turnId = "", messageId = "", reason = "" } = {}, env = process.env, deps = {}) {
  const threadId = clean(thread.id);
  if (!threadId) return null;
  const now = new Date();
  const store = await readStore(env);
  const key = `${threadId}:${clean(turnId) || clean(messageId)}`;
  if (!store.turns.some((turn) => `${turn.threadId}:${turn.turnId || turn.messageId}` === key)) {
    store.turns.push({
      threadId,
      threadName: clean(thread.name),
      turnId: clean(turnId) || null,
      messageId: clean(messageId) || null,
      reason: clean(reason) || "codex_runtime_auth_invalid",
      at: now.toISOString(),
    });
    store.turns = store.turns.slice(-maxFailedTurns);
  }
  const windowMs = codexAuthAlertWindowMs(env);
  const lastAlertMs = Date.parse(store.alertedAt || "");
  // A repair after the last alert starts a new incident: alert again at once.
  const repairedMs = Date.parse(clean((await readCodexAuthHealth(env))?.repairedAt));
  let alerted = false;
  if (!Number.isFinite(lastAlertMs) || now.getTime() - lastAlertMs >= windowMs || repairedMs > lastAlertMs) {
    const recent = store.turns.filter((turn) => now.getTime() - Date.parse(turn.at) <= windowMs);
    const recordAlert = deps.recordWatcherAlert || (await import("./watcher-alerts.js")).recordWatcherAlert;
    const result = await recordAlert({
      severity: "error",
      source: "codex_auth",
      code: "codex_auth_failed",
      message: formatCodexAuthAlert(recent, await codexAuthFixCommand(env, deps)),
      mirrorToConnector: true,
    }, env).catch(() => null);
    alerted = Boolean(result?.ok);
    if (alerted) store.alertedAt = now.toISOString();
  }
  await writeJson(codexAuthFailedTurnsPath(env), store);
  if (alerted) await appendEvent({ type: "codex_auth_owner_alerted", threadId, turnId: clean(turnId) || null }, env).catch(() => {});
  return { alerted, turns: store.turns.length };
}

export function parseSinceMs(value = "", fallbackMs = 2 * 60 * 60 * 1000) {
  const match = clean(value).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallbackMs;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match[2] || "h").toLowerCase()];
  return Math.floor(Number(match[1]) * unit);
}

export async function listCodexAuthFailedTurns({ sinceMs = 2 * 60 * 60 * 1000 } = {}, env = process.env, deps = {}) {
  const { turns } = await readStore(env);
  const cutoff = Date.now() - sinceMs;
  const threads = deps.getThreadMessage && deps.listThreadMessages ? deps : await import("./threads.js");
  const recent = turns.filter((turn) => Date.parse(turn.at) >= cutoff);
  return Promise.all(recent.map(async (turn) => {
    // The turn parent is only remembered in memory; fall back to the input
    // message tagged with the failed Codex turn id.
    const message = turn.messageId
      ? await threads.getThreadMessage(turn.threadId, turn.messageId, env).catch(() => null)
      : turn.turnId
        ? (await threads.listThreadMessages(turn.threadId, env).catch(() => []))
          .find((item) => item.role === "user" && clean(item.codexTurnId) === turn.turnId) || null
        : null;
    return { ...turn, messageId: turn.messageId || message?.id || null, role: clean(message?.role) || null, state: clean(message?.state) || null, text: clean(message?.text) || null };
  }));
}

// Auth state for doctor output: login status command plus recorded failures;
// never reads auth.json or any token content. Callers inject the connector's
// `codexLoginStatus` (core must not import connectors).
export async function codexAuthDoctor(env = process.env, deps = {}) {
  const loginStatus = deps.codexLoginStatus || (async () => ({ connected: false, reason: "status_unavailable" }));
  const login = await loginStatus({ env, home: env.HOME || os.homedir(), timeoutMs: 5000 }).catch((error) => ({ connected: false, reason: "status_failed", message: error?.message || String(error) }));
  const health = await readCodexAuthHealth(env);
  const { turns, alertedAt } = await readStore(env);
  const recent = turns.filter((turn) => Date.now() - Date.parse(turn.at) <= 24 * 60 * 60 * 1000);
  let broken = clean(health?.state) === "broken";
  let recoveredAt = clean(health?.repairedAt) || null;
  if (broken && login.connected && login.codexHome) {
    // A login after the failure (auth.json rewritten; mtime only, never contents) supersedes it.
    const detectedMs = Date.parse(clean(health.detectedAt || health.updatedAt));
    const authStat = await fs.stat(path.join(login.codexHome, "auth.json")).catch(() => null);
    if (authStat && Number.isFinite(detectedMs) && authStat.mtimeMs > detectedMs + 10) {
      broken = false;
      recoveredAt = new Date(authStat.mtimeMs).toISOString();
    }
  }
  return {
    ok: Boolean(login.connected) && !broken,
    login: { connected: Boolean(login.connected), authMode: login.authMode || null, reason: login.reason || null, message: clean(login.message) },
    health: health ? {
      state: broken ? "broken" : recoveredAt ? "recovered" : health.state || null,
      reason: health.reason || null,
      lastFailureAt: health.detectedAt || null,
      recoveredAt: broken ? null : recoveredAt,
      threadId: health.threadId || null,
    } : null,
    recentFailures: recent.length,
    failedThreads: [...new Set(recent.map((turn) => turn.threadId))],
    alertedAt,
    fix: broken || !login.connected ? await codexAuthFixCommand(env, deps) : null,
  };
}
