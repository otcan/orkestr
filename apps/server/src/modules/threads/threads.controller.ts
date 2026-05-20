import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import { runNextThreadMessage } from "../../../../../packages/core/src/executors.js";
import {
  applyRuntimeCodexMode,
  deliverPendingThreadInputs,
  hardResetThreadRuntime,
  implementRuntimePlan,
  requestThreadInputDelivery,
  requestThreadWake,
  resetThreadRuntime,
  runtimeStatus,
  sleepThread,
  syncRuntimeWindowName,
  wakeThread,
} from "../../../../../packages/core/src/runtime-leases.js";
import { createTimer, deleteTimer, listTimers } from "../../../../../packages/core/src/timers.js";
import {
  appendThreadMessage,
  createThread,
  deleteThread,
  enqueueThreadInput,
  getThread,
  listThreadMessages,
  updateThread,
} from "../../../../../packages/core/src/threads.js";
import { createThreadWorker, detectThreadRepo, listThreadWorkers, syncThreadWorkerWithParent, updateThreadRepo } from "../../../../../packages/core/src/thread-workers.js";
import { parseThreadInputCommand } from "../../../../../packages/core/src/thread-commands.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { codexThreadId, threadRuntimeSummary, threadSummaryPayload } from "../../thread-summary.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";

const execFileAsync = promisify(execFile);

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

function messageTimestampMs(message: any): number {
  const ms = Date.parse(String(message?.timestamp || message?.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function chronologicalMessages(messages: any[] = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftMs = messageTimestampMs(left.message);
      const rightMs = messageTimestampMs(right.message);
      if (leftMs && rightMs && leftMs !== rightMs) return leftMs - rightMs;
      if (leftMs !== rightMs) return leftMs - rightMs;
      return messageCursor(left.message, left.index) - messageCursor(right.message, right.index);
    })
    .map(({ message }) => message);
}

const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);

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

function isNeedInputMessage(message: any): boolean {
  const role = String(message?.role || message?.kind || "assistant").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  return role === "assistant" && needInputPhases.has(phase) && !!String(message?.text || "").trim();
}

function latestPendingQuestion(messages: any[] = []) {
  let userRepliedAfterQuestion = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = String(message?.text || "").trim();
    if (!text) continue;
    const role = String(message?.role || message?.kind || "").trim().toLowerCase();
    if (role === "user") {
      userRepliedAfterQuestion = true;
      continue;
    }
    if (!isNeedInputMessage(message)) continue;
    if (userRepliedAfterQuestion) return null;
    const timestamp = message?.timestamp || message?.createdAt || null;
    const eventId = String(message?.eventId || message?.id || "").trim() || null;
    return {
      text,
      eventId,
      messageId: message?.id || null,
      cursor: messageCursor(message, index),
      timestamp,
      phase: message?.phase || null,
    };
  }
  return null;
}

function bridgeMessage(message: any, index: number) {
  const role = String(message?.role || "assistant").trim() === "user" ? "user" : "assistant";
  const text = String(message?.text || "").trim();
  const timestamp = message?.timestamp || message?.createdAt || new Date().toISOString();
  const phase = message?.phase || (role === "assistant" ? "final_answer" : null);
  return {
    ...message,
    cursor: messageCursor(message, index),
    timestamp,
    role,
    kind: role,
    phase,
    source: message?.source || "thread",
    stable: true,
    text,
    eventId: message?.eventId || message?.id || `${timestamp}:${index}`,
    awaitingInputCandidate: isNeedInputMessage({ ...message, role, phase, text }),
  };
}

function normalizedMessageText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function duplicateAdjacentAssistant(previous: any, current: any): boolean {
  if (!previous || !current) return false;
  if (previous.role !== "assistant" || current.role !== "assistant") return false;
  if (previous.source !== "codex-rollout" || current.source !== "codex-rollout") return false;
  if (String(previous.phase || "") !== String(current.phase || "")) return false;
  if (!normalizedMessageText(current.text) || normalizedMessageText(previous.text) !== normalizedMessageText(current.text)) return false;
  const previousMs = Date.parse(String(previous.timestamp || previous.createdAt || ""));
  const currentMs = Date.parse(String(current.timestamp || current.createdAt || ""));
  return Number.isFinite(previousMs) && Number.isFinite(currentMs) && Math.abs(currentMs - previousMs) <= 5000;
}

