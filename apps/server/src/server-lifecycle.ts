import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../../packages/storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../../packages/storage/src/store.js";
import { codexThreadId } from "../../../packages/core/src/codex-app-server-common.js";
import { listThreads } from "../../../packages/core/src/threads.js";

type ActiveThreadSnapshot = {
  id: string;
  name: string;
  state: string;
  runtimeKind: string;
  activeTurnId: string;
  codexThreadId: string;
};

type LifecycleState = {
  bootId?: string;
  hostname?: string;
  pid?: number;
  startedAt?: string;
  cleanShutdownAt?: string | null;
  shutdownSignal?: string | null;
  startupCause?: string;
  activeThreadCount?: number;
  activeThreads?: ActiveThreadSnapshot[];
  previous?: LifecycleState | null;
};

function nowIso() {
  return new Date().toISOString();
}

function lifecyclePath(env = process.env) {
  return path.join(dataPaths(env).home, "server-lifecycle.json");
}

async function bootId(env = process.env) {
  const override = String(env.ORKESTR_BOOT_ID_FOR_TEST || "").trim();
  if (override) return override;
  const raw = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
  return raw.trim() || "unknown";
}

function activeRuntimeThread(thread: any) {
  const state = String(thread?.state || thread?.runtime?.state || "").trim().toLowerCase();
  const activeTurnId = String(thread?.runtime?.activeTurnId || "").trim();
  const runtimeKind = String(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.transport || "").trim().toLowerCase();
  const activeStates = ["working", "processing", "running", "waking", "queued", "pending_delivery", "awaiting_ack"];
  return Boolean(
    activeTurnId ||
    activeStates.includes(state) ||
    (runtimeKind === "raw-terminal" && state === "ready"),
  );
}

export async function activeThreadSnapshots(env = process.env): Promise<ActiveThreadSnapshot[]> {
  const threads = await listThreads(env).catch(() => []);
  return threads
    .filter(activeRuntimeThread)
    .map((thread: any) => ({
      id: String(thread?.id || ""),
      name: String(thread?.name || thread?.id || ""),
      state: String(thread?.state || thread?.runtime?.state || ""),
      runtimeKind: String(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.transport || ""),
      activeTurnId: String(thread?.runtime?.activeTurnId || ""),
      codexThreadId: codexThreadId(thread),
    }))
    .filter((thread) => thread.id);
}

function startupCause(previous: LifecycleState | null, currentBootId: string) {
  if (!previous?.bootId) return "cold_start";
  if (previous.bootId !== currentBootId) {
    return Number(previous.activeThreadCount || previous.activeThreads?.length || 0) > 0
      ? "host_reboot_with_active_threads"
      : "host_reboot";
  }
  if (previous.startedAt && !previous.cleanShutdownAt) return "unclean_service_restart";
  return "service_restart";
}

export async function recordServerStartup(env = process.env) {
  await ensureDataDirs(env);
  const file = lifecyclePath(env);
  const previous = await readJson(file, null).catch(() => null) as LifecycleState | null;
  const currentBootId = await bootId(env);
  const activeThreads = await activeThreadSnapshots(env);
  const cause = startupCause(previous, currentBootId);
  const state: LifecycleState = {
    bootId: currentBootId,
    hostname: os.hostname(),
    pid: process.pid,
    startedAt: nowIso(),
    cleanShutdownAt: null,
    shutdownSignal: null,
    startupCause: cause,
    activeThreadCount: activeThreads.length,
    activeThreads,
    previous: previous ? {
      bootId: previous.bootId,
      hostname: previous.hostname,
      pid: previous.pid,
      startedAt: previous.startedAt,
      cleanShutdownAt: previous.cleanShutdownAt || null,
      shutdownSignal: previous.shutdownSignal || null,
      startupCause: previous.startupCause,
      activeThreadCount: previous.activeThreadCount || previous.activeThreads?.length || 0,
      activeThreads: previous.activeThreads || [],
    } : null,
  };
  await writeJson(file, state);
  await appendEvent({
    type: "server_startup_recovery_context",
    bootId: currentBootId,
    previousBootId: previous?.bootId || null,
    startupCause: cause,
    previousCleanShutdownAt: previous?.cleanShutdownAt || null,
    previousShutdownSignal: previous?.shutdownSignal || null,
    previousActiveThreadCount: previous?.activeThreadCount || previous?.activeThreads?.length || 0,
    activeThreadCount: activeThreads.length,
    activeThreads,
  }, env).catch(() => {});
  return state;
}

export async function recordServerShutdown(signal = "shutdown", env = process.env) {
  await ensureDataDirs(env);
  const file = lifecyclePath(env);
  const previous = await readJson(file, null).catch(() => null) as LifecycleState | null;
  const activeThreads = await activeThreadSnapshots(env);
  const state: LifecycleState = {
    ...(previous || {}),
    bootId: previous?.bootId || await bootId(env),
    hostname: os.hostname(),
    pid: process.pid,
    cleanShutdownAt: nowIso(),
    shutdownSignal: signal,
    activeThreadCount: activeThreads.length,
    activeThreads,
  };
  await writeJson(file, state);
  await appendEvent({
    type: "server_shutdown_snapshot",
    bootId: state.bootId || null,
    signal,
    activeThreadCount: activeThreads.length,
    activeThreads,
  }, env).catch(() => {});
  return state;
}

export function recoveryCauseForStartup(state: LifecycleState | null | undefined) {
  const cause = String(state?.startupCause || "").trim();
  if (cause === "host_reboot_with_active_threads" || cause === "host_reboot") return "host_reboot";
  return "orkestr_restart";
}
