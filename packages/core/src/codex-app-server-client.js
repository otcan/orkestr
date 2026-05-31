import readline from "node:readline";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { appendEvent } from "../../storage/src/store.js";
import { codexCommand, defaultCodexHome } from "../../connectors/src/codex.js";
import {
  codexAppServerClientArgs,
  codexAppServerSocket,
  codexAppServerTransport,
  codexAppServerWebSocketUrl,
} from "../../connectors/src/codex-app-server-transport.js";
import { listThreadMessages, updateThread, updateThreadMessage } from "./threads.js";
import {
  appendOrUpdateEventMessage,
  approvalPromptText,
  clean,
  clientKey,
  codexThreadId,
  commandEnv,
  itemPhase,
  itemText,
  markThreadFromCodexStatus,
  nowIso,
  publicError,
  runtimeHome,
  threadEventId,
  threadForCodexThreadId,
  threadUsesRestrictedCodexPolicy,
  timeoutMs,
} from "./codex-app-server-common.js";
import {
  codexAppServerMessageFields,
  latestWhatsAppParent,
  threadWhatsAppBindingParent,
  whatsappOrigin,
  whatsappProjectionFields,
} from "./codex-app-server-whatsapp.js";
import { requestUserInputAnswers } from "./codex-app-server-user-input.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";

const execFileAsync = promisify(execFile);
const clients = new Map();
let messageHandler = null;

function notifyMessageHandler({ thread, message }) {
  if (!messageHandler || !message) return;
  Promise.resolve(messageHandler({ thread, message })).catch(() => {});
}

function codexTurnConversationInterrupted(turn = {}) {
  const status = clean(turn.status).toLowerCase();
  if (["interrupted", "aborted", "cancelled", "canceled"].includes(status)) return true;
  const reason = clean(turn.reason || turn.error?.reason || turn.error?.code).toLowerCase();
  if (["interrupted", "aborted", "cancelled", "canceled"].includes(reason)) return true;
  const errorText = publicError(turn.error).toLowerCase();
  return /conversation interrupted|turn_aborted|\bturn aborted\b|\binterrupted\b|\bcancell?ed\b/.test(errorText);
}

function codexConversationInterruptionNoticeText() {
  return [
    "Codex conversation interrupted",
    "",
    "Codex reported that the active turn was interrupted before it produced a normal reply.",
    "Send the next instruction normally to continue.",
  ].join("\n");
}

export class CodexAppServerClient {
  constructor({ env = process.env, home = os.homedir() } = {}) {
    this.env = { ...env };
    this.home = home;
    this.command = codexCommand(env);
    this.codexHome = defaultCodexHome(env, home);
    this.transport = codexAppServerTransport(env);
    this.socket = codexAppServerSocket(env);
    this.nextId = 1;
    this.pending = new Map();
    this.threadStates = new Map();
    this.turnParents = new Map();
    this.completedTurns = new Set();
    this.pendingRequests = new Map();
    this.pendingNotifications = new Set();
    this.started = false;
    this.startPromise = null;
    this.closed = false;
    this.stderr = "";
  }

