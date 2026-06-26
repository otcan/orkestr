#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const activeStates = new Set(["working", "processing", "running", "waking"]);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function threadName(thread = {}) {
  return String(thread.name || thread.displayName || thread.title || thread.id || thread.threadId || "").trim();
}

function threadState(thread = {}) {
  return String(thread.state || thread.publicStatusCode || thread.runtimeState || "").trim();
}

function threadRuntimeKind(thread = {}) {
  return String(thread.runtimeKind || thread.executorTransport || thread.transport || thread.runtime?.runtimeKind || "").trim();
}

function threadSessionName(thread = {}) {
  return String(
    thread.sessionName ||
    thread.tmuxSession ||
    thread.runtime?.sessionName ||
    thread.executor?.sessionName ||
    thread.executor?.metadata?.sourceTmuxSession ||
    "",
  ).trim();
}

function threadPaneId(thread = {}) {
  return String(
    thread.paneId ||
    thread.tmuxTarget ||
    thread.runtime?.paneId ||
    thread.runtime?.tmuxTarget ||
    thread.executor?.tmuxTarget ||
    thread.executor?.metadata?.sourceTmuxTarget ||
    "",
  ).trim();
}

function threadCodexAppServerTransport(thread = {}) {
  return String(
    thread.codexAppServerTransport ||
    thread.appServerTransport ||
    thread.runtime?.codexAppServerTransport ||
    thread.runtime?.appServerTransport ||
    thread.runtime?.appServer?.transport ||
    thread.executor?.metadata?.codexAppServerTransport ||
    "",
  ).trim();
}

function valueSet(value) {
  return new Set(
    String(value || "")
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function ignoreConfig(env = {}) {
  return {
    threadIds: valueSet(env.ORKESTR_DEPLOY_IGNORE_THREAD_IDS),
    threadNames: valueSet(env.ORKESTR_DEPLOY_IGNORE_THREAD_NAMES),
    sessionNames: valueSet(env.ORKESTR_DEPLOY_IGNORE_SESSION_NAMES),
    paneIds: valueSet(env.ORKESTR_DEPLOY_IGNORE_PANE_IDS),
  };
}

function ignoredThread(thread = {}, ignore = {}) {
  const id = String(thread.id || thread.threadId || "").trim();
  const name = threadName(thread);
  const sessionName = threadSessionName(thread);
  const paneId = threadPaneId(thread);
  return Boolean(
    (id && ignore.threadIds?.has(id)) ||
    (name && ignore.threadNames?.has(name)) ||
    (sessionName && ignore.sessionNames?.has(sessionName)) ||
    (paneId && ignore.paneIds?.has(paneId))
  );
}

function isActiveThread(thread = {}) {
  const state = threadState(thread).toLowerCase();
  return Boolean(
    thread.working ||
    thread.foregroundWorking ||
    thread.backgroundWork ||
    thread.typingActive ||
    thread.activeTurnId ||
    number(thread.pendingCount) > 0 ||
    number(thread.runningCount) > 0 ||
    number(thread.awaitingAckCount) > 0 ||
    activeStates.has(state),
  );
}

function threadsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.threads)) return payload.threads;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

export function summarizeActiveThreads(payload) {
  return summarizeActiveThreadsWithOptions(payload);
}

export function summarizeActiveThreadsWithOptions(payload, options = {}) {
  const ignore = options.ignore || ignoreConfig(options.env || {});
  return threadsFromPayload(payload)
    .filter((thread) => !ignoredThread(thread, ignore))
    .filter(isActiveThread)
    .map((thread) => ({
      id: String(thread.id || thread.threadId || "").trim(),
      name: threadName(thread),
      state: threadState(thread),
      runtimeKind: threadRuntimeKind(thread),
      sessionName: threadSessionName(thread),
      paneId: threadPaneId(thread),
      codexAppServerTransport: threadCodexAppServerTransport(thread),
      pendingCount: number(thread.pendingCount),
      runningCount: number(thread.runningCount),
      awaitingAckCount: number(thread.awaitingAckCount),
      activeTurnId: String(thread.activeTurnId || "").trim(),
    }));
}

export function formatActiveThreads(report = {}) {
  const active = Array.isArray(report.active) ? report.active : [];
  if (!active.length) return "No active Orkestr thread work detected.";
  return active
    .map((thread) => {
      const parts = [
        thread.name || thread.id || "unknown",
        thread.state ? `state=${thread.state}` : "",
        thread.runtimeKind ? `runtime=${thread.runtimeKind}` : "",
        thread.sessionName ? `session=${thread.sessionName}` : "",
        thread.paneId ? `pane=${thread.paneId}` : "",
        thread.codexAppServerTransport ? `appServer=${thread.codexAppServerTransport}` : "",
        thread.pendingCount ? `pending=${thread.pendingCount}` : "",
        thread.runningCount ? `running=${thread.runningCount}` : "",
        thread.awaitingAckCount ? `awaitingAck=${thread.awaitingAckCount}` : "",
        thread.activeTurnId ? `turn=${thread.activeTurnId}` : "",
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

const DEFAULT_ACTIVE_CHECK_TIMEOUT_MS = 10000;

async function cliAuthToken(env = process.env) {
  const explicit = String(env.ORKESTR_API_TOKEN || env.ORKESTR_CLI_AUTH_TOKEN || "").trim();
  if (explicit) return explicit;
  const home = String(env.ORKESTR_HOME || "").trim();
  if (!home) return "";
  try {
    const raw = await fs.readFile(path.join(home, "secrets", "cli-auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || "").trim();
    if (!token) return "";
    const expiresAt = Date.parse(String(parsed?.expiresAt || ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return "";
    return token;
  } catch {
    return "";
  }
}

async function activeCheckHeaders(env = process.env) {
  const token = await cliAuthToken(env);
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

async function readJsonUrl(url, timeoutMs = DEFAULT_ACTIVE_CHECK_TIMEOUT_MS, env = process.env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_ACTIVE_CHECK_TIMEOUT_MS));
  try {
    const response = await fetch(url, { signal: controller.signal, headers: await activeCheckHeaders(env) });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, unavailable: true, statusCode: response.status, error: `HTTP ${response.status}`, active: [] };
    }
    return { ok: true, unavailable: false, payload: JSON.parse(text) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkActiveWork(url, options = {}) {
  const checkedAt = new Date().toISOString();
  try {
    const result = await readJsonUrl(url, options.timeoutMs, options.env || process.env);
    if (!result.ok) return { ...result, checkedAt };
    return {
      ok: true,
      unavailable: false,
      checkedAt,
      active: summarizeActiveThreadsWithOptions(result.payload, { env: options.env || process.env }),
    };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      checkedAt,
      active: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function argValue(argv, flag, fallback = "") {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  return argv[index + 1] || fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const url = argValue(argv, "--url", process.env.ORKESTR_DEPLOY_ACTIVE_CHECK_URL || "");
  const timeoutMs = Number(argValue(argv, "--timeout-ms", process.env.ORKESTR_DEPLOY_ACTIVE_CHECK_TIMEOUT_MS || String(DEFAULT_ACTIVE_CHECK_TIMEOUT_MS))) || DEFAULT_ACTIVE_CHECK_TIMEOUT_MS;
  if (!url) {
    console.log(JSON.stringify({ ok: false, unavailable: true, active: [], error: "missing_url", checkedAt: new Date().toISOString() }));
    return;
  }
  const report = await checkActiveWork(url, { timeoutMs });
  if (argv.includes("--text")) console.log(formatActiveThreads(report));
  else console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
