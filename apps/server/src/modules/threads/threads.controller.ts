import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import {
  completeCodexModeCommand,
  deliverPendingThreadInputs,
  hardResetThreadRuntime,
  implementRuntimePlan,
  requestThreadInputDelivery,
  requestThreadWake,
  resetThreadRuntime,
  safeResetThreadRuntime,
  sleepThread,
  syncRuntimeWindowName,
  takeoverRawTerminalThread,
  wakeThread,
} from "../../../../../packages/core/src/runtime-leases.js";
import { deleteTimerForPrincipal, listTimersForPrincipal } from "../../../../../packages/core/src/timers.js";
import {
  appendThreadMessage,
  createThreadForPrincipal,
  deleteThreadForPrincipal,
  enqueueThreadInputForPrincipal,
  getThread,
  listThreadMessages,
} from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { parseThreadInputCommand } from "../../../../../packages/core/src/thread-commands.js";
import { launchNativeTerminal } from "../../../../../packages/core/src/native-terminal.js";
import {
  rawAttachPollIntervalMs,
  rawAttachTimeoutMs,
  rawAttachWatchPayload,
  rawAttachWatchText,
  rawStructuredTurnActive,
} from "../../../../../packages/core/src/raw-terminal-watch.js";
import {
  API_AGENT_RUNTIME_KIND,
  defaultTenantThreadRuntime,
  processApiAgentThreadInput,
  threadUsesApiAgent,
} from "../../../../../packages/core/src/tenant-api-agent.js";
import { resolveWorkspacePathForPrincipal, workspacePrincipalForOwner, workspaceRootForPrincipal } from "../../../../../packages/core/src/workspace-files.js";
import {
  archiveCodexAppServerThread,
  answerCodexAppServerPendingRequest,
  interruptCodexAppServerThread,
  startCodexAppServerThread,
  threadNeedsCodexAppServerMigration,
  threadUsesCodexAppServer,
} from "../../../../../packages/core/src/codex-app-server.js";
import { codexThreadId, threadRuntimeSummary, threadSummaryPayload } from "../../thread-summary.js";
import { ensureAttachmentsArray, httpError, validateRequestSchema } from "../../common/http.js";
import {
  threadApproveSchema,
  threadCreateSchema,
  threadInputSchema,
  threadInterruptSchema,
} from "../../../../../packages/shared/src/api-schemas.js";
import {
  ThreadActionSanitizerService,
  ThreadRuntimeService,
} from "./thread-application.services.js";
import {
  assertThreadAdminOnly,
  optionalBodyBoolean,
  optionalBodyString,
} from "./thread-route-helpers.js";

const execFileAsync = promisify(execFile);

function shouldInterruptRuntime(status: Record<string, any> | null | undefined): boolean {
  if (!status) return false;
  return Boolean(
    status.working ||
    status.foregroundWorking ||
    status.backgroundWork ||
    status.typingActive ||
    Number(status.runningCount || 0) > 0,
  );
}

function queuedInputResponse(thread: Record<string, any>, message: Record<string, any>, reason = "pending_delivery") {
  const state = String(message.state || "queued");
  const queued = ["queued", "pending_delivery", "awaiting_ack", "running"].includes(state);
  return {
    ok: true,
    threadId: codexThreadId(thread) || thread.id,
    orkestrThreadId: thread.id,
    message,
    queued,
    queueItemId: message.id,
    delivered: [],
    deliveryState: message.deliveryState || message.state || "queued",
    reason,
    state,
    observed: true,
    observedVia: message.observedVia || "pending_delivery",
  };
}

function threadInputNeedsDelivery(message: Record<string, any>) {
  return ["queued", "pending_delivery", "awaiting_ack", "running"].includes(String(message.state || ""));
}