function dedupeDisplayMessages(messages: any[] = []) {
  const deduped: any[] = [];
  for (const message of messages) {
    if (duplicateAdjacentAssistant(deduped.at(-1), message)) continue;
    deduped.push(message);
  }
  return deduped;
}

function safeUploadName(name: unknown): string {
  const base = path.basename(String(name || "upload.bin")).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return base || "upload.bin";
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalBodyString(body: Record<string, unknown>, key: string, fallback: unknown = ""): string {
  return String(hasOwn(body, key) ? body[key] : fallback || "").trim();
}

function optionalBodyBoolean(body: Record<string, unknown>, key: string, fallback = true): boolean {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
  return value !== false;
}

function optionalBodyStringArray(body: Record<string, unknown>, key: string, fallback: unknown = []): string[] {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = String(item || "").trim();
    const comparable = text.toLowerCase();
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(text);
  }
  return result;
}

function optionalBodyStringMap(body: Record<string, unknown>, key: string, fallback: unknown = {}): Record<string, string> {
  const value = hasOwn(body, key) ? body[key] : fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const id = String(rawKey || "").trim();
    const label = String(rawValue || "").trim();
    if (id && label) result[id] = label;
  }
  return result;
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

function runtimeWorkspaceRoot(paths: Awaited<ReturnType<typeof ensureDataDirs>>): string {
  return path.resolve(String(process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT || process.env.ORKESTR_CLONE_ROOT || paths.workspaces).trim());
}

function resolveWorkspacePath(value: string, root: string): string {
  const requested = String(value || "").trim();
  if (!requested) return "";
  return path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested));
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

