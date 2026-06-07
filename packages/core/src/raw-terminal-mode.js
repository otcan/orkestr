export const RAW_TERMINAL_RUNTIME_KIND = "raw-terminal";
export const RAW_TERMINAL_TRANSPORT = "raw-terminal";

function clean(value) {
  return String(value || "").trim();
}

function safeName(value) {
  return clean(value).replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function nowIso() {
  return new Date().toISOString();
}

export function rawTerminalSessionName(threadOrId = {}) {
  const id = typeof threadOrId === "string" ? threadOrId : threadOrId?.id;
  return `orkestr-thread-${safeName(id).slice(0, 48)}`;
}

export function rawTerminalTtlMs(env = process.env) {
  const raw = clean(env.ORKESTR_RAW_TERMINAL_TTL_MS);
  if (["0", "off", "false", "disabled"].includes(raw.toLowerCase())) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15 * 60_000;
}

export function threadUsesRawTerminalMode(thread = {}) {
  const transport = clean(thread?.executor?.transport || thread?.executor?.metadata?.transport).toLowerCase();
  const runtimeKind = clean(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.metadata?.runtimeKind).toLowerCase();
  const terminalMode = clean(thread?.terminalMode || thread?.runtime?.terminalMode || thread?.executor?.metadata?.terminalMode).toLowerCase();
  return transport === RAW_TERMINAL_TRANSPORT ||
    runtimeKind === RAW_TERMINAL_RUNTIME_KIND ||
    terminalMode === RAW_TERMINAL_RUNTIME_KIND;
}

export function rawTerminalModePatch(thread = {}, fields = {}) {
  const sessionName = clean(fields.sessionName || rawTerminalSessionName(thread));
  const paneId = clean(fields.paneId || thread?.runtime?.paneId || thread?.executor?.tmuxTarget);
  const metadata = thread?.executor?.metadata || {};
  const previousTransport = clean(metadata.previousTransport || thread?.executor?.transport || metadata.transport || thread?.runtimeKind);
  const previousRuntimeKind = clean(metadata.previousRuntimeKind || thread?.runtime?.runtimeKind || thread?.runtimeKind || metadata.runtimeKind);
  const terminalModeStartedAt = clean(metadata.terminalModeStartedAt || fields.startedAt || nowIso());
  return {
    terminalMode: RAW_TERMINAL_RUNTIME_KIND,
    runtimeKind: RAW_TERMINAL_RUNTIME_KIND,
    runtime: {
      ...(thread.runtime || {}),
      ...(fields.runtime || {}),
      runtimeKind: RAW_TERMINAL_RUNTIME_KIND,
      terminalMode: RAW_TERMINAL_RUNTIME_KIND,
      sessionName,
      ...(paneId ? { paneId } : {}),
    },
    executor: {
      ...(thread.executor || {}),
      transport: RAW_TERMINAL_TRANSPORT,
      sessionName,
      ...(paneId ? { tmuxTarget: paneId } : {}),
      metadata: {
        ...metadata,
        transport: RAW_TERMINAL_TRANSPORT,
        runtimeKind: RAW_TERMINAL_RUNTIME_KIND,
        terminalMode: RAW_TERMINAL_RUNTIME_KIND,
        previousTransport: previousTransport || null,
        previousRuntimeKind: previousRuntimeKind || null,
        terminalModeStartedAt,
      },
    },
  };
}