  async start() {
    if (this.started) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (!this.command) throw new Error("codex_app_server_unavailable");
      if (this.transport === "websocket" && this.socket) {
        await this.startWebSocket();
      } else {
        await this.startProcess();
      }
      await this.request("initialize", {
        clientInfo: {
          name: "orkestr_oss",
          title: "Orkestr OSS",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      this.started = true;
      return this;
    })();
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async startProcess() {
    this.proc = spawn(this.command, codexAppServerClientArgs(this.env), {
      env: commandEnv(this.env, this.home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (error) => this.rejectAll(error));
    this.proc.on("close", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`codex_app_server_closed:${code ?? ""}:${signal ?? ""}`));
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk || "")}`.slice(-8192);
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
  }

  async startWebSocket() {
    const url = codexAppServerWebSocketUrl(this.env);
    if (!url) throw new Error("codex_app_server_socket_required");
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws?.terminate();
        reject(new Error("codex_app_server_websocket_timeout"));
      }, timeoutMs(this.env));
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
        this.ws?.off("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code, reason) => {
        cleanup();
        reject(new Error(`codex_app_server_websocket_closed:${code}:${String(reason || "")}`));
      };
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
      this.ws.once("close", onClose);
    });
    this.ws.on("message", (chunk) => this.handleLine(String(chunk || "")));
    this.ws.on("error", (error) => this.rejectAll(error));
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      this.rejectAll(new Error(`codex_app_server_closed:${code ?? ""}:${String(reason || "")}`));
    });
  }

  request(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new Error("codex_app_server_closed"));
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    const waitMs = Number(options.timeoutMs || timeoutMs(this.env));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex_app_server_timeout:${method}`));
      }, waitMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload, reject);
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  rejectServerRequest(id, message = "Request declined by Orkestr.") {
    this.write({ id, error: { code: -32000, message } });
  }

  write(payload, onError = null) {
    try {
      const text = JSON.stringify(payload);
      if (this.ws) this.ws.send(text, (error) => {
        if (error && onError) onError(error);
      });
      else this.proc.stdin.write(`${text}\n`);
    } catch (error) {
      if (onError) onError(error);
    }
  }

  handleLine(line) {
    const text = clean(line);
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `codex_app_server_error:${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) this.trackNotification(message);
  }

  trackNotification(message) {
    const pending = this.handleNotification(message).catch((error) => appendEvent({
      type: "codex_app_server_notification_failed",
      method: message?.method || "",
      error: publicError(error),
    }, this.env).catch(() => {}));
    this.pendingNotifications.add(pending);
    void pending.finally(() => {
      this.pendingNotifications.delete(pending);
    }).catch(() => {});
  }

  async drainNotifications() {
    const pending = [...this.pendingNotifications];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  turnParentKey(codexId, turnId) {
    const threadId = clean(codexId);
    const id = clean(turnId);
    return threadId && id ? `${threadId}:${id}` : "";
  }

  rememberTurnParent(codexId, turnId, message = null) {
    const key = this.turnParentKey(codexId, turnId);
    if (!key || !message) return null;
    this.turnParents.set(key, { ...message });
    while (this.turnParents.size > 200) {
      const oldest = this.turnParents.keys().next().value;
      this.turnParents.delete(oldest);
    }
    return this.turnParents.get(key);
  }

  turnParent(codexId, turnId) {
    return this.turnParents.get(this.turnParentKey(codexId, turnId)) || null;
  }

  async handleServerRequest(message) {
    const params = message.params || {};
    const codexId = clean(params.threadId);
    const thread = await threadForCodexThreadId(codexId, this.env);
    const request = {
      id: String(message.id),
      requestId: message.id,
      method: message.method,
      threadId: thread?.id || "",
      codexThreadId: codexId,
      turnId: clean(params.turnId),
      itemId: clean(params.itemId),
      params,
      createdAt: nowIso(),
    };
    this.pendingRequests.set(String(message.id), request);
    if (!thread) {
      this.rejectServerRequest(message.id, "No Orkestr thread is mapped to this Codex request.");
      return;
    }
    if (threadUsesRestrictedCodexPolicy(thread, this.env)) {
      this.rejectServerRequest(message.id, "Blocked by Orkestr tenant isolation for this contained user.");
      await appendOrUpdateEventMessage(thread, {
        role: "assistant",
        source: "orkestr_runtime",
        phase: "runtime_interrupted",
        text: "Blocked by tenant isolation.\n\nThis contained user cannot approve host-level tool access or use private operator resources. Connect the needed capability for this user in Orkestr, then retry.",
        state: "completed",
        eventId: threadEventId({
          codexThreadId: codexId,
          turnId: params.turnId,
          itemId: params.itemId || message.id,
          type: "contained-user-request-blocked",
          role: "assistant",
          text: message.method,
        }),
        codexTurnId: params.turnId || null,
        codexItemId: params.itemId || null,
        codexRequestId: String(message.id),
        ...codexAppServerMessageFields(codexId, {
          turnId: params.turnId,
          itemId: params.itemId || message.id,
          requestId: message.id,
        }),
        ...whatsappProjectionFields(
          await latestWhatsAppParent(thread, params.timestamp || nowIso(), this.env) ||
            threadWhatsAppBindingParent(thread),
          thread,
        ),
      }, this.env).then((messageRecord) => {
        if (messageRecord) notifyMessageHandler({ thread, message: messageRecord });
      }).catch(() => null);
      await appendEvent({
        type: "codex_app_server_request_blocked_tenant_isolation",
        threadId: thread.id,
        codexThreadId: codexId,
        method: message.method,
        requestId: String(message.id),
      }, this.env).catch(() => {});
      return;
    }
    await updateThread(thread.id, {
      state: "awaiting_approval",
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        pendingRequest: request,
      },
    }, this.env).catch(() => {});
    await appendTurnLifecycleEvent("awaiting_approval", {
      threadId: thread.id,
      runtimeKind: "codex-app-server",
      turnId: params.turnId,
      state: "awaiting_approval",
      source: "codex-app-server",
      reason: message.method,
    }, this.env).catch(() => {});
    const text = approvalPromptText(message.method, params);
    if (text) {
      const whatsappParent =
        await latestWhatsAppParent(thread, params.timestamp || nowIso(), this.env) ||
        threadWhatsAppBindingParent(thread);
      const messageRecord = await appendOrUpdateEventMessage(thread, {
        role: "assistant",
        source: "codex-app-server",
        phase: message.method === "item/tool/requestUserInput" ? "need_input" : "awaiting_approval",
        text,
        state: "completed",
        eventId: threadEventId({
          codexThreadId: codexId,
          turnId: params.turnId,
          itemId: params.itemId || message.id,
          type: message.method,
          role: "assistant",
          text,
        }),
        codexTurnId: params.turnId || null,
        codexItemId: params.itemId || null,
        codexRequestId: String(message.id),
        ...codexAppServerMessageFields(codexId, {
          turnId: params.turnId,
          itemId: params.itemId,
          requestId: message.id,
        }),
        ...whatsappProjectionFields(whatsappParent, thread),
      }, this.env).catch(() => null);
      if (messageRecord) notifyMessageHandler({ thread, message: messageRecord });
    }
    await appendEvent({
      type: "codex_app_server_request",
      threadId: thread.id,
      codexThreadId: codexId,
      method: message.method,
      requestId: String(message.id),
    }, this.env).catch(() => {});
  }

  async handleNotification(message) {
    const params = message.params || {};
    const codexId = clean(params.threadId || params.thread?.id || params.turn?.threadId);
    if (message.method === "thread/started" && params.thread?.id) {
      this.threadStates.set(params.thread.id, {
        ...(this.threadStates.get(params.thread.id) || {}),
        status: params.thread.status || { type: "idle" },
        thread: params.thread,
      });
    }
    if (message.method === "thread/status/changed" && codexId) {
      const state = this.threadStates.get(codexId) || {};
      this.threadStates.set(codexId, { ...state, status: params.status || null });
      const thread = await threadForCodexThreadId(codexId, this.env);
      if (thread) await markThreadFromCodexStatus(thread, params.status, this.env);
      return;
    }
    if (message.method === "turn/started") {
      const turn = params.turn || {};
      const threadId = clean(turn.threadId || codexId);
      const turnId = clean(turn.id);
      if (threadId && turnId) {
        const state = this.threadStates.get(threadId) || {};
        this.threadStates.set(threadId, { ...state, activeTurnId: turnId, status: { type: "active", activeFlags: ["running"] } });
        const thread = await threadForCodexThreadId(threadId, this.env);
        if (thread) {
          await updateThread(thread.id, {
            state: "working",
            runtime: {
              ...(thread.runtime || {}),
              runtimeKind: "codex-app-server",
              activeTurnId: turnId,
              state: "working",
              updatedAt: nowIso(),
            },
          }, this.env).catch(() => {});
          await appendTurnLifecycleEvent("started", {
            threadId: thread.id,
            runtimeKind: "codex-app-server",
            turnId,
            state: "running",
            source: "codex-app-server",
          }, this.env).catch(() => {});
        }
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn || {};
      const threadId = clean(turn.threadId || codexId);
      const turnId = clean(turn.id);
      const status = clean(turn.status || "completed");
      if (threadId) {
        const completedKey = this.turnParentKey(threadId, turnId);
        if (completedKey) {
          this.completedTurns.add(completedKey);
          while (this.completedTurns.size > 500) {
            const oldest = this.completedTurns.keys().next().value;
            this.completedTurns.delete(oldest);
          }
        }
        const state = this.threadStates.get(threadId) || {};
        this.threadStates.set(threadId, { ...state, activeTurnId: "", status: { type: status === "failed" ? "systemError" : "idle" } });
        const thread = await threadForCodexThreadId(threadId, this.env);
        if (thread) {
          await updateThread(thread.id, {
            state: status === "failed" ? "failed" : "ready",
            lastError: status === "failed" ? publicError(turn.error) : null,
            runtime: {
              ...(thread.runtime || {}),
              runtimeKind: "codex-app-server",
              activeTurnId: null,
              lastTurnId: turnId || null,
              lastTurnStatus: status,
              state: status === "failed" ? "failed" : "ready",
              updatedAt: nowIso(),
            },
          }, this.env).catch(() => {});
          await appendTurnLifecycleEvent(codexTurnConversationInterrupted(turn) ? "interrupted" : status === "failed" ? "failed" : "completed", {
            threadId: thread.id,
            runtimeKind: "codex-app-server",
            turnId,
            state: codexTurnConversationInterrupted(turn) ? "interrupted" : status === "failed" ? "failed" : "completed",
            source: "codex-app-server",
            reason: publicError(turn.error),
          }, this.env).catch(() => {});
          if (codexTurnConversationInterrupted(turn)) {
            const text = codexConversationInterruptionNoticeText();
            const whatsappParent =
              await latestWhatsAppParent(thread, params.timestamp || nowIso(), this.env) ||
              threadWhatsAppBindingParent(thread);
            const messageRecord = await appendOrUpdateEventMessage(thread, {
              role: "assistant",
              source: "orkestr_runtime",
              phase: "runtime_interrupted",
              text,
              state: "completed",
              eventId: threadEventId({
                codexThreadId: threadId,
                turnId,
                itemId: "conversation-interrupted",
                type: "turn/interrupted",
                role: "assistant",
                text,
              }),
              codexThreadId: threadId,
              codexTurnId: turnId || null,
              ...codexAppServerMessageFields(threadId, { turnId, itemId: "conversation-interrupted" }),
              ...whatsappProjectionFields(whatsappParent, thread),
            }, this.env).catch(() => null);
            if (messageRecord) notifyMessageHandler({ thread, message: messageRecord });
            await appendEvent({
              type: "codex_app_server_conversation_interrupted",
              threadId: thread.id,
              codexThreadId: threadId,
              turnId,
              messageId: messageRecord?.id || null,
            }, this.env).catch(() => {});
          }
        }
      }
      return;
    }
    if (message.method === "item/completed") {
      await this.projectItem(params.item || {}, params, codexId);
      return;
    }
    if (message.method === "thread/tokenUsage/updated" && codexId) {
      const thread = await threadForCodexThreadId(codexId, this.env);
      if (thread) {
        await updateThread(thread.id, {
          codexTokenUsage: params.usage || params.tokenUsage || null,
          codexRateLimits: params.rateLimits || null,
          executor: {
            ...(thread.executor || {}),
            metadata: {
              ...(thread.executor?.metadata || {}),
              codexTokenUsage: params.usage || params.tokenUsage || null,
              codexRateLimits: params.rateLimits || null,
            },
          },
        }, this.env).catch(() => {});
      }
    }
  }

  async projectItem(item, params = {}, fallbackCodexThreadId = "") {
    const codexId = clean(params.threadId || item.threadId || fallbackCodexThreadId);
    const thread = await threadForCodexThreadId(codexId, this.env);
    if (!thread) return null;
    const type = clean(item.type);
    if (!["agentMessage", "plan", "exitedReviewMode", "contextCompaction"].includes(type)) return null;
    const text = type === "contextCompaction" ? "Codex compacted the conversation context." : itemText(item);
    if (!text) return null;
    const phase = itemPhase(item) || "final_answer";
    const timestamp = params.timestamp || nowIso();
    const turnId = clean(params.turnId || item.turnId);
    const rememberedParent = this.turnParent(codexId, turnId);
    const explicitParent = params.parentMessage && whatsappOrigin(params.parentMessage) ? params.parentMessage : null;
    const whatsappParent =
      explicitParent ||
      (rememberedParent && whatsappOrigin(rememberedParent) ? rememberedParent : null) ||
      await latestWhatsAppParent(thread, timestamp, this.env) ||
      threadWhatsAppBindingParent(thread);
    const message = await appendOrUpdateEventMessage(thread, {
      role: "assistant",
      source: "codex-app-server",
      phase,
      text,
      state: "completed",
      eventId: threadEventId({
        codexThreadId: codexId,
        turnId: params.turnId || item.turnId,
        itemId: item.id,
        type,
        role: "assistant",
        text,
      }),
      codexThreadId: codexId,
      codexTurnId: turnId || null,
      codexItemId: item.id || null,
      ...codexAppServerMessageFields(codexId, {
        turnId,
        itemId: item.id,
      }),
      timestamp,
      ...whatsappProjectionFields(whatsappParent, thread),
    }, this.env);
    notifyMessageHandler({ thread, message });
    const finalAnswer = clean(phase).toLowerCase() === "final_answer";
    const completedKey = finalAnswer ? this.turnParentKey(codexId, turnId) : "";
    if (completedKey) {
      this.completedTurns.add(completedKey);
      while (this.completedTurns.size > 500) {
        const oldest = this.completedTurns.keys().next().value;
        this.completedTurns.delete(oldest);
      }
      this.threadStates.set(codexId, { ...(this.threadStates.get(codexId) || {}), activeTurnId: "", status: { type: "idle" } });
    }
    let deliveredParent = rememberedParent;
    if (finalAnswer && !deliveredParent?.id) {
      const messages = await listThreadMessages(thread.id, this.env).catch(() => []);
      deliveredParent = [...messages].reverse().find((item) =>
        clean(item.role).toLowerCase() === "user" &&
        (clean(item.deliveryState) === "codex_app_server_sending" || clean(item.state) === "pending_delivery")
      ) || null;
    }
    if (finalAnswer && deliveredParent?.id) {
      await updateThreadMessage(thread.id, deliveredParent.id, {
        state: "completed",
        deliveryState: "delivered",
        deliveredAt: timestamp,
        observedVia: "codex_app_server_final_answer",
        deliveryClaimId: null,
        codexThreadId: codexId,
        codexTurnId: turnId || null,
        error: null,
      }, this.env).catch((error) => appendEvent({
        type: "codex_app_server_parent_delivery_update_failed",
        threadId: thread.id,
        codexThreadId: codexId,
        turnId,
        messageId: deliveredParent.id,
        error: publicError(error),
      }, this.env).catch(() => {}));
    }
    await updateThread(thread.id, {
      state: "ready",
      lastError: null,
      ...(finalAnswer ? {
        runtime: {
          ...(thread.runtime || {}),
          runtimeKind: "codex-app-server",
          activeTurnId: null,
          lastTurnId: turnId || null,
          lastTurnStatus: "completed",
          state: "ready",
          updatedAt: nowIso(),
        },
      } : {}),
    }, this.env).catch(() => {});
    return message;
  }

  pendingRequestForThread(thread) {
    const id = codexThreadId(thread);
    for (const request of this.pendingRequests.values()) {
      if (request.codexThreadId === id || request.threadId === thread.id) return request;
    }
    return null;
  }

  async answerPendingRequest(thread, decision = "accept", options = {}) {
    const request = this.pendingRequestForThread(thread);
    if (!request) return null;
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      this.respond(request.requestId, { decision });
    } else if (request.method === "item/tool/requestUserInput") {
      this.respond(request.requestId, { answers: requestUserInputAnswers(request, options.text || "") });
    } else {
      this.respond(request.requestId, { decision });
    }
    this.pendingRequests.delete(String(request.requestId));
    await updateThread(thread.id, {
      state: "working",
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        pendingRequest: null,
      },
    }, this.env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_request_resolved",
      threadId: thread.id,
      codexThreadId: request.codexThreadId,
      requestId: String(request.requestId),
      decision,
    }, this.env).catch(() => {});
    return request;
  }

  close() {
    this.closed = true;
    this.startPromise = null;
    this.rl?.close();
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      }, 1000);
      killTimer.unref?.();
      proc.once("close", () => clearTimeout(killTimer));
    }
    this.ws?.close();
    this.rejectAll(new Error("codex_app_server_closed"));
  }
}

export async function getCodexAppServerClient({ env = process.env, home = os.homedir() } = {}) {
  const key = clientKey(env, home);
  const existing = clients.get(key);
  if (existing && !existing.closed) return existing.start();
  const client = new CodexAppServerClient({ env, home });
  clients.set(key, client);
  try {
    return await client.start();
  } catch (error) {
    clients.delete(key);
    client.close();
    throw error;
  }
}

export function stopCodexAppServerClients() {
  for (const client of clients.values()) {
    client.close();
  }
  clients.clear();
}

export function setCodexAppServerMessageHandler(handler) {
  messageHandler = typeof handler === "function" ? handler : null;
  return () => {
    if (messageHandler === handler) messageHandler = null;
  };
}

export async function codexAppServerStatus({ env = process.env, home = os.homedir() } = {}) {
  const command = codexCommand(env);
  if (!command) {
    return { ok: false, available: false, command: "", codexHome: defaultCodexHome(env, home), error: "codex_disabled" };
  }
  try {
    const result = await execFileAsync(command, ["app-server", "--help"], {
      env: commandEnv(env, home),
      timeout: 3000,
      maxBuffer: 128 * 1024,
    });
    return {
      ok: true,
      available: true,
      command,
      codexHome: defaultCodexHome(env, home),
      transport: codexAppServerTransport(env),
      socket: codexAppServerSocket(env) || null,
      versionText: clean(result.stdout || result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      available: false,
      command,
      codexHome: defaultCodexHome(env, home),
      error: publicError(error) || "codex_app_server_unavailable",
    };
  }
}