async function prepareThreadCreateBody(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const paths = await ensureDataDirs();
  const cloneRoot = runtimeWorkspaceRoot(paths);
  const workFolder = optionalBodyString(body, "workFolder", optionalBodyString(body, "workdirRelativePath", body["workdir"]));
  if (!optionalBodyBoolean(body, "cloneRepo", false)) {
    const requestedRepo = optionalBodyString(body, "repoPath");
    const requestedWorkspace = optionalBodyString(body, "workspace");
    const requestedCwd = optionalBodyString(body, "cwd");
    const requestedRoot = requestedRepo || requestedWorkspace || requestedCwd;
    const generatedWorkspace = !requestedRoot;
    const repoRoot = generatedWorkspace
      ? await availableWorkspacePath(cloneRoot, generatedWorkspaceName(body))
      : resolveWorkspacePath(requestedRoot, cloneRoot);
    const cwdRoot = requestedRepo || requestedWorkspace ? repoRoot : cloneRoot;
    const initGit = optionalBodyBoolean(body, "initGit", generatedWorkspace || optionalBodyBoolean(body, "autoWorkspace", false));
    const localGitInitialized = initGit ? await ensureLocalGitRepo(repoRoot) : false;
    const cwd = workFolder ? workspaceWithWorkFolder(repoRoot, workFolder) : resolveWorkspacePath(requestedCwd || repoRoot, cwdRoot);
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
    ? path.resolve(path.isAbsolute(requestedTarget) ? requestedTarget : path.join(cloneRoot, requestedTarget))
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

function uploadBuffer(file: any): Buffer {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  const encoded = String(file?.contentBase64 || "").trim();
  if (!encoded) throw httpError("upload_content_required", 400);
  return Buffer.from(encoded, "base64");
}

function messagePage(thread: any, rawMessages: any[] = [], query: Record<string, unknown> = {}, status: any = null) {
  const since = Math.max(0, Number.parseInt(String(query.since || "0"), 10) || 0);
  const before = Math.max(0, Number.parseInt(String(query.before || "0"), 10) || 0);
  const requestedLimit = Math.max(0, Number.parseInt(String(query.limit || "0"), 10) || 0);
  const limit = requestedLimit ? Math.min(requestedLimit, 100) : 100;
  const orderedMessages = chronologicalMessages(rawMessages);
  const pendingQuestion = latestPendingQuestion(orderedMessages);
  let messages = dedupeDisplayMessages(orderedMessages.map(bridgeMessage).filter((message) => message.text));
  if (since > 0) messages = messages.filter((message) => Number(message.cursor || 0) > since);
  if (before > 0) messages = messages.filter((message) => Number(message.cursor || 0) < before);
  messages = messages.slice(-limit);
  const allCursors = rawMessages.map((message, index) => messageCursor(message, index));
  const cursor = Math.max(0, ...allCursors);
  const oldestCursor = messages.length ? Number(messages[0]?.cursor || 0) : null;
  return {
    thread,
    orkestrThreadId: thread.id,
    threadId: codexThreadId(thread) || thread.id,
    codexThreadId: codexThreadId(thread) || null,
    since,
    before,
    limit,
    count: messages.length,
    messages,
    cursor,
    currentCursor: cursor,
    oldestCursor,
    hasMoreBefore: oldestCursor !== null && rawMessages.some((message, index) => messageCursor(message, index) < oldestCursor),
    state: status?.state || thread.state || "sleeping",
    source: "orkestr-oss",
    staleWorking: false,
    awaitingInput: !!pendingQuestion,
    awaitingInputEventId: pendingQuestion?.eventId || null,
    pendingQuestion,
  };
}

@Controller("api/threads")
export class ThreadsController {
  @Get()
  async list() {
    return threadSummaryPayload();
  }

  @Get("summary")
  async summary() {
    return this.list();
  }

  @Post()
  async create(@Body() body: Record<string, unknown> = {}) {
    const prepared = await prepareThreadCreateBody(body);
    return { thread: await createThread({ wakePolicy: "wake-on-message", ...prepared }) };
  }

  @Get(":threadId/workers")
  async workers(@Param("threadId") threadId: string) {
    const parent = await getThread(threadId);
    if (!parent) throw httpError("thread_not_found", 404);
    const workers = await listThreadWorkers(parent.id);
    return {
      thread: await threadRuntimeSummary(parent, await listThreadMessages(parent.id)),
      workers: await Promise.all(workers.map(async (worker: any) => threadRuntimeSummary(worker, await listThreadMessages(worker.id)))),
    };
  }

  @Post(":threadId/workers")
  @HttpCode(201)
  async createWorker(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const result: any = await createThreadWorker(threadId, body);
    if (body.wake !== false) {
      if (body.autoRun !== false && result.message) requestThreadInputDelivery(result.worker.id);
      else requestThreadWake(result.worker.id, { reason: "worker_created" });
    }
    return {
      ...result,
      worker: await threadRuntimeSummary(result.worker, await listThreadMessages(result.worker.id)),
    };
  }

  @Put(":threadId/repo")
  async updateRepo(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const result: any = await updateThreadRepo(threadId, body);
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/repo/detect")
  @HttpCode(200)
  async detectRepo(@Param("threadId") threadId: string) {
    const detected = await detectThreadRepo(threadId);
    const result: any = await updateThreadRepo(threadId, detected);
    return {
      ...result,
      detected,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/sync-parent")
  @HttpCode(200)
  async syncParent(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const status = await runtimeStatus(thread.id).catch(() => null);
    if (status?.working || status?.foregroundWorking || status?.typingActive || Number(status?.runningCount || 0) > 0 || Number(status?.pendingCount || 0) > 0) {
      throw httpError("thread_is_active", 409);
    }
    const result: any = await syncThreadWorkerWithParent(thread.id);
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Get(":threadId/messages")
  async messages(@Param("threadId") threadId: string, @Query() query: Record<string, unknown>) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const status = await runtimeStatus(thread.id).catch(() => null);
    return messagePage(thread, await listThreadMessages(thread.id), query, status);
  }

  @Post(":threadId/input")
  @HttpCode(202)
  async input(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    ensureAttachmentsArray(body);
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const parsedCommand = body.parseCommands === true || body.controlAllowed === true || body.originOwner === true
      ? parseThreadInputCommand(body)
      : { command: null, text: String(body.text || "") };
    if (parsedCommand.command === "interrupt") {
      return this.interrupt(thread.id, {
        ...body,
        text: parsedCommand.text,
        source: body.source || "interrupt",
        parsedCommand: parsedCommand.rawCommand || parsedCommand.command,
      });
    }
    if (parsedCommand.command === "stop") {
      const result = await sleepThread(thread.id, { reason: "stop_command", kill: true });
      const message = await appendThreadMessage(thread.id, {
        role: "user",
        source: body.source || "stop_command",
        text: "/stop",
        state: "completed",
        deliveryState: "delivered",
        observedVia: "orkestr_stop_command",
        deliveredAt: new Date().toISOString(),
      });
      return {
        ok: true,
        stopped: true,
        slept: result.slept,
        threadId: codexThreadId(thread) || thread.id,
        orkestrThreadId: thread.id,
        message,
        thread: await threadRuntimeSummary(result.thread, await listThreadMessages(thread.id)),
      };
    }
    if (parsedCommand.command === "reset" || parsedCommand.command === "hard_reset") {
      const hard = parsedCommand.command === "hard_reset";
      const result = hard
        ? await hardResetThreadRuntime(thread.id, { reason: body.source === "whatsapp" ? "whatsapp_hard_reset_command" : "hard_reset_command" })
        : await resetThreadRuntime(thread.id, { reason: body.source === "whatsapp" ? "whatsapp_reset_command" : "reset_command" });
      const message = await appendThreadMessage(thread.id, {
        role: "user",
        source: body.source || (hard ? "hard_reset_command" : "reset_command"),
        text: hard ? "/hard_reset" : "/reset",
        state: "completed",
        deliveryState: "delivered",
        observedVia: hard ? "orkestr_hard_reset_command" : "orkestr_reset_command",
        deliveredAt: new Date().toISOString(),
        resetSlept: (result as any).slept ?? null,
        compactionMethod: hard
          ? ((result as any).compaction?.compacted
            ? (result as any).compaction?.method
            : (result as any).manualCheckpoint?.method || (result as any).compaction?.method || null)
          : null,
        manualCheckpointPath: hard ? (result as any).manualCheckpoint?.path || null : null,
      });
      return {
        ok: true,
        reset: true,
        hardReset: hard,
        slept: (result as any).slept ?? null,
        compaction: hard ? (result as any).compaction || null : null,
        manualCheckpoint: hard ? (result as any).manualCheckpoint || null : null,
        threadId: codexThreadId(thread) || thread.id,
        orkestrThreadId: thread.id,
        message,
        thread: await threadRuntimeSummary((result as any).thread || thread, await listThreadMessages(thread.id)),
      };
    }
    if (parsedCommand.command === "plan" || parsedCommand.command === "code") {
      const mode = parsedCommand.command;
      const modePayload = await this.codexMode(thread.id, { mode });
      const text = String(parsedCommand.text || "").trim();
      if (!text) {
        const message = await appendThreadMessage(thread.id, {
          role: "user",
          source: body.source || "codex_mode_command",
          text: `/${mode}`,
          state: (modePayload as any).applied ? "completed" : "failed",
          deliveryState: (modePayload as any).applied ? "delivered" : "failed",
          observedVia: (modePayload as any).applied ? "orkestr_codex_mode_command" : "orkestr_codex_mode_not_applied",
          deliveredAt: (modePayload as any).applied ? new Date().toISOString() : "",
          error: (modePayload as any).applied ? "" : ((modePayload as any).runtimeMode?.reason || "Codex mode could not be applied."),
        });
        return {
          ok: Boolean((modePayload as any).applied),
          commandHandled: true,
          mode,
          applied: Boolean((modePayload as any).applied),
          message,
          queued: false,
          observed: true,
          observedVia: message.observedVia,
          replyText: (modePayload as any).applied
            ? `Codex ${mode} mode requested.`
            : `Could not switch Codex mode: ${message.error}`,
          runtimeMode: (modePayload as any).runtimeMode,
          thread: (modePayload as any).thread,
        };
      }
      body = { ...body, text };
    }
    if (parsedCommand.command === "implement") {
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
        runtimeLeaseId: result.status?.lease?.id || null,
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
    const before = await runtimeStatus(thread.id).catch(() => null);
    const message = await enqueueThreadInput(thread.id, body);
    if (body.autoRun === false) {
      return { ok: true, threadId: codexThreadId(thread) || thread.id, orkestrThreadId: thread.id, message, queued: true, reason: "auto_run_disabled", observed: true };
    }
    if (before?.state === "ready" && before?.promptReady === true) {
      const delivered = await deliverPendingThreadInputs(thread.id);
      const current = (await listThreadMessages(thread.id)).find((item: any) => item.id === message.id) || message;
      return {
        ok: true,
        threadId: codexThreadId(thread) || thread.id,
        orkestrThreadId: thread.id,
        message: current,
        delivered,
        queued: current.state !== "completed",
        deliveryState: current.deliveryState || current.state,
        observed: true,
        observedVia: current.observedVia || "pending_delivery",
      };
    }
    requestThreadInputDelivery(thread.id);
    return {
      ok: true,
      threadId: codexThreadId(thread) || thread.id,
      orkestrThreadId: thread.id,
      message,
      queued: true,
      queueItemId: message.id,
      reason: before?.state === "sleeping" ? "waking" : "pending_delivery",
      state: "waking",
      observed: true,
      observedVia: "pending_delivery",
    };
  }

  @Post(":threadId/uploads")
  @HttpCode(201)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 20 } }))
  async uploads(
    @Param("threadId") threadId: string,
    @Body() body: Record<string, unknown> = {},
    @UploadedFiles() uploadedFiles: any[] = [],
  ) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const files = uploadedFiles.length ? uploadedFiles : Array.isArray(body.files) ? body.files : [];
    if (!files.length) throw httpError("upload_files_required", 400);
    const paths = await ensureDataDirs();
    const uploadDir = path.join(paths.home, "uploads", thread.id);
    await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
    const attachments: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const name = safeUploadName((file as any)?.originalname || (file as any)?.name);
      const buffer = uploadBuffer(file);
      if (buffer.length > 25 * 1024 * 1024) throw httpError(`upload_too_large:${name}`, 413);
      const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${name}`;
      const savedPath = path.join(uploadDir, storedName);
      await fs.writeFile(savedPath, buffer, { mode: 0o600 });
      attachments.push({
        name,
        filename: name,
        mimetype: String((file as any)?.mimetype || (file as any)?.type || "application/octet-stream"),
        size: buffer.length,
        path: savedPath,
        saved_path: savedPath,
        source: "browser_upload",
      });
    }
    return { ok: true, threadId: thread.id, attachments };
  }

  @Get(":threadId/runtime-lite")
  async runtimeLite(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const messages = await listThreadMessages(thread.id);
    const summary = await threadRuntimeSummary(thread, messages);
    return {
      ...summary,
      orkestrThreadId: thread.id,
      threadId: summary.codexThreadId || codexThreadId(thread) || thread.id,
      codexThreadId: summary.codexThreadId || codexThreadId(thread) || null,
    };
  }

  @Get(":threadId/runtime")
  async runtime(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { thread, runtime: await runtimeStatus(thread.id) };
  }

  @Post(":threadId/wake")
  @HttpCode(200)
  async wake(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const result = await wakeThread(threadId, { reason: body.reason || "manual_wake" });
    requestThreadInputDelivery(result.thread.id);
    return result;
  }

  @Post(":threadId/sleep")
  @HttpCode(200)
  async sleep(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    return sleepThread(threadId, { reason: body.reason || "manual_sleep", kill: body.kill !== false });
  }

  @Post(":threadId/stop")
  @HttpCode(200)
  async stop(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const result: any = await sleepThread(threadId, { reason: body.reason || "ui_stop", kill: body.kill !== false });
    return {
      ok: true,
      stopped: true,
      slept: result.slept,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/reset")
  @HttpCode(200)
  async reset(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const result: any = await resetThreadRuntime(thread.id, { reason: body.reason || "manual_reset" });
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/hard-reset")
  @HttpCode(200)
  async hardReset(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const result: any = await hardResetThreadRuntime(thread.id, { reason: body.reason || "manual_hard_reset" });
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/attach")
  @HttpCode(200)
  async attach(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const status = await runtimeStatus(thread.id);
    if (!status.sessionName) {
      return {
        ok: false,
        state: status.state,
        thread,
        message: `Thread is ${status.state}; run orkestr wake ${thread.bindingName || thread.name || thread.id} first.`,
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
      attachCommand: `tmux attach-session -t ${runtime.sessionName}`,
    };
  }

  @Post(":threadId/interrupt")
  @HttpCode(200)
  async interrupt(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const result = await wakeThread(threadId, { reason: "interrupt" });
    const paneId = result.status?.paneId || result.lease?.paneId;
    const interrupted = shouldInterruptRuntime(result.status as Record<string, any> | null);
    if (paneId && interrupted) {
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "Escape"], () => resolve(null)));
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "C-c"], () => resolve(null)));
    }
    if (String(body.text || "").trim()) {
      const message = await enqueueThreadInput(result.thread.id, { ...body, source: body.source || "interrupt" });
      requestThreadInputDelivery(result.thread.id);
      return {
        ok: true,
        interrupted,
        message,
        queued: true,
        queueItemId: message.id,
        reason: "interrupt",
        state: "waking",
        runtime: result.status,
      };
    }
    return { ok: true, interrupted, runtime: result.status };
  }

  @Post(":threadId/approve")
  @HttpCode(202)
  async approve(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    return this.input(threadId, { ...body, text: String(body.text || "Approved. Proceed."), source: body.source || "approval" });
  }

  @Post(":threadId/codex-mode")
  @HttpCode(200)
  async codexMode(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const mode = String(body.mode || "").trim().toLowerCase();
    if (mode !== "code" && mode !== "plan") throw httpError("invalid_codex_mode", 400);
    const updatedAt = new Date().toISOString();
    const runtimeMode = await applyRuntimeCodexMode(thread.id, mode, process.env, {
      wakeIfUnavailable: true,
      wakeReason: "codex_mode_command",
      waitForReady: true,
    }).catch((error: unknown) => ({
      applied: false,
      changed: false,
      mode,
      reason: error instanceof Error ? error.message : String(error),
    }));
    const patch: Record<string, unknown> = {
      desiredCodexMode: null,
      desiredCodexModeUpdatedAt: null,
      codexModeLiveApplied: Boolean(runtimeMode.applied),
      codexModeLiveChanged: Boolean(runtimeMode.changed),
      codexModeApplyReason: runtimeMode.reason || null,
    };
    if (runtimeMode.applied) {
      patch.codexMode = mode;
      patch.codexModeSource = "orkestr-ui-live";
      patch.codexModeUpdatedAt = updatedAt;
    }
    const updated: any = await updateThread(thread.id, patch);
    return {
      ok: true,
      mode,
      applied: Boolean(runtimeMode.applied),
      runtimeMode,
      thread: await threadRuntimeSummary(updated, await listThreadMessages(updated.id || thread.id)),
    };
  }

  @Post(":threadId/hibernate")
  @HttpCode(200)
  async hibernate(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    return sleepThread(threadId, { reason: body.reason || "hibernate", kill: body.force !== false });
  }

  @Post(":threadId/resume")
  @HttpCode(200)
  async resume(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    return wakeThread(threadId, { reason: body.reason || body.mode || "resume" });
  }

  @Get(":threadId/history")
  async history(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const messages = chronologicalMessages(await listThreadMessages(thread.id));
    return {
      thread,
      orkestrThreadId: thread.id,
      threadId: codexThreadId(thread) || thread.id,
      codexThreadId: codexThreadId(thread) || null,
      messages,
      count: messages.length,
      updatedAt: messages.at(-1)?.createdAt || thread.updatedAt || null,
    };
  }

  @Post(":threadId/recover")
  @HttpCode(200)
  async recover(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { ok: true, thread: await updateThread(thread.id, { state: "ready", lastError: null }) };
  }

  @Post(":threadId/run-next")
  @HttpCode(200)
  async runNext(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const execution = await runNextThreadMessage(threadId, body);
    const whatsappDelivery = await deliverWhatsAppReplies().catch((error) => ({ error: error.message || String(error) }));
    return { execution, whatsappDelivery };
  }

  @Get(":threadId/timers")
  async timers(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const timers = (await listTimers()).filter((timer) => timer.targetType === "thread" && timer.target === thread.id);
    return { thread, timers };
  }

  @Post(":threadId/timers")
  async createTimer(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const timer = await createTimer({ ...body, targetType: "thread", target: thread.id });
    return { timer };
  }

  @Delete(":threadId/timers/:timerId")
  async deleteTimer(@Param("threadId") threadId: string, @Param("timerId") timerId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { ok: await deleteTimer(timerId) };
  }

  @Get(":threadId")
  async get(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { thread };
  }

  @Delete(":threadId")
  async delete(@Param("threadId") threadId: string, @Query() query: Record<string, unknown> = {}) {
    const deleteWorkers = optionalBodyBoolean(query, "deleteWorkers", false);
    const result = await deleteThread(threadId, { deleteWorkers });
    const deleted = new Set((result.deletedThreads || []).map((id: string) => String(id)));
    const timers = await listTimers();
    const deletedTimers: string[] = [];
    for (const timer of timers) {
      const target = String(timer.target || timer.threadId || "").trim();
      if (timer.targetType === "thread" && deleted.has(target)) {
        if (await deleteTimer(timer.id)) deletedTimers.push(timer.id);
      }
    }
    return { ...result, deletedTimers };
  }

  @Put(":threadId/binding")
  async binding(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const current = thread.binding || {};
    const displayName = optionalBodyString(body, "displayName", current.displayName || thread.name || thread.id) || thread.name || thread.id;
    const additionalParticipantsEnabled = optionalBodyBoolean(body, "additionalParticipantsEnabled", current.additionalParticipantsEnabled === true);
    const additionalParticipantIds = additionalParticipantsEnabled
      ? optionalBodyStringArray(body, "additionalParticipantIds", current.additionalParticipantIds || [])
      : [];
    const rawAdditionalParticipantLabels = optionalBodyStringMap(body, "additionalParticipantLabels", current.additionalParticipantLabels || {});
    const additionalParticipantLabels = Object.fromEntries(
      additionalParticipantIds
        .map((id) => [id, rawAdditionalParticipantLabels[id]] as const)
        .filter((entry) => entry[1]),
    );
    const binding = {
      ...current,
      connector: optionalBodyString(body, "connector", current.connector || "whatsapp") || "whatsapp",
      chatId: optionalBodyString(body, "chatId", current.chatId || ""),
      displayName,
      enabled: optionalBodyBoolean(body, "enabled", current.enabled !== false),
      allowOtherPeople: optionalBodyBoolean(body, "allowOtherPeople", current.allowOtherPeople !== false),
      additionalParticipantsEnabled,
      additionalParticipantIds,
      additionalParticipantLabels,
      mirrorToWhatsApp: optionalBodyBoolean(body, "mirrorToWhatsApp", current.mirrorToWhatsApp !== false),
      replyPrefix: optionalBodyString(body, "replyPrefix", current.replyPrefix || "otcanclaw:") || "otcanclaw:",
      senderAccountId: optionalBodyString(body, "senderAccountId", current.senderAccountId || "") || null,
      responderAccountId: optionalBodyString(body, "responderAccountId", current.responderAccountId || current.outboundAccountId || "") || null,
      senderContactId: optionalBodyString(body, "senderContactId", current.senderContactId || "") || null,
      responderContactId: optionalBodyString(body, "responderContactId", current.responderContactId || "") || null,
      generated: optionalBodyBoolean(body, "generated", current.generated === true),
      outboundAccountId: optionalBodyString(body, "outboundAccountId", current.outboundAccountId || "") || null,
      ownerAuthorTags: optionalBodyStringArray(body, "ownerAuthorTags", current.ownerAuthorTags || []),
      trustedOverrideAuthorTags: optionalBodyStringArray(body, "trustedOverrideAuthorTags", current.trustedOverrideAuthorTags || []),
      updatedAt: new Date().toISOString(),
    };
    const updated = await updateThread(thread.id, { binding, bindingName: binding.displayName });
    return { ok: true, thread: updated, binding };
  }
}
