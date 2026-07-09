import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { doctorRuntimeResources, listRuntimeLeases } from "../../../../../packages/core/src/runtime-leases.js";
import { getSetupStatus, publicSetupStatus } from "../../../../../packages/core/src/setup.js";
import { readRuntimeSettings, writeRuntimeSettings } from "../../../../../packages/core/src/runtime-settings.js";
import { systemDoctor } from "../../../../../packages/core/src/system-doctor.js";
import { whereAmI } from "../../../../../packages/core/src/whereiam.js";
import {
  appendApiSessionMessage,
  bindApiSessionToThread,
  getApiSessionBindingForPrincipal,
} from "../../../../../packages/core/src/api-session-bindings.js";
import {
  deliverWhatsAppReplies,
  waitForWhatsAppOutboundDeliveryResultForMessage,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { listEventsForPrincipal } from "../../../../../packages/core/src/audit-events.js";
import { listWatcherAlerts, updateWatcherAlertLifecycle } from "../../../../../packages/core/src/watcher-alerts.js";
import { createStateBackup, stateBackupStatus, stateRestorePlan } from "../../../../../packages/core/src/state-backups.js";
import { migrateCodexThreadsToAppServer } from "../../../../../packages/core/src/codex-app-server-migration.js";
import { createFolderForPrincipal, deleteFileForPrincipal, listFilesForPrincipal, listWorkspaceFoldersForPrincipal, saveFilesForPrincipal } from "../../../../../packages/core/src/workspace-files.js";
import { assertSanitizedAction } from "../../../../../packages/core/src/llm-sanitizer.js";
import { getThread, listThreads, listThreadsForPrincipal } from "../../../../../packages/core/src/threads.js";
import { userScopedCapabilityHints } from "../../../../../packages/core/src/user-skills.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { distributionIdentity } from "../../../../../packages/core/src/distribution.js";
import { getUser } from "../../../../../packages/core/src/users.js";
import { listTenantVms } from "../../../../../packages/core/src/tenant-vm-registry.js";
import { configuredWhatsAppChatNamePrefix, defaultWhatsAppReplyPrefix } from "../../../../../packages/core/src/whatsapp-defaults.js";
import {
  parentConnectorProviderDefinitions,
  parentConnectorRuntimeConfig,
} from "../../../../../packages/connectors/src/parent-connector-apps.js";
import { getGoogleWorkspaceConnectRequest } from "../../../../../packages/connectors/src/google-workspace.js";
import {
  approvePairingChallenge,
  createPairingChallenge,
  deletePairingChallenge,
  getPairingChallenge,
  listPairingChallenges,
  listSecuritySessions,
  pairBrowser,
  rejectPairingChallenge,
  revokeAllSecuritySessions,
  revokeSecuritySession,
  securityStatus,
  sessionCookieHeader,
  setSecurityPairingEnabled,
} from "../../../../../packages/core/src/security.js";
import { publicConfig } from "../../../../../packages/storage/src/config.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { eventArchiveDownloadPath, eventStorageStatus, listEventArchives, rotateEvents } from "../../../../../packages/storage/src/store.js";
import { instanceSetupReturnPath } from "../../instance-connect-setup.js";
import { httpError } from "../../common/http.js";
import { sanitizedThreadActionInput } from "../threads/thread-route-helpers.js";

const execFileAsync = promisify(execFile);
let lastCpuSample: { idle: number; total: number } | null = null;
const publicConnectorRuntimeConfigKeys = new Set([
  "account",
  "audience",
  "authorizeUrl",
  "clientId",
  "redirectUri",
  "scopes",
  "shop",
  "tenantId",
  "tokenUrl",
]);

function cleanText(value: unknown): string {
  return String(value || "").trim();
}

function contentDispositionFilename(name: string): string {
  return path.basename(String(name || "events.jsonl")).replace(/["\r\n\\]/g, "_") || "events.jsonl";
}

function isTenantScopedRuntime(env = process.env): boolean {
  return Boolean(
    cleanText(env.ORKESTR_TENANT_VM_ID) ||
      cleanText(env.ORKESTR_TENANT_SLICE_ID) ||
      cleanText(env.ORKESTR_TENANT_BOUNDARY) === "tenant-vm",
  );
}

function sanitizerFallbackScore(thread: any): number {
  if (!thread?.id) return 0;
  const runtimeKind = cleanText(thread.runtimeKind || thread.runtime?.runtimeKind || thread.executor?.metadata?.runtimeKind).toLowerCase();
  const executorTransport = cleanText(thread.executor?.transport || thread.executor?.metadata?.transport).toLowerCase();
  const usesAppServer = ["codex-app-server", "app-server"].includes(runtimeKind) || ["codex-app-server", "app-server"].includes(executorTransport);
  const codexThreadId = cleanText(thread.executor?.codexThreadId || thread.codexThreadId || thread.runtime?.codexThreadId);
  const workspace = cleanText(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath);
  if (!usesAppServer || !codexThreadId || !workspace) return 0;
  let score = 40;
  const state = cleanText(thread.state).toLowerCase();
  const runtimeState = cleanText(thread.runtime?.state).toLowerCase();
  if (state === "working" || runtimeState === "working") score += 100;
  if (cleanText(thread.runtime?.activeTurnId)) score += 80;
  if (cleanText(thread.runtime?.pendingRequest)) score += 60;
  if (cleanText(thread.runtime?.lastTurnStatus).toLowerCase() === "completed") score += 5;
  return score;
}

async function resolveTenantSanitizerFallbackThread(principal: any, env = process.env) {
  if (!isTenantScopedRuntime(env)) return null;
  const threads = principal ? await listThreadsForPrincipal(principal, env) : await listThreads(env);
  const scored = threads
    .map((thread) => ({ thread, score: sanitizerFallbackScore(thread) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  const top = scored[0];
  const tied = scored.filter((item) => item.score === top.score);
  if (tied.length > 1) return null;
  const owner = cleanText(env.ORKESTR_ADMIN_USER_ID);
  if (owner && cleanText(top.thread.ownerUserId || top.thread.userId) !== owner) return null;
  return top.thread;
}

async function gitValue(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: process.cwd(), timeout: 1000 });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

async function buildMetadata() {
  const release = await releaseMetadata();
  const distribution = distributionIdentity(process.env, release || {});
  const commit = String(
    process.env.ORKESTR_BUILD_COMMIT ||
      release?.git?.commit ||
      process.env.GIT_COMMIT ||
      process.env.SOURCE_VERSION ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      "",
  ).trim() || await gitValue(["rev-parse", "HEAD"]);
  const branch = String(
    process.env.ORKESTR_BUILD_BRANCH ||
      release?.git?.branch ||
      process.env.GIT_BRANCH ||
      process.env.VERCEL_GIT_COMMIT_REF ||
      "",
  ).trim() || await gitValue(["branch", "--show-current"]);
  const tag = String(process.env.ORKESTR_BUILD_TAG || release?.git?.tag || "").trim() ||
    await gitValue(["describe", "--tags", "--exact-match", "HEAD"]);
  const describe = String(process.env.ORKESTR_BUILD_DESCRIBE || release?.git?.describe || "").trim() ||
    await gitValue(["describe", "--tags", "--always", "--dirty", "--long"]);
  const dirty = release?.git?.dirty === true
    ? true
    : release?.git?.dirty === false
      ? false
      : (await gitValue(["status", "--porcelain"])) !== "";
  return {
    commit,
    branch,
    tag,
    describe,
    dirty,
    channel: String(process.env.ORKESTR_DEPLOY_CHANNEL || release?.channel || "").trim() || null,
    releaseId: String(release?.releaseId || "").trim() || null,
    releaseLabel: String(release?.releaseLabel || "").trim() || null,
    releaseVersion: String(release?.releaseVersion || release?.version || "").trim() || null,
    buildId: String(release?.buildId || release?.releaseId || "").trim() || null,
    deployedAt: String(release?.deployedAt || "").trim() || null,
    manifestSchemaVersion: release?.schemaVersion || null,
    distribution,
  };
}

async function releaseMetadata() {
  const candidates = [
    process.env.ORKESTR_RELEASE_MANIFEST,
    path.resolve(process.cwd(), "release-manifest.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(String(candidate), "utf8"));
    } catch {
      // Release manifests are optional for local development.
    }
  }
  return null;
}

async function publicEffectiveConfig() {
  const config = await publicConfig();
  for (const definition of parentConnectorProviderDefinitions()) {
    if (!definition.defaultRedirectPath) continue;
    const current = config[definition.provider] && typeof config[definition.provider] === "object"
      ? { ...config[definition.provider] }
      : {};
    const runtime = parentConnectorRuntimeConfig(definition.provider, current, process.env);
    for (const [key, value] of Object.entries(runtime)) {
      if (!publicConnectorRuntimeConfigKeys.has(key)) continue;
      const text = String(value || "").trim();
      if (!text) continue;
      current[key] = text;
    }
    if (Object.keys(current).length) config[definition.provider] = current;
  }
  return config;
}

function pct(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function safeOsUptime(): number {
  try {
    return os.uptime();
  } catch {
    return 0;
  }
}

async function diskStatus() {
  const target = process.cwd() || "/";
  const stats = await fs.statfs(target).catch(() => null);
  if (!stats) return { path: target, total: 0, used: 0, free: 0, percent: 0 };
  const total = Number(stats.blocks || 0) * Number(stats.bsize || 0);
  const free = Number(stats.bavail || 0) * Number(stats.bsize || 0);
  const used = Math.max(0, total - free);
  return { path: target, total, used, free, percent: pct(used, total) };
}

async function processRows(sort = "cpu") {
  const generatedAt = new Date().toISOString();
  const args = process.platform === "darwin"
    ? ["-axo", "pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=,command="]
    : ["-eo", "pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=,args="];
  try {
    const { stdout } = await execFileAsync("ps", args, { maxBuffer: 1024 * 1024 });
    const rows = String(stdout || "").trim().split("\n").filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      const [pid, ppid, user, cpu, memory, rss, command, ...commandArgs] = parts;
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        user,
        cpu: Number(cpu) || 0,
        memory: Number(memory) || 0,
        rss: (Number(rss) || 0) * 1024,
        command,
        args: commandArgs.join(" "),
      };
    }).filter((row) => row.command !== "ps" && row.pid !== process.pid);
    rows.sort((left, right) => {
      if (sort === "rss" || sort === "memory") return right.rss - left.rss;
      return right.cpu - left.cpu;
    });
    return { count: rows.length, processes: rows.slice(0, 40), generatedAt };
  } catch (error: any) {
    return { count: 0, processes: [], generatedAt, error: String(error?.message || error || "") };
  }
}

async function cpuPercent(fallback: number): Promise<number> {
  const stat = await fs.readFile("/proc/stat", "utf8").catch(() => "");
  const line = stat.split("\n")[0] || "";
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  if (values.length < 4) return fallback;
  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const current = { idle, total };
  const previous = lastCpuSample;
  lastCpuSample = current;
  if (!previous) return fallback;
  const deltaTotal = current.total - previous.total;
  const deltaIdle = current.idle - previous.idle;
  if (deltaTotal <= 0) return fallback;
  return pct(deltaTotal - deltaIdle, deltaTotal);
}

async function systemSnapshot() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const cpus = os.cpus().length || 1;
  const loadAverage = os.loadavg();
  const disk = await diskStatus();
  const processMemory = process.memoryUsage();
  const percent = await cpuPercent(pct(loadAverage[0], cpus));
  return {
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: safeOsUptime(),
    cpu: {
      count: cpus,
      model: os.cpus()[0]?.model || "unknown",
      percent,
    },
    cpuPercent: percent,
    loadAverage: {
      one: loadAverage[0],
      five: loadAverage[1],
      fifteen: loadAverage[2],
    },
    memory: {
      total: memoryTotal,
      free: memoryFree,
      used: memoryUsed,
      percent: pct(memoryUsed, memoryTotal),
    },
    disk,
    network: {
      rxRateBps: 0,
      txRateBps: 0,
      note: "network rates require an overlay metrics adapter",
    },
    diskIo: {
      readBps: 0,
      writeBps: 0,
      utilPercent: 0,
      note: "disk IO rates require an overlay metrics adapter",
    },
    orkestr: {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal,
    },
  };
}

async function pairingChallengeTarget(body: Record<string, unknown> = {}, request: any) {
  let userId = String(body.userId || body.targetUserId || "").trim();
  const instanceId = String(body.instanceId || body.instance || body.orkestrInstanceId || "").trim();
  const requestedPath = sameOriginRequestedPath(body, instanceId);
  let derivedFromInstanceOwner = false;
  if (!userId && instanceId) {
    userId = await ownerUserIdForBrokerInstance(instanceId);
    derivedFromInstanceOwner = Boolean(userId);
  }
  if (!userId) return { instanceId, requestedPath };
  const principal = requestPrincipal(request);
  const status = await securityStatus();
  const trustedAdminContext = isAdminPrincipal(principal) && (request?.orkestrSecuritySession || !status.authEnabled);
  if (!trustedAdminContext && !derivedFromInstanceOwner) {
    throw httpError("admin_pairing_required", 403);
  }
  const user = await getUser(userId);
  if (!user) throw httpError("user_not_found", 404);
  if (user.status === "disabled") throw httpError("user_disabled", 409);
  return {
    userId: user.id,
    role: user.role,
    instanceId,
    requestedPath,
    ...(await connectorAuthIntentForRequestedPath(requestedPath, instanceId, user.id)),
  };
}

async function ownerUserIdForBrokerInstance(instanceId = ""): Promise<string> {
  const id = String(instanceId || "").trim();
  if (!id) return "";
  const vms = await listTenantVms().catch(() => []);
  const vm = vms.find((item: any) =>
    String(item?.labels?.brokerInstanceId || item?.labels?.instanceId || "").trim() === id ||
    String(item?.endpoint?.brokerInstanceId || "").trim() === id,
  );
  return String(vm?.ownerUserId || "").trim();
}

function sameOriginRequestedPath(body: Record<string, unknown> = {}, instanceId = ""): string {
  const raw = String(body.requestedPath || body.return || body.returnTo || "").trim().slice(0, 1000);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "";
  if (instanceId) return instanceSetupReturnPath(instanceId, raw);
  try {
    const target = new URL(raw, "http://localhost");
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "";
  }
}

async function connectorAuthIntentForRequestedPath(requestedPath = "", instanceId = "", userId = "") {
  if (!requestedPath) return {};
  let target: URL;
  try {
    target = new URL(requestedPath, "http://localhost");
  } catch {
    return {};
  }
  const parts = target.pathname.split("/").filter(Boolean);
  if (parts[0] !== "i" || parts[1] !== instanceId || parts[2] !== "app" || parts[3] !== "connectors") return {};
  const service = String(parts[4] || target.searchParams.get("service") || "").trim().toLowerCase();
  if (service !== "gmail") return {};
  if (target.searchParams.get("mcp") !== "tools/call") return {};
  if (target.searchParams.get("tool") !== "orkestr_auth") return {};
  if (target.searchParams.get("service") !== "gmail") return {};
  if (target.searchParams.get("provider") !== "google_workspace") return {};
  if (target.searchParams.get("action") !== "connect") return {};
  if (target.searchParams.get("instance_id") !== instanceId) return {};
  const connectId = String(target.searchParams.get("connect") || target.searchParams.get("connect_id") || "").trim();
  const connectRequest = await googleWorkspaceConnectRequestForPairingIntent(connectId, instanceId);
  const thread = String(target.searchParams.get("thread") || target.searchParams.get("thread_id") || "").trim();
  const trustedThread = String(
    connectRequest?.threadName ||
      connectRequest?.brokerTenantThreadName ||
      connectRequest?.threadTitle ||
      connectRequest?.threadId ||
      connectRequest?.brokerTenantThreadId ||
      thread,
  ).trim();
  const trustedConnectId = String(connectRequest?.connectId || connectId).trim();
  return {
    allowedActions: [trustedConnectId ? `orkestr_auth.google.connect:${trustedConnectId}` : "orkestr_auth.google.connect"],
    authIntent: {
      mcp: "tools/call",
      tool: "orkestr_auth",
      service: "gmail",
      provider: "google_workspace",
      action: "connect",
      actionLabel: "Connect Gmail",
      title: "Approve Gmail connection",
      description: `Approve Google Workspace access for instance ${instanceId}.`,
      connectId: trustedConnectId,
      instanceId,
      userId,
      thread: trustedThread,
      threadId: String(connectRequest?.threadId || connectRequest?.brokerTenantThreadId || "").trim(),
      chatId: String(connectRequest?.chatId || connectRequest?.brokerTenantChatId || "").trim(),
      accountId: String(connectRequest?.accountId || connectRequest?.brokerTenantAccountId || "").trim(),
      account: String(connectRequest?.account || "").trim().toLowerCase(),
      source: String(connectRequest?.source || (trustedConnectId ? "connect_link" : "")).trim(),
    },
  };
}

async function googleWorkspaceConnectRequestForPairingIntent(connectId = "", instanceId = "") {
  const id = String(connectId || "").trim();
  if (!id) return null;
  const payload = await getGoogleWorkspaceConnectRequest(id).catch(() => null);
  const request = payload?.request && typeof payload.request === "object" ? payload.request : null;
  if (!request) return null;
  const requestInstanceId = String(request.brokerInstanceId || request.instanceId || "").trim();
  if (requestInstanceId && requestInstanceId !== instanceId) return null;
  return request;
}

function shouldRedactSetupStatus(request: any, status: any): boolean {
  if (!status?.security?.authEnabled) return false;
  if (request?.orkestrMachineAuth === "broker_proxy") return false;
  if (!request?.orkestrSecuritySession && !["cli", "broker_proxy"].includes(String(request?.orkestrMachineAuth || ""))) return true;
  return !isAdminPrincipal(requestPrincipal(request));
}

function setupStatusForRequest(request: any, status: any): any {
  if (request?.orkestrMachineAuth !== "broker_proxy") return status;
  return {
    ...status,
    security: {
      ...(status?.security || {}),
      paired: true,
      remoteReady: true,
    },
  };
}

function normalizeWhatsAppAccessMode(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["own", "self", "self-managed", "self_managed", "local"].includes(normalized)) return "own";
  return "relay";
}

function apiSessionDeliveryResultForMessage(delivery: any, messageId: string) {
  const delivered = Array.isArray(delivery?.delivered)
    ? delivery.delivered.find((item: any) => String(item?.messageId || "") === messageId)
    : null;
  const failed = Array.isArray(delivery?.failed)
    ? delivery.failed.find((item: any) => String(item?.messageId || "") === messageId)
    : null;
  const skipped = Array.isArray(delivery?.skipped)
    ? delivery.skipped.find((item: any) => String(item?.messageId || "") === messageId)
    : null;
  if (delivered) return { ok: true, state: "delivered", delivered };
  if (failed) return { ok: false, state: "failed", failure: failed, statusCode: 502 };
  if (skipped) return { ok: false, state: "skipped", skipped, statusCode: 409 };
  return { ok: false, state: "missing_delivery_result", statusCode: 502 };
}

function positiveInteger(value: unknown, fallback: number, minimum = 1): number {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function apiSessionDeliveryTimeoutMs(env = process.env): number {
  return positiveInteger(env.ORKESTR_API_SESSION_DELIVERY_TIMEOUT_MS, 30_000, 0);
}

function apiSessionDeliveryConfirmationMs(env = process.env): number {
  const timeoutMs = apiSessionDeliveryTimeoutMs(env);
  const fallback = Math.min(timeoutMs || 0, 10_000);
  return positiveInteger(env.ORKESTR_API_SESSION_DELIVERY_CONFIRMATION_MS, fallback, 0);
}

async function deliverWhatsAppRepliesForApiSession(env = process.env): Promise<any> {
  const timeoutMs = apiSessionDeliveryTimeoutMs(env);
  if (!timeoutMs) return deliverWhatsAppReplies(env);
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      deliverWhatsAppReplies(env),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`whatsapp_delivery_timeout:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function throwApiSessionDeliveryTimeout(message: any, timeoutMs: number): never {
  throw new HttpException({
    ok: false,
    error: "whatsapp_delivery_timeout",
    deliveryState: "timeout",
    reason: `WhatsApp delivery did not complete within ${timeoutMs}ms`,
    timeoutMs,
    pending: true,
    message: {
      id: message.id,
      threadId: message.threadId || null,
      connector: message.connector || null,
      chatId: message.chatId || null,
    },
  }, 504);
}

async function apiSessionConfirmedDeliveryResultForMessage(delivery: any, messageId: string, env = process.env) {
  const direct = apiSessionDeliveryResultForMessage(delivery, messageId);
  if (direct.ok) return direct;
  const confirmationMs = apiSessionDeliveryConfirmationMs(env);
  if (!confirmationMs) return direct;
  const persisted = await waitForWhatsAppOutboundDeliveryResultForMessage(messageId, {
    env,
    timeoutMs: confirmationMs,
    intervalMs: 250,
  }).catch(() => null);
  if (persisted?.ok || ["failed", "skipped"].includes(String(persisted?.state || ""))) return persisted;
  return direct;
}

function throwApiSessionDeliveryError(result: any, message: any, delivery: any): never {
  throw new HttpException({
    ok: false,
    error: "whatsapp_delivery_not_delivered",
    deliveryState: result.state,
    reason: result.failure?.error || result.failure?.reason || result.skipped?.reason || result.state,
    message: {
      id: message.id,
      threadId: message.threadId || null,
      connector: message.connector || null,
      chatId: message.chatId || null,
    },
    delivery,
  }, result.statusCode || 502);
}

@Controller("api")
export class SystemController {
  @Get("health")
  health() {
    return { ok: true, name: "orkestr", generatedAt: new Date().toISOString() };
  }

  @Get("version")
  async version() {
    const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
    const build = await buildMetadata();
    return {
      name: pkg.name || "orkestr",
      version: pkg.version || "0.0.0",
      commit: build.commit,
      branch: build.branch,
      tag: build.tag,
      describe: build.describe,
      dirty: build.dirty,
      channel: build.channel,
      releaseId: build.releaseId,
      releaseLabel: build.releaseLabel,
      releaseVersion: build.releaseVersion,
      buildId: build.buildId,
      deployedAt: build.deployedAt,
      manifestSchemaVersion: build.manifestSchemaVersion,
      distribution: build.distribution,
      distributionKind: build.distribution.kind,
      deploymentTrack: build.distribution.track,
      repoRole: build.distribution.repoRole,
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("ready")
  async ready() {
    const status = await getSetupStatus();
    return {
      ok: true,
      dataHome: await this.dataDirReady(),
      setupState: status.setupState,
      overlayValid: status.overlay.valid,
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("setup/status")
  async setupStatus(@Req() request: any) {
    const status = setupStatusForRequest(request, {
      ...(await getSetupStatus({ principal: requestPrincipal(request) })),
      config: await publicEffectiveConfig(),
      whatsappDefaults: {
        chatNamePrefix: configuredWhatsAppChatNamePrefix(),
        replyPrefix: defaultWhatsAppReplyPrefix(),
      },
    });
    return shouldRedactSetupStatus(request, status) ? publicSetupStatus(status) : status;
  }

  @Post("setup/demo-preferences")
  @HttpCode(200)
  async saveSetupDemoPreferences(@Body() body: Record<string, unknown> = {}) {
    const whatsappAccessMode = normalizeWhatsAppAccessMode(body.whatsappAccessMode || body.whatsappMode || body.whatsapp);
    const settings = await writeRuntimeSettings({
      connectors: {
        whatsapp: {
          accessMode: whatsappAccessMode,
          bridgeMode: whatsappAccessMode === "own" ? "local" : "relay",
        },
      },
    });
    return {
      ok: true,
      demo: { whatsappAccessMode },
      settings,
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("setup/backup/status")
  async setupBackupStatus() {
    const [status, codexMigration] = await Promise.all([
      stateBackupStatus(),
      migrateCodexThreadsToAppServer({ dryRun: true }).catch((error: any) => ({
        ok: false,
        error: error?.message || String(error),
      })),
    ]);
    return { ...status, migration: { ...status.migration, codexAppServer: { ...status.migration.codexAppServer, dryRun: codexMigration } } };
  }

  @Post("setup/backup/create")
  @HttpCode(200)
  async createSetupBackup(@Body() body: Record<string, unknown> = {}) {
    return createStateBackup({ label: String(body.label || "") });
  }

  @Post("setup/backup/restore-plan")
  @HttpCode(200)
  async setupBackupRestorePlan(@Body() body: Record<string, unknown> = {}) {
    return stateRestorePlan({
      backupPath: String(body.backupPath || body.path || body.name || ""),
      serviceName: String(body.serviceName || ""),
    });
  }

  @Get("settings")
  async settings() {
    return { settings: await readRuntimeSettings(), generatedAt: new Date().toISOString() };
  }

  @Get("setup/security/status")
  async setupSecurityStatus() {
    return { security: await securityStatus() };
  }

  @Post("setup/security/challenge")
  @HttpCode(200)
  async setupSecurityChallenge(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createPairingChallenge({ request, reusePending: true, ...(await pairingChallengeTarget(body, request)) } as any);
  }

  @Post("setup/security/challenges")
  @HttpCode(200)
  async setupSecurityChallenges(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createPairingChallenge({ request, reusePending: true, ...(await pairingChallengeTarget(body, request)) } as any);
  }

  @Get("setup/security/challenges")
  async listSetupSecurityChallenges() {
    return listPairingChallenges();
  }

  @Get("setup/security/sessions")
  async listSetupSecuritySessions() {
    return listSecuritySessions();
  }

  @Get("setup/security/challenges/:challengeId")
  async setupSecurityChallengeStatus(@Param("challengeId") challengeId: string) {
    return { ok: true, challenge: await getPairingChallenge(challengeId, { allowApproveCode: false } as any) };
  }

  @Post("setup/security/challenges/:challengeId/approve")
  @HttpCode(200)
  async approveSetupSecurityChallenge(@Param("challengeId") challengeId: string) {
    return approvePairingChallenge(challengeId, { approvedBy: "browser" });
  }

  @Post("setup/security/challenges/:challengeId/reject")
  @HttpCode(200)
  async rejectSetupSecurityChallenge(@Param("challengeId") challengeId: string) {
    return rejectPairingChallenge(challengeId, { rejectedBy: "browser" });
  }

  @Delete("setup/security/challenges/:challengeId")
  async deleteSetupSecurityChallenge(@Param("challengeId") challengeId: string) {
    return deletePairingChallenge(challengeId, { deletedBy: "browser" });
  }

  @Post("setup/security/enabled")
  @HttpCode(200)
  async setSetupSecurityEnabled(@Body() body: Record<string, unknown> = {}) {
    return setSecurityPairingEnabled(body.enabled === true, { updatedBy: "browser" });
  }

  @Post("setup/security/sessions/revoke")
  @HttpCode(200)
  async revokeAllSetupSecuritySessions() {
    return revokeAllSecuritySessions({ revokedBy: "browser" });
  }

  @Post("setup/security/sessions/:sessionId/revoke")
  @HttpCode(200)
  async revokeSetupSecuritySession(@Param("sessionId") sessionId: string) {
    return revokeSecuritySession(sessionId, { revokedBy: "browser" });
  }

  @Post("setup/security/pair")
  @HttpCode(200)
  async setupSecurityPair(@Body() body: Record<string, unknown> = {}, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await pairBrowser({
      challengeId: String(body.challengeId || ""),
      userAgent: String(request?.headers?.["user-agent"] || ""),
      ip: String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, ""),
      allowApproveCode: false,
    } as any);
    response.setHeader("set-cookie", sessionCookieHeader(result.token, process.env, {
      requestHost: String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || ""),
    }));
    return {
      ok: true,
      session: result.session,
      redirectPath: result.redirectPath || "",
      security: await securityStatus(),
    };
  }

  @Get("events")
  async events(
    @Req() request: any,
    @Query("limit") limit = "100",
    @Query("user") user = "",
    @Query("resource") resource = "",
    @Query("connector") connector = "",
    @Query("outcome") outcome = "",
  ) {
    return {
      events: await listEventsForPrincipal(requestPrincipal(request), process.env, Number(limit || 100), {
        user,
        resource,
        connector,
        outcome,
      }),
    };
  }

  @Get("events/archives")
  async eventArchives(@Req() request: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("admin_required", 403);
    return {
      storage: await eventStorageStatus(process.env),
      archives: await listEventArchives(process.env),
    };
  }

  @Post("events/rotate")
  @HttpCode(200)
  async rotateEventLog(@Req() request: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("admin_required", 403);
    const rotation = await rotateEvents(process.env, { force: true });
    return {
      ok: true,
      rotation,
      storage: await eventStorageStatus(process.env),
    };
  }

  @Get("events/archives/:name/download")
  async downloadEventArchive(@Param("name") name: string, @Req() request: any, @Res() response: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("admin_required", 403);
    try {
      const archive = await eventArchiveDownloadPath(name, process.env);
      response.setHeader("content-type", archive.name.endsWith(".gz") ? "application/gzip" : "application/x-ndjson");
      response.setHeader("content-length", String(archive.stat.size));
      response.setHeader("content-disposition", `attachment; filename="${contentDispositionFilename(archive.name)}"`);
      return createReadStream(archive.path).pipe(response);
    } catch (error: any) {
      const message = String(error?.message || error || "event_archive_error");
      if (message === "event_archive_not_found") throw httpError(message, 404);
      throw httpError(message, 400);
    }
  }

  @Get("system/alerts")
  async watcherAlerts(
    @Req() request: any,
    @Query("limit") limit = "100",
    @Query("severity") severity = "",
    @Query("status") status = "",
    @Query("source") source = "",
  ) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("admin_required", 403);
    return listWatcherAlerts({ limit: Number(limit || 100), severity, status, source }, process.env);
  }

  @Post("system/alerts/:id/action")
  @HttpCode(200)
  async watcherAlertAction(@Param("id") id: string, @Body() body: Record<string, unknown> = {}, @Req() request: any) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("admin_required", 403);
    try {
      return await updateWatcherAlertLifecycle(id, String(body.action || ""), {
        actorUserId: String(principal?.userId || principal?.id || principal?.displayName || "admin"),
        reason: String(body.reason || ""),
      }, process.env);
    } catch (error: any) {
      throw httpError(error?.message || "watcher_alert_action_failed", Number(error?.statusCode || 500));
    }
  }

  @Get("runtime-leases")
  async runtimeLeases() {
    return { leases: await listRuntimeLeases(), budget: { maxLiveThreads: Number(process.env.ORKESTR_MAX_LIVE_THREADS || 20) } };
  }

  @Get("whereiam")
  async whereiam(
    @Req() request: any,
    @Query("cwd") cwd = "",
    @Query("threadId") threadId = "",
    @Query("sessionName") sessionName = "",
    @Query("paneId") paneId = "",
    @Query("apiSessionId") apiSessionId = "",
    @Query("bind") bind = "",
  ) {
    const principal = requestPrincipal(request);
    let payload = await whereAmI({
      cwd: String(cwd || ""),
      threadId: String(threadId || ""),
      sessionName: String(sessionName || ""),
      paneId: String(paneId || ""),
      apiSessionId: String(apiSessionId || ""),
      principal,
    });
    if (String(apiSessionId || "").trim() && ["1", "true", "yes"].includes(String(bind || "").toLowerCase())) {
      if (!payload.thread?.id) throw httpError("api_session_thread_not_resolved", 404);
      await bindApiSessionToThread({
        apiSessionId: String(apiSessionId || ""),
        threadId: payload.thread.id,
        cwd: String(cwd || payload.workspace?.cwd || ""),
        source: "whereiam",
      }, process.env, principal);
      payload = await whereAmI({
        cwd: String(cwd || ""),
        apiSessionId: String(apiSessionId || ""),
        principal,
      });
    }
    return payload;
  }

  @Post("sanitizer/check")
  @HttpCode(200)
  async sanitizerCheck(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const context = await whereAmI({
      cwd: String(body.cwd || ""),
      threadId: String(body.threadId || body.thread || ""),
      apiSessionId: String(body.apiSessionId || ""),
      principal,
    });
    const threadId = String(context.thread?.id || "").trim();
    const fallbackThread = threadId ? null : await resolveTenantSanitizerFallbackThread(principal, process.env);
    if (!threadId && !fallbackThread) throw httpError("sanitizer_thread_not_resolved", 404);
    const thread = fallbackThread || await getThread(threadId, process.env);
    if (!thread) throw httpError("sanitizer_thread_not_found", 404);
    const ownerUserId = String(thread.ownerUserId || context.tenancy?.ownerUserId || principal?.userId || "").trim();
    const capabilities = await userScopedCapabilityHints({ userId: ownerUserId, thread }, process.env);
    const rawInput = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
    const input = sanitizedThreadActionInput({
      ...rawInput,
      text: body.text ?? rawInput.text,
      reason: body.reason ?? rawInput.reason,
      url: body.url ?? rawInput.url,
      href: body.href ?? rawInput.href,
      domain: body.domain ?? rawInput.domain,
      source: body.source ?? rawInput.source ?? "orkestr-sanitizer-cli",
    });
    const actor = {
      kind: String(principal?.kind || "user"),
      userId: String(principal?.userId || "").trim(),
      role: isAdminPrincipal(principal) ? "admin" : "user",
      source: String(principal?.source || "").trim(),
      displayName: String(principal?.displayName || "").trim(),
    };
    const requestPayload = {
      action: String(body.action || "external.action").trim().slice(0, 160) || "external.action",
      actor,
      principal: {
        kind: "user",
        userId: ownerUserId,
        role: "user",
        source: "thread-owner",
      },
      resource: {
        type: "thread",
        id: thread.id,
        ownerUserId,
        state: thread.state || "",
        parentThreadId: thread.parentThreadId || null,
        rootThreadId: thread.rootThreadId || null,
        capabilities,
      },
      input,
    };
    try {
      const decision = await assertSanitizedAction(requestPayload, process.env);
      return { ok: true, allow: true, decision, thread: { id: thread.id, name: thread.name || "", ownerUserId } };
    } catch (error: any) {
      if (error?.sanitizer) {
        return { ok: false, allow: false, decision: error.sanitizer, thread: { id: thread.id, name: thread.name || "", ownerUserId } };
      }
      throw httpError(error?.message || "sanitizer_check_failed", Number(error?.statusCode || 500));
    }
  }

  @Post("session-bindings")
  @HttpCode(200)
  async bindApiSession(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    let threadId = String(body.threadId || body.orkestrThreadId || "").trim();
    if (!threadId) {
      const payload = await whereAmI({
        cwd: String(body.cwd || ""),
        sessionName: String(body.sessionName || ""),
        paneId: String(body.paneId || ""),
        principal,
      });
      threadId = String(payload.thread?.id || "").trim();
    }
    if (!threadId) throw httpError("api_session_thread_not_resolved", 404);
    const result = await bindApiSessionToThread({
      apiSessionId: String(body.apiSessionId || body.sessionId || ""),
      threadId,
      cwd: String(body.cwd || ""),
      source: String(body.source || "api-session"),
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    }, process.env, principal);
    return { ok: true, binding: result.binding, thread: { id: result.thread.id, name: result.thread.name || null } };
  }

  @Get("session-bindings/:apiSessionId")
  async apiSessionBinding(@Req() request: any, @Param("apiSessionId") apiSessionId: string) {
    const binding = await getApiSessionBindingForPrincipal(apiSessionId, requestPrincipal(request), process.env);
    if (!binding) throw httpError("api_session_not_bound", 404);
    return { ok: true, binding };
  }

  @Post("session-bindings/:apiSessionId/messages")
  @HttpCode(200)
  async appendApiSessionBoundMessage(
    @Req() request: any,
    @Param("apiSessionId") apiSessionId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const result = await appendApiSessionMessage({
      ...body,
      apiSessionId,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    }, process.env, requestPrincipal(request));
    let delivery = null;
    let deliveryState: any = null;
    if (result.deliveryExpected) {
      try {
        delivery = await deliverWhatsAppRepliesForApiSession(process.env);
      } catch (error) {
        if (String(error instanceof Error ? error.message : error).startsWith("whatsapp_delivery_timeout:")) {
          throwApiSessionDeliveryTimeout({ ...result.message, threadId: result.thread.id }, apiSessionDeliveryTimeoutMs(process.env));
        }
        throw error;
      }
      deliveryState = await apiSessionConfirmedDeliveryResultForMessage(delivery, result.message.id, process.env);
      if (!deliveryState.ok) throwApiSessionDeliveryError(deliveryState, { ...result.message, threadId: result.thread.id }, delivery);
    }
    return {
      ok: true,
      binding: result.binding,
      thread: { id: result.thread.id, name: result.thread.name || null },
      message: result.message,
      deliveryExpected: result.deliveryExpected,
      deliveryState,
      delivery,
    };
  }

  @Get("system")
  async system() {
    return systemSnapshot();
  }

  @Get("system/summary")
  async systemSummary() {
    return systemSnapshot();
  }

  @Get("system/doctor")
  async systemDoctor() {
    return systemDoctor();
  }

  @Get("system/resources")
  async systemResources(@Query("repair") repair = "") {
    return doctorRuntimeResources({ repair: ["1", "true", "yes"].includes(String(repair || "").toLowerCase()) });
  }

  @Post("system/resources/repair")
  @HttpCode(200)
  async repairSystemResources() {
    return doctorRuntimeResources({ repair: true });
  }

  @Get("system/processes")
  async systemProcesses(@Query("sort") sort = "cpu") {
    return processRows(String(sort || "cpu"));
  }

  @Get("system/workspace-folders")
  async workspaceFolders(@Req() request: any, @Query("path") currentPath = "") {
    return listWorkspaceFoldersForPrincipal(String(currentPath || ""), requestPrincipal(request), process.env);
  }

  @Get("files")
  async files(@Req() request: any, @Query("path") currentPath = "") {
    return listFilesForPrincipal(String(currentPath || ""), requestPrincipal(request), process.env);
  }

  @Post("files/folders")
  @HttpCode(200)
  async createFolder(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createFolderForPrincipal(
      String(body.path || body.currentPath || ""),
      String(body.name || body.folderName || ""),
      requestPrincipal(request),
      process.env,
    );
  }

  @Post("files/uploads")
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 20 } }))
  async uploadFiles(@Req() request: any, @UploadedFiles() uploadedFiles: any[] = [], @Body() body: Record<string, unknown> = {}) {
    return saveFilesForPrincipal(
      String(body.path || body.currentPath || ""),
      uploadedFiles,
      requestPrincipal(request),
      process.env,
    );
  }

  @Delete("files")
  async deleteFile(@Req() request: any, @Query("path") currentPath = "") {
    return deleteFileForPrincipal(String(currentPath || ""), requestPrincipal(request), process.env);
  }

  @Get("system/files")
  async systemFiles(@Req() request: any, @Query("path") currentPath = "") {
    return listFilesForPrincipal(String(currentPath || ""), requestPrincipal(request), process.env);
  }

  private async dataDirReady() {
    const paths = await ensureDataDirs();
    const probe = path.join(paths.home, ".ready-check");
    await fs.writeFile(probe, new Date().toISOString());
    await fs.unlink(probe).catch(() => {});
    return paths.home;
  }
}

@Controller("api/models")
export class ModelsController {
  @Get("status")
  status() {
    return {
      generatedAt: new Date().toISOString(),
      codex: {
        model: process.env.ORKESTR_DEFAULT_CODEX_MODEL || process.env.OPENAI_MODEL || null,
        reasoningEffort: process.env.ORKESTR_DEFAULT_CODEX_REASONING || null,
      },
      ollama: {
        ok: false,
        baseUrl: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
        models: [],
        note: "local model discovery is overlay-provided in OSS v1",
      },
      external: {
        configured: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        defaultModel: process.env.OPENAI_MODEL || null,
      },
    };
  }

  @Post("run")
  @HttpCode(501)
  run(@Body() _body: Record<string, unknown> = {}) {
    return {
      ok: false,
      error: "model_runner_not_configured",
      message: "The generic OSS build exposes model status; model execution should be provided by an overlay adapter.",
    };
  }
}
