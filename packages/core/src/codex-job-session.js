// One Codex app-server session (a Codex thread) owned by an Agent Job, with no
// Orkestr thread record behind it. Provider-level lifecycle only: open (start
// or resume), run one turn, interrupt. The Agent Job adapter
// (agent-job-codex.js) maps tool calls and approvals onto the runner; the
// conformance harness drives this class directly against the fake app-server.
import os from "node:os";
import { redactCodexSecrets } from "./codex-auth-failure.js";
import { codexTurnAuthFailureReason } from "./codex-auth-health.js";
import { clean, itemPhase, itemText, publicError } from "./codex-app-server-common.js";
import { getCodexJobClient } from "./codex-job-client.js";
import { classifyCodexTurnError } from "./runtime-turn-error-class.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Classify a Codex turn/transport failure with the provider-neutral turn
// error classes (runtime-turn-error-class.js).
export function classifyCodexJobError(message = "") {
  const text = String(message || "");
  return classifyCodexTurnError(text, { authReason: codexTurnAuthFailureReason(text) });
}

function safeText(value) {
  return redactCodexSecrets(String(value || "")).slice(0, 4000);
}

export class CodexJobSession {
  constructor({ env = process.env, home = env.HOME || os.homedir() } = {}) {
    this.env = env;
    this.home = home;
    this.client = null;
    this.codexThreadId = "";
    this.turn = null;
    this.results = new Map();
    this.detach = () => {};
  }

  // Start a new Codex thread, or resume `sessionRef`. A resume that fails
  // (thread gone) falls back to a new thread and reports resumed: false.
  async open({ sessionRef = "", cwd = null, model = "", approvalPolicy = "untrusted", sandbox = "workspace-write", developerInstructions = "", dynamicTools = [] } = {}) {
    this.client = await getCodexJobClient({ env: this.env, home: this.home });
    this.cwd = cwd;
    this.approvalPolicy = approvalPolicy;
    let thread = null;
    let resumed = false;
    if (clean(sessionRef)) {
      const result = await this.client.request("thread/resume", {
        threadId: clean(sessionRef), cwd, approvalPolicy, sandbox, ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      }).catch(() => null);
      thread = result?.thread || null;
      resumed = Boolean(thread);
    }
    if (!thread) {
      const result = await this.client.request("thread/start", {
        cwd, approvalPolicy, sandbox, serviceName: "orkestr_oss", ephemeral: false,
        ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(dynamicTools.length ? { dynamicTools } : {}),
      });
      thread = result?.thread || {};
    }
    this.codexThreadId = clean(thread.id || thread.threadId);
    if (!this.codexThreadId) throw Object.assign(new Error("codex_app_server_thread_missing_id"), { kind: "provider", retryable: true });
    this.detach();
    this.detach = this.client.attach(this.codexThreadId, {
      notification: (message) => this.onNotification(message),
      serverRequest: (message) => this.onServerRequest(message),
    });
    // A turn left running by a crashed attempt must not race the new one.
    const stale = (Array.isArray(thread.turns) ? thread.turns : []).filter((turn) => turn?.status === "inProgress");
    this.staleTurnIds = new Set(stale.map((turn) => clean(turn.id)));
    for (const turn of stale) await this.client.request("turn/interrupt", { threadId: this.codexThreadId, turnId: turn.id }).catch(() => null);
    return { sessionRef: this.codexThreadId, resumed };
  }

  // Run one turn. Resolves { turnId, status: completed|failed|cancelled,
  // finalText, error: {class, code, retryable, retryAfterMs, hint, message} | null, duplicate }.
  // handlers.onEvent({type: "message"|"tool", ...}); handlers.onServerRequest
  // ({method, params, item}) -> response for Codex (see CodexJobClient).
  async runTurn({ inputId = "", text = "" } = {}, handlers = {}) {
    if (inputId && this.results.has(inputId)) return { ...(await this.results.get(inputId)), duplicate: true };
    const promise = this.runTurnOnce(text, handlers);
    if (inputId) this.results.set(inputId, promise);
    return promise;
  }