function attachNumberMs(body: Record<string, unknown> = {}, key: string, secondsKey = "") {
  const value = Number(body[key]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  const seconds = Number(secondsKey ? body[secondsKey] : null);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
  return undefined;
}

function attachBoolean(body: Record<string, unknown> = {}, key: string): boolean {
  const value = body && typeof body === "object" ? body[key] : undefined;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return value === true;
}

async function attachWatchResponse(thread: Record<string, any>, status: Record<string, any> = {}, body: Record<string, unknown> = {}) {
  const messages = await listThreadMessages(thread.id).catch(() => []);
  const readOnly = body.readOnly === true || String(body.readOnly || "").toLowerCase() === "true";
  const takeoverAvailable = body.takeoverAvailable === true || String(body.takeoverAvailable || "").toLowerCase() === "true";
  const active = rawStructuredTurnActive(thread, status);
  const intervalMs = rawAttachPollIntervalMs({
    intervalMs: attachNumberMs(body, "intervalMs", "interval"),
  });
  const timeoutMs = rawAttachTimeoutMs({
    timeoutMs: attachNumberMs(body, "timeoutMs", "timeout"),
  });
  const watch = rawAttachWatchPayload({
    thread,
    status,
    messages,
    startedAtMs: Number(body.watchStartedAtMs || 0) || Date.now(),
    intervalMs,
    timeoutMs,
  });
  const watchText = `${rawAttachWatchText(watch)}${takeoverAvailable ? "Structured runtime is idle. Run `orkestr attach <thread> --takeover` or use Raw takeover to enter terminal mode.\n" : ""}`;
  return {
    ok: true,
    attachable: false,
    watchOnly: true,
    takeoverAvailable,
    state: "watching",
    thread,
    runtime: status,
    watch,
    watchText,
    message: active
      ? "Structured runtime is active; attach is in watch-and-wait mode."
      : readOnly
        ? "Read-only raw attach is in watch-and-wait mode."
        : takeoverAvailable
          ? "Structured runtime is idle; terminal takeover requires explicit confirmation."
          : "Raw attach is in watch-and-wait mode.",
  };
}

function includeAllUserThreadsQuery(query: Record<string, unknown> = {}): boolean {
  const scope = String(query.scope || query.threadScope || "").trim().toLowerCase();
  if (["all", "all-users", "all_users", "admin-all"].includes(scope)) return true;
  return optionalBodyBoolean(query, "includeAllUsers", false) ||
    optionalBodyBoolean(query, "allUsers", false) ||
    optionalBodyBoolean(query, "includeAllUserThreads", false);
}

function safeCloneSegment(value: string): string {
  const withoutGitSuffix = value.replace(/\.git$/i, "");
  const tail = withoutGitSuffix.split(/[/:]/).filter(Boolean).at(-1) || "repo";
  return safeWorkspaceSegment(tail) || "repo";
}

function safeWorkspaceSegment(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "workspace";
}

function generatedWorkspaceName(body: Record<string, unknown>, remoteUrl = ""): string {
  const requestedId = optionalBodyString(body, "id", body["threadId"]);
  const name = optionalBodyString(body, "name", optionalBodyString(body, "title"));
  const remoteSegment = remoteUrl ? safeCloneSegment(remoteUrl) : "";
  const base = safeWorkspaceSegment(requestedId || name || remoteSegment || "agent");
  return requestedId ? base : `${base}-${randomUUID().slice(0, 8)}`;
}

function validGitRemote(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(value);
}

function safeWorkFolder(value: string): string {
  const folder = String(value || "").trim().replace(/^[/\\]+/, "");
  if (!folder) return "";
  const normalized = path.normalize(folder);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw httpError("invalid_work_folder", 400);
  }
  return normalized;
}

