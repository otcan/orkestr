#!/usr/bin/env node
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
  return threadsFromPayload(payload)
    .filter(isActiveThread)
    .map((thread) => ({
      id: String(thread.id || thread.threadId || "").trim(),
      name: threadName(thread),
      state: threadState(thread),
      runtimeKind: threadRuntimeKind(thread),
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

async function readJsonUrl(url, timeoutMs = DEFAULT_ACTIVE_CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_ACTIVE_CHECK_TIMEOUT_MS));
  try {
    const response = await fetch(url, { signal: controller.signal });
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
    const result = await readJsonUrl(url, options.timeoutMs);
    if (!result.ok) return { ...result, checkedAt };
    return {
      ok: true,
      unavailable: false,
      checkedAt,
      active: summarizeActiveThreads(result.payload),
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