  async runTurnOnce(text, { onEvent = () => {}, onServerRequest = null, signal = null } = {}) {
    if (this.turn) throw Object.assign(new Error("codex_job_turn_already_active"), { kind: "task", retryable: false });
    const turn = { id: "", items: new Map(), finalText: "", lastText: "", onEvent, onServerRequest, done: null };
    turn.settled = new Promise((resolve, reject) => { turn.done = { resolve, reject }; });
    this.turn = turn;
    const onAbort = () => { void this.interrupt(); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const watchdog = setInterval(() => {
      if (this.client?.closed) turn.done.reject(Object.assign(new Error("codex_app_server_closed"), { kind: "provider", retryable: true }));
    }, 200);
    watchdog.unref?.();
    try {
      const started = await this.client.request("turn/start", {
        threadId: this.codexThreadId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: this.cwd,
        approvalPolicy: this.approvalPolicy,
      });
      turn.id = clean(started?.turn?.id) || turn.id;
      if (signal?.aborted) void this.interrupt();
      const completed = await turn.settled;
      const status = ["interrupted", "cancelled", "canceled", "aborted"].includes(clean(completed.status)) ? "cancelled"
        : clean(completed.status) === "completed" ? "completed" : "failed";
      const message = status === "failed" ? safeText(publicError(completed.error) || "codex_turn_failed") : "";
      return {
        turnId: turn.id,
        status,
        finalText: status === "completed" ? turn.finalText || turn.lastText : "",
        error: message ? { ...classifyCodexJobError(message), message } : null,
        duplicate: false,
      };
    } finally {
      clearInterval(watchdog);
      signal?.removeEventListener?.("abort", onAbort);
      if (this.turn === turn) this.turn = null;
    }
  }

  // The active turn if a message belongs to it. Until turn/start answers, only
  // a turn/started notification may name the turn: right after thread/resume
  // Codex sends notifications (thread/tokenUsage/updated) tagged with the
  // previous turn's id, and adopting that id would drop every event of the
  // real turn, including turn/completed.
  ownsTurn(turnId, { adopt = false } = {}) {
    const turn = this.turn;
    if (!turn) return null;
    const id = clean(turnId);
    if (id && this.staleTurnIds?.has(id)) return null;
    if (!turn.id && id && adopt) turn.id = id;
    if (!id) return turn;
    return id === turn.id ? turn : null;
  }

  async onNotification(message) {
    const params = message.params || {};
    const turn = this.ownsTurn(params.turnId || params.turn?.id, { adopt: message.method === "turn/started" });
    if (!turn) return;
    if (message.method === "item/started" && params.item?.id) turn.items.set(params.item.id, params.item);
    if (message.method === "item/completed" && params.item) {
      const item = params.item;
      turn.items.set(item.id, item);
      if (item.type === "agentMessage") {
        const text = itemText(item);
        const phase = itemPhase(item);
        turn.lastText = text;
        if (phase === "final_answer") turn.finalText = text;
        turn.onEvent({ type: "message", phase, text: safeText(text) });
      } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type)) {
        turn.onEvent({ type: "tool", itemType: item.type, itemId: item.id, status: clean(item.status), tool: clean(item.tool || item.name || (Array.isArray(item.command) ? item.command.join(" ") : item.command)).slice(0, 200) });
      }
    }
    if (message.method === "turn/completed") turn.done.resolve(params.turn || {});
  }

  async onServerRequest(message) {
    const params = message.params || {};
    const turn = this.ownsTurn(params.turnId);
    if (!turn?.onServerRequest) return { error: "No active Orkestr job turn for this request." };
    return turn.onServerRequest({ method: message.method, params, item: turn.items.get(clean(params.itemId)) || null });
  }

  // Cooperative stop of the active turn; idempotent and a no-op when idle.
  async interrupt() {
    const turn = this.turn;
    if (!turn) return { interrupted: false };
    for (let tries = 0; !turn.id && tries < 50 && this.turn === turn; tries += 1) await sleep(20);
    if (!turn.id || this.turn !== turn) return { interrupted: false };
    await this.client.request("turn/interrupt", { threadId: this.codexThreadId, turnId: turn.id }).catch(() => null);
    return { interrupted: true };
  }

  // Abort the active turn locally (crash semantics: nothing is sent to Codex).
  failTurn(error) {
    this.turn?.done.reject(error);
  }

  close() {
    this.detach();
    this.detach = () => {};
  }
}
