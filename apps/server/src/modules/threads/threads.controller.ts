import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import { runNextThreadMessage } from "../../../../../packages/core/src/executors.js";
import {
  deliverPendingThreadInputs,
  requestThreadInputDelivery,
  requestThreadWake,
  runtimeStatus,
  sleepThread,
  syncRuntimeWindowName,
  wakeThread,
} from "../../../../../packages/core/src/runtime-leases.js";
import { createTimer, deleteTimer, listTimers } from "../../../../../packages/core/src/timers.js";
import {
  createThread,
  enqueueThreadInput,
  getThread,
  listThreadMessages,
  updateThread,
} from "../../../../../packages/core/src/threads.js";
import { createThreadWorker, detectThreadRepo, listThreadWorkers, updateThreadRepo } from "../../../../../packages/core/src/thread-workers.js";
import { parseThreadInputCommand } from "../../../../../packages/core/src/thread-commands.js";
import { ensureDataDirs } from "../../../../../packages/storage/src/paths.js";
import { codexThreadId, threadRuntimeSummary, threadSummaryPayload } from "../../thread-summary.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);

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
  const pendingQuestion = latestPendingQuestion(rawMessages);
  let messages = dedupeDisplayMessages(rawMessages.map(bridgeMessage).filter((message) => message.text));
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
    return { thread: await createThread({ wakePolicy: "wake-on-message", ...body }) };
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
    if (paneId) {
      const { execFile } = await import("node:child_process");
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "Escape"], () => resolve(null)));
      await new Promise((resolve) => execFile("tmux", ["send-keys", "-t", paneId, "C-c"], () => resolve(null)));
    }
    if (String(body.text || "").trim()) {
      const message = await enqueueThreadInput(result.thread.id, { ...body, source: body.source || "interrupt" });
      requestThreadInputDelivery(result.thread.id);
      return {
        ok: true,
        interrupted: true,
        message,
        queued: true,
        queueItemId: message.id,
        reason: "interrupt",
        state: "waking",
        runtime: result.status,
      };
    }
    return { ok: true, interrupted: true, runtime: result.status };
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
    const updated: any = await updateThread(thread.id, {
      desiredCodexMode: mode,
      desiredCodexModeUpdatedAt: updatedAt,
      codexMode: mode,
      codexModeSource: "orkestr-ui",
      codexModeUpdatedAt: updatedAt,
    });
    return {
      ok: true,
      mode,
      applied: true,
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
    const messages = await listThreadMessages(thread.id);
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

  @Put(":threadId/binding")
  async binding(@Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const current = thread.binding || {};
    const displayName = optionalBodyString(body, "displayName", current.displayName || thread.name || thread.id) || thread.name || thread.id;
    const binding = {
      ...current,
      connector: optionalBodyString(body, "connector", current.connector || "whatsapp") || "whatsapp",
      chatId: optionalBodyString(body, "chatId", current.chatId || ""),
      displayName,
      enabled: optionalBodyBoolean(body, "enabled", current.enabled !== false),
      allowOtherPeople: optionalBodyBoolean(body, "allowOtherPeople", current.allowOtherPeople !== false),
      mirrorToWhatsApp: optionalBodyBoolean(body, "mirrorToWhatsApp", current.mirrorToWhatsApp !== false),
      replyPrefix: optionalBodyString(body, "replyPrefix", current.replyPrefix || "otcanclaw:") || "otcanclaw:",
      outboundAccountId: optionalBodyString(body, "outboundAccountId", current.outboundAccountId || "") || null,
      updatedAt: new Date().toISOString(),
    };
    const updated = await updateThread(thread.id, { binding, bindingName: binding.displayName });
    return { ok: true, thread: updated, binding };
  }
}