function workspaceWithWorkFolder(root: string, workFolder: string): string {
  const folder = safeWorkFolder(workFolder);
  return folder ? path.join(root, folder) : root;
}

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function availableWorkspacePath(root: string, folderName: string): Promise<string> {
  const base = safeWorkspaceSegment(folderName);
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(root, index === 0 ? base : `${base}-${index + 1}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  return path.join(root, `${base}-${randomUUID().slice(0, 8)}`);
}

async function ensureLocalGitRepo(repoRoot: string): Promise<boolean> {
  await fs.mkdir(repoRoot, { recursive: true });
  if (await pathExists(path.join(repoRoot, ".git"))) return false;
  try {
    await execFileAsync("git", ["init"], { cwd: repoRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  } catch {
    throw httpError("git_init_failed", 500);
  }
  return true;
}

async function prepareThreadCreateBody(body: Record<string, unknown> = {}, principal: any = null): Promise<Record<string, unknown>> {
  const effectivePrincipal = principal || requestPrincipal(null);
  const ownerHint = optionalBodyString(body, "ownerUserId", body["userId"]);
  const workspacePrincipal = workspacePrincipalForOwner(effectivePrincipal, ownerHint, process.env);
  const cloneRoot = await workspaceRootForPrincipal(workspacePrincipal, process.env);
  const workFolder = optionalBodyString(body, "workFolder", optionalBodyString(body, "workdirRelativePath", body["workdir"]));
  if (!optionalBodyBoolean(body, "cloneRepo", false)) {
    const requestedRepo = optionalBodyString(body, "repoPath");
    const requestedWorkspace = optionalBodyString(body, "workspace");
    const requestedCwd = optionalBodyString(body, "cwd");
    const requestedRoot = requestedRepo || requestedWorkspace || requestedCwd;
    const generatedWorkspace = !requestedRoot;
    const repoRoot = generatedWorkspace
      ? await availableWorkspacePath(cloneRoot, generatedWorkspaceName(body))
      : await resolveWorkspacePathForPrincipal(requestedRoot, workspacePrincipal, process.env, cloneRoot);
    const cwdRoot = requestedRepo || requestedWorkspace ? repoRoot : cloneRoot;
    const initGit = optionalBodyBoolean(body, "initGit", generatedWorkspace || optionalBodyBoolean(body, "autoWorkspace", false));
    const localGitInitialized = initGit ? await ensureLocalGitRepo(repoRoot) : false;
    const cwd = workFolder
      ? await resolveWorkspacePathForPrincipal(workspaceWithWorkFolder(repoRoot, workFolder), workspacePrincipal, process.env, cloneRoot)
      : await resolveWorkspacePathForPrincipal(requestedCwd || repoRoot, workspacePrincipal, process.env, cwdRoot);
    if (generatedWorkspace || initGit || workFolder) await fs.mkdir(cwd, { recursive: true });
    return {
      ...body,
      workspace: repoRoot,
      repoPath: repoRoot,
      cwd,
      workFolder: safeWorkFolder(workFolder) || null,
      workspaceGenerated: generatedWorkspace,
      workspaceFolderName: path.basename(repoRoot),
      workspaceSource: generatedWorkspace ? "local" : "existing",
      localGitInitialized,
    };
  }
  const remoteUrl = optionalBodyString(body, "repoRemoteUrl", optionalBodyString(body, "remoteUrl", body["gitRemoteUrl"]));
  if (!remoteUrl) throw httpError("repo_url_required", 400);
  if (!validGitRemote(remoteUrl)) throw httpError("invalid_repo_url", 400);

  const configuredRoot = String(process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT || "").trim();
  const requestedTarget = optionalBodyString(body, "workspace", optionalBodyString(body, "cwd", body["repoPath"]));
  const generatedWorkspace = !requestedTarget;
  const target = requestedTarget
    ? await resolveWorkspacePathForPrincipal(requestedTarget, workspacePrincipal, process.env, cloneRoot)
    : await availableWorkspacePath(cloneRoot, generatedWorkspaceName(body, remoteUrl));
  if (configuredRoot && !pathInside(cloneRoot, target)) throw httpError("clone_target_outside_workspace_root", 400);

  let shouldClone = false;
  if (await pathExists(target)) {
    if (!(await pathExists(path.join(target, ".git")))) {
      const entries = await fs.readdir(target).catch(() => []);
      if (entries.length > 0) throw httpError("clone_target_not_empty", 409);
      shouldClone = true;
    }
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    shouldClone = true;
  }
  if (shouldClone) {
    try {
      await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, target], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    } catch {
      throw httpError("repo_clone_failed", 400);
    }
  }

  return {
    ...body,
    workspace: target,
    cwd: workspaceWithWorkFolder(target, workFolder),
    repoPath: target,
    repoRemoteUrl: remoteUrl,
    workFolder: safeWorkFolder(workFolder) || null,
    workspaceGenerated: generatedWorkspace,
    workspaceFolderName: path.basename(target),
    workspaceSource: "cloned",
    localGitInitialized: false,
  };
}

@Controller("api/threads")
export class ThreadsController {
  constructor(
    private readonly threadActionSanitizer: ThreadActionSanitizerService,
    private readonly threadRuntimeService: ThreadRuntimeService,
  ) {}

  private async assertThreadSanitized(action: string, principal: any, thread: any, input: Record<string, unknown> = {}) {
    return this.threadActionSanitizer.assertAllowed(action, principal, thread, input);
  }

  private assertThreadAdminOnly(action: string, principal: any) {
    assertThreadAdminOnly(action, principal);
  }

  private async applyOrQueueCodexModeCommand(thread: any, mode: "code" | "plan", source = "codex_mode_command") {
    const message = await appendThreadMessage(thread.id, {
      role: "user",
      source,
      text: `/${mode}`,
      state: "queued",
      deliveryState: "codex_mode_command",
    });
    return completeCodexModeCommand(thread, message, mode);
  }

  @Get()
  async list(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    return threadSummaryPayload({
      principal: requestPrincipal(request),
      includeAllUserThreads: includeAllUserThreadsQuery(query),
    });
  }

  @Get("summary")
  async summary(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    return this.list(request, query);
  }

  @Post()
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadCreateSchema, { body });
    const principal = requestPrincipal(request);
    await this.assertThreadSanitized("thread.create", principal, {
      id: "",
      ownerUserId: isAdminPrincipal(principal) ? String(body.ownerUserId || body.userId || "") : principal?.userId || "",
      state: "pending_create",
    }, body);
    const prepared = await prepareThreadCreateBody(body, principal);
    const preparedExecutor = typeof prepared.executor === "object" && prepared.executor ? prepared.executor as Record<string, unknown> : {};
    const requestedExecutorId = String(prepared.executorId || preparedExecutor.id || preparedExecutor.type || "codex").trim() || "codex";
    const defaultRuntime = defaultTenantThreadRuntime(prepared, principal, process.env);
    const usesApiAgentRuntime = String(prepared.runtimeKind || defaultRuntime || "").trim() === API_AGENT_RUNTIME_KIND;
    const usesCodexRuntime = !usesApiAgentRuntime && (requestedExecutorId === "codex" || String(preparedExecutor.type || "").trim() === "codex");
    let thread = await createThreadForPrincipal({
      wakePolicy: "wake-on-message",
      ...(usesCodexRuntime ? {
        executorId: "codex",
        executor: { type: "codex", ...preparedExecutor },
        runtimeKind: "codex-app-server",
      } : usesApiAgentRuntime ? {
        executorId: API_AGENT_RUNTIME_KIND,
        executor: {
          type: API_AGENT_RUNTIME_KIND,
          ...preparedExecutor,
          metadata: { ...(preparedExecutor as any).metadata, runtimeKind: API_AGENT_RUNTIME_KIND },
        },
        runtimeKind: API_AGENT_RUNTIME_KIND,
      } : {}),
      ...prepared,
    }, principal);
    if (usesCodexRuntime && !codexThreadId(thread)) {
      const started = await startCodexAppServerThread(thread);
      if (started?.thread) thread = started.thread;
    }
    if (body.wake === true || body.start === true) {
      requestThreadWake(thread.id, { reason: body.reason || "thread_created" });
    }
    return { thread };
  }

  @Post(":threadId/input")
  @HttpCode(202)
  async input(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadInputSchema, { params: { threadId }, body });
    ensureAttachmentsArray(body);
    const principal = requestPrincipal(request);
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const parsedCommand = body.parseCommands === true || body.controlAllowed === true || body.originOwner === true
      ? parseThreadInputCommand(body)
      : { command: null, text: String(body.text || "") };
    if (parsedCommand.command === "interrupt") {
      return this.interrupt(request, thread.id, {
        ...body,
        text: parsedCommand.text,
        source: body.source || "interrupt",
        parsedCommand: parsedCommand.rawCommand || parsedCommand.command,
      });
    }
    if (parsedCommand.command === "stop") {
      await this.assertThreadSanitized("thread.stop", principal, thread, body);
      const appServer = threadUsesCodexAppServer(thread);
      const result = appServer
        ? { thread, slept: 0, interrupted: await interruptCodexAppServerThread(thread).catch(() => ({ interrupted: false })) }
        : await sleepThread(thread.id, { reason: "stop_command", kill: true });
      const message = await appendThreadMessage(thread.id, {
        role: "user",
        source: body.source || "stop_command",
        text: "/stop",
        state: "completed",
        deliveryState: "delivered",
        observedVia: "orkestr_stop_command",
        interruptSent: Boolean((result as any).interrupted?.interrupted),
        deliveredAt: new Date().toISOString(),
      });
      return {
        ok: true,
        stopped: true,
        interrupted: Boolean((result as any).interrupted?.interrupted),
        slept: result.slept,
        threadId: codexThreadId((result as any).thread || thread) || thread.id,
        orkestrThreadId: thread.id,
        message,
        thread: await threadRuntimeSummary(result.thread, await listThreadMessages(thread.id)),
      };
    }
    if (parsedCommand.command === "reset" || parsedCommand.command === "hard_reset" || parsedCommand.command === "safe_reset") {
      await this.assertThreadSanitized(parsedCommand.command === "hard_reset" ? "thread.hard-reset" : parsedCommand.command === "safe_reset" ? "thread.safe-reset" : "thread.reset", principal, thread, body);
      const hard = parsedCommand.command === "hard_reset";
      const safe = parsedCommand.command === "safe_reset";
      const result = safe
        ? await safeResetThreadRuntime(thread.id, { reason: body.source === "whatsapp" ? "whatsapp_safe_reset_command" : "safe_reset_command" })
        : hard
        ? await hardResetThreadRuntime(thread.id, { reason: body.source === "whatsapp" ? "whatsapp_hard_reset_command" : "hard_reset_command" })
        : await resetThreadRuntime(thread.id, { reason: body.source === "whatsapp" ? "whatsapp_reset_command" : "reset_command" });
      const message = await appendThreadMessage(thread.id, {
        role: "user",
        source: body.source || (safe ? "safe_reset_command" : hard ? "hard_reset_command" : "reset_command"),
        text: safe ? "/safe_reset" : hard ? "/hard_reset" : "/reset",
        state: "completed",
        deliveryState: "delivered",
        observedVia: safe ? "orkestr_safe_reset_command" : hard ? "orkestr_hard_reset_command" : "orkestr_reset_command",
        deliveredAt: new Date().toISOString(),
        resetSlept: (result as any).slept ?? null,
        compactionMethod: hard
          ? ((result as any).compaction?.compacted
            ? (result as any).compaction?.method
            : (result as any).manualCheckpoint?.method || (result as any).compaction?.method || null)
          : null,
        manualCheckpointPath: hard || safe ? (result as any).manualCheckpoint?.path || null : null,
        oldCodexThreadId: safe ? (result as any).oldCodexThreadId || null : null,
        newCodexThreadId: safe ? (result as any).newCodexThreadId || null : null,
      });
      return {
        ok: true,
        reset: true,
        hardReset: hard,
        safeReset: safe,
        slept: (result as any).slept ?? null,
        compaction: hard ? (result as any).compaction || null : null,
        manualCheckpoint: hard || safe ? (result as any).manualCheckpoint || null : null,
        oldCodexThreadId: safe ? (result as any).oldCodexThreadId || null : null,
        newCodexThreadId: safe ? (result as any).newCodexThreadId || null : null,
        threadId: codexThreadId((result as any).thread || thread) || thread.id,
        orkestrThreadId: thread.id,
        message,
        thread: await threadRuntimeSummary((result as any).thread || thread, await listThreadMessages(thread.id)),
      };
    }
    if (parsedCommand.command === "plan" || parsedCommand.command === "code") {
      const mode = parsedCommand.command;
      const text = String(parsedCommand.text || "").trim();
      await this.assertThreadSanitized("thread.codex-mode", principal, thread, { ...body, mode });
      const modeResult: any = await this.applyOrQueueCodexModeCommand(thread, mode as "code" | "plan", String(body.source || "codex_mode_command"));
      let payloadMessage: any = null;
      if (text && !modeResult.failed) {
        payloadMessage = await enqueueThreadInputForPrincipal(thread.id, {
          ...body,
          text,
          source: body.source || "mode_command_payload",
          parentMessageId: modeResult.message?.id || null,
        }, principal);
        requestThreadInputDelivery(thread.id);
      }
      if (!text) {
        return {
          ok: Boolean(modeResult.applied || modeResult.deferred),
          commandHandled: true,
          mode,
          applied: Boolean(modeResult.applied),
          message: modeResult.message,
          queued: Boolean(modeResult.deferred),
          deliveryState: modeResult.message?.deliveryState || modeResult.message?.state || null,
          observed: true,
          observedVia: modeResult.message?.observedVia,
          replyText: modeResult.applied
            ? `Codex ${mode} mode requested.`
            : modeResult.deferred
              ? `Mode switch queued. Orkestr will switch to ${mode} when Codex is ready.`
              : `Could not switch Codex mode: ${modeResult.message?.error || "Codex mode could not be applied."}`,
          runtimeMode: modeResult.runtimeMode,
          thread: await threadRuntimeSummary(await getThread(thread.id) || thread, await listThreadMessages(thread.id)),
        };
      }
      return {
        ok: Boolean(modeResult.applied || modeResult.deferred),
        commandHandled: true,
        mode,
        applied: Boolean(modeResult.applied),
        queued: Boolean(modeResult.deferred || payloadMessage),
        message: payloadMessage,
        commandMessage: modeResult.message,
        deliveryState: modeResult.message?.deliveryState || modeResult.message?.state || null,
        runtimeMode: modeResult.runtimeMode,
        thread: await threadRuntimeSummary(await getThread(thread.id) || thread, await listThreadMessages(thread.id)),
      };
    }
    if (parsedCommand.command === "implement") {
      await this.assertThreadSanitized("thread.implement", principal, thread, body);
      const result = await implementRuntimePlan(thread.id);
      const implemented = Boolean(result.implemented);
      const errorText = implemented ? "" : "No active Codex implementation prompt is visible.";
      const message = await appendThreadMessage(thread.id, {
        role: "user",
        source: body.source || "implement_command",
        text: "/implement",
        state: implemented ? "completed" : "failed",
        deliveryState: implemented ? "delivered" : "failed",
        observedVia: implemented ? "codex_plan_implementation_confirmed" : "codex_plan_implementation_not_ready",
        runtimeLeaseId: (result.status as any)?.lease?.id || null,
        deliveredAt: implemented ? new Date().toISOString() : "",
        error: errorText,
      });
      const updatedThread = await getThread(thread.id);
      const updatedMessages = await listThreadMessages(thread.id);
      return {
        ok: implemented,
        implemented,
        reason: result.reason,
        threadId: codexThreadId(thread) || thread.id,
        orkestrThreadId: thread.id,
        message,
        queued: false,
        observed: true,
        observedVia: message.observedVia,
        runtime: result.status || null,
        thread: await threadRuntimeSummary(updatedThread || thread, updatedMessages),
      };
    }
    const message = await enqueueThreadInputForPrincipal(thread.id, body, principal);
    if (threadUsesApiAgent(thread)) {
      if (body.autoRun === false) {
        return { ...queuedInputResponse(thread, message, "auto_run_disabled"), threadId: thread.id, observedVia: message.observedVia || "auto_run_disabled" };
      }
      const processed: any = await processApiAgentThreadInput(thread.id);
      await deliverWhatsAppReplies().catch(() => {});
      const current = (await listThreadMessages(thread.id)).find((item: any) => item.id === message.id) || message;
      return {
        ok: processed?.ok !== false,
        threadId: thread.id,
        orkestrThreadId: thread.id,
        message: current,
        assistant: processed?.assistant || null,
        queued: false,
        deliveryState: current.deliveryState || current.state,
        observed: true,
        observedVia: current.observedVia || "api_agent_response",
      };
    }
    if (body.autoRun === false) {
      return queuedInputResponse(thread, message, "auto_run_disabled");
    }
    if (threadInputNeedsDelivery(message)) requestThreadInputDelivery(thread.id);
    return queuedInputResponse(thread, message, message.duplicate ? message.duplicateReason || "duplicate_input" : "pending_delivery");
  }

  @Post(":threadId/attach")
  @HttpCode(200)
  async attach(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    this.assertThreadAdminOnly("thread.attach", requestPrincipal(request));
    let thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const readOnly = attachBoolean(body, "readOnly");
    const takeover = attachBoolean(body, "takeover");
    const interrupt = attachBoolean(body, "interrupt");
    const yes = attachBoolean(body, "yes");
    if (threadUsesCodexAppServer(thread)) {
      const currentStatus: any = await this.threadRuntimeService.status(thread.id).catch(() => null);
      const activeStructuredTurn = currentStatus && rawStructuredTurnActive(thread, currentStatus);
      if (readOnly || (activeStructuredTurn && !interrupt)) {
        return attachWatchResponse(thread, currentStatus || {}, body);
      }
      if (activeStructuredTurn && interrupt && !yes) {
        return {
          ok: false,
          attachable: false,
          confirmationRequired: true,
          thread,
          runtime: currentStatus,
          message: "Interrupting an active structured turn before raw terminal takeover requires --yes.",
        };
      }
      if (!takeover && !interrupt) {
        return attachWatchResponse(thread, currentStatus || {}, {
          ...body,
          takeoverAvailable: true,
        });
      }
      if (activeStructuredTurn && interrupt) {
        await interruptCodexAppServerThread(thread).catch(() => null);
      }
      const wakeResult = await takeoverRawTerminalThread(thread.id, { reason: interrupt ? "raw_interrupt_takeover" : "raw_takeover" }).catch((error: Error) => ({
        error: error.message,
        thread,
        status: null,
      }));
      if ((wakeResult as any).error) {
        return {
          ok: false,
          thread,
          runtime: await this.threadRuntimeService.status(thread.id).catch(() => null),
          message: (wakeResult as any).error || "Codex app-server attach failed.",
        };
      }
      thread = (wakeResult as any).thread || thread;
      const runtime = (wakeResult as any).status || await this.threadRuntimeService.status(thread.id).catch(() => null);
      return {
        ok: true,
        state: "ready",
        thread,
        runtime,
        woke: (wakeResult as any).reused !== true,
        attachKind: "raw-terminal",
        attachCommand: `tmux attach-session -t ${runtime?.sessionName || (wakeResult as any).lease?.sessionName}`,
      };
    }
    if (threadNeedsCodexAppServerMigration(thread)) {
      return {
        ok: false,
        thread,
        runtime: await this.threadRuntimeService.status(thread.id).catch(() => null),
        message: "Run `orkestr codex migrate` on this host before opening this Codex thread.",
      };
    }
    let status: any = await this.threadRuntimeService.status(thread.id);
    let wakeResult: Awaited<ReturnType<typeof wakeThread>> | null = null;
    if (readOnly && !status.sessionName) {
      return attachWatchResponse(thread, status || {}, body);
    }
    if (!status.sessionName || status.state === "sleeping") {
      wakeResult = await wakeThread(thread.id, { reason: "attach" });
      if (!wakeResult) throw httpError("thread_wake_failed", 500);
      thread = wakeResult.thread || thread;
      status = wakeResult.status || await this.threadRuntimeService.status(thread.id);
      if (!status.sessionName && wakeResult.lease?.sessionName) {
        status = { ...status, sessionName: wakeResult.lease.sessionName };
      }
    }
    if (!status.sessionName) {
      return {
        ok: false,
        state: status.state,
        thread,
        message: `Thread is ${status.state}; Orkestr could not start an attachable runtime.`,
      };
    }
    const window = await syncRuntimeWindowName(thread.id).catch(() => null);
    const runtime = window
      ? {
          ...status,
          windowName: window.windowName,
          lease: status.lease ? { ...status.lease, windowName: window.windowName } : status.lease,
        }
      : status;
    return {
      ok: true,
      state: runtime.state,
      thread,
      runtime,
      woke: wakeResult ? wakeResult.reused !== true : false,
      attachCommand: `tmux attach-session -t ${runtime.sessionName}`,
    };
  }

  @Post(":threadId/attach/open-terminal")
  @HttpCode(200)
  async openAttachTerminal(@Req() request: any, @Param("threadId") threadId: string) {
    this.assertThreadAdminOnly("thread.attach.open-terminal", requestPrincipal(request));
    const attach: any = await this.attach(request, threadId);
    if (!attach?.ok || !attach.attachCommand) {
      return {
        ...attach,
        ok: false,
        launched: false,
        message: attach?.message || "No attach command is available for this thread.",
      };
    }

    const thread = attach.thread || (await getThread(threadId)) || {};
    const cwd = String(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath || "");
    const title = `Orkestr: ${thread.name || thread.title || thread.id || threadId}`;
    try {
      const terminal = await launchNativeTerminal(String(attach.attachCommand), { cwd, title });
      return {
        ...attach,
        ok: true,
        launched: true,
        terminal,
      };
    } catch (error: any) {
      return {
        ...attach,
        ok: true,
        launched: false,
        message: error?.message || "Could not open a native terminal on this host.",
      };
    }
  }

  @Post(":threadId/interrupt")
  @HttpCode(200)
  async interrupt(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadInterruptSchema, { params: { threadId }, body });
    const principal = requestPrincipal(request);
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.interrupt", principal, thread, body);
    if (threadUsesCodexAppServer(thread)) {
      const interrupted = await interruptCodexAppServerThread(thread).catch(() => ({ interrupted: false }));
      if (String(body.text || "").trim()) {
        const message = await enqueueThreadInputForPrincipal(thread.id, {
          ...body,
          source: body.source || "interrupt",
          forceDeliveryAfterInterrupt: true,
        }, principal);
        const delivered = await deliverPendingThreadInputs(thread.id);
        const current = (await listThreadMessages(thread.id)).find((item: any) => item.id === message.id) || message;
        if (current.state === "queued" || current.state === "pending_delivery") requestThreadInputDelivery(thread.id);
        return {
          ok: true,
          interrupted: Boolean((interrupted as any).interrupted),
          message: current,
          delivered,
          queued: current.state !== "completed",
          queueItemId: current.id,
          deliveryState: current.deliveryState || current.state,
          observed: true,
          observedVia: current.observedVia || "codex_app_server_interrupt",
          reason: "interrupt",
          state: current.state,
          runtime: await this.threadRuntimeService.status(thread.id).catch(() => null),
        };
      }
      return { ok: true, interrupted: Boolean((interrupted as any).interrupted), runtime: await this.threadRuntimeService.status(thread.id).catch(() => null) };
    }
    const result = await wakeThread(thread.id, { reason: "interrupt" });
    if (!result) throw httpError("thread_wake_failed", 500);
    const paneId = result.status?.paneId || result.lease?.paneId;
    const interrupted = shouldInterruptRuntime(result.status as Record<string, any> | null);
    if (paneId && interrupted) {
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "Escape"], () => resolve(null)));
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "C-c"], () => resolve(null)));
    }
    if (String(body.text || "").trim()) {
      const message = await enqueueThreadInputForPrincipal(result.thread.id, {
        ...body,
        source: body.source || "interrupt",
        forceDeliveryAfterInterrupt: true,
      }, principal);
      const delivered = await deliverPendingThreadInputs(result.thread.id);
      const current = (await listThreadMessages(result.thread.id)).find((item: any) => item.id === message.id) || message;
      if (current.state === "queued" || current.state === "pending_delivery") requestThreadInputDelivery(result.thread.id);
      return {
        ok: true,
        interrupted,
        message: current,
        delivered,
        queued: current.state !== "completed",
        queueItemId: current.id,
        deliveryState: current.deliveryState || current.state,
        observed: true,
        observedVia: current.observedVia || (current.deliveryState === "awaiting_ack" ? "tmux_send_pending_ack" : "interrupt"),
        reason: "interrupt",
        state: current.state === "queued" || current.state === "pending_delivery" ? "waking" : current.state,
        runtime: result.status,
      };
    }
    return { ok: true, interrupted, runtime: result.status };
  }

  @Post(":threadId/approve")
  @HttpCode(202)
  async approve(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadApproveSchema, { params: { threadId }, body });
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    if (threadUsesCodexAppServer(thread)) {
      await this.assertThreadSanitized("thread.approve", requestPrincipal(request), thread, body);
      const result = await answerCodexAppServerPendingRequest(thread, {
        decision: String(body.decision || "accept"),
        text: String(body.text || "Approved. Proceed."),
      });
      if (!result.answered) throw httpError(result.reason || "no_pending_request", 409);
      return {
        ok: true,
        answered: true,
        request: result.request,
        thread: result.thread ? await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)) : undefined,
        runtime: result.status,
      };
    }
    return this.input(request, threadId, { ...body, text: String(body.text || "Approved. Proceed."), source: body.source || "approval" });
  }

  @Post(":threadId/codex-mode")
  @HttpCode(200)
  async codexMode(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const mode = String(body.mode || "").trim().toLowerCase();
    if (mode !== "code" && mode !== "plan") throw httpError("invalid_codex_mode", 400);
    await this.assertThreadSanitized("thread.codex-mode", requestPrincipal(request), thread, body);
    const result: any = await this.applyOrQueueCodexModeCommand(thread, mode as "code" | "plan", "codex_mode_button");
    const updated: any = await getThread(thread.id) || thread;
    return {
      ok: true,
      mode,
      applied: Boolean(result.applied),
      queued: Boolean(result.deferred),
      message: result.message,
      runtimeMode: result.runtimeMode,
      thread: await threadRuntimeSummary(updated, await listThreadMessages(updated.id || thread.id)),
    };
  }

  @Get(":threadId")
  async get(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { thread };
  }

  @Delete(":threadId")
  async delete(@Req() request: any, @Param("threadId") threadId: string, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const deleteWorkers = optionalBodyBoolean(query, "deleteWorkers", false);
    const target = await getThread(threadId);
    if (!target) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.delete", principal, target, query);
    if (target && threadUsesCodexAppServer(target)) {
      await archiveCodexAppServerThread(target).catch(() => null);
    }
    const result = await deleteThreadForPrincipal(threadId, principal, { deleteWorkers });
    const deleted = new Set((result.deletedThreads || []).map((id: string) => String(id)));
    const timers = await listTimersForPrincipal(principal);
    const deletedTimers: string[] = [];
    for (const timer of timers) {
      const target = String(timer.target || timer.threadId || "").trim();
      if (timer.targetType === "thread" && deleted.has(target)) {
        if (await deleteTimerForPrincipal(timer.id, principal)) deletedTimers.push(timer.id);
      }
    }
    return { ...result, deletedTimers };
  }

}
