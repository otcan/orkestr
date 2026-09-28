import { appendEvent } from "../../storage/src/store.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { replyDeliveryProjectionParent } from "./reply-delivery-intent.js";
import { parseThreadInputCommand } from "./thread-commands.js";
import { normalizeExecutorTarget } from "./thread-executor-state.js";
import { executorSwitchReplyText, switchThreadExecutor, threadExecutorSummary } from "./thread-executor-switch.js";
import { appendThreadMessage, getThread, listThreadMessageCandidates, updateThreadMessage } from "./threads.js";

// `/agent`, `/agent claude|codex [model] [now]`, `/claude [model]`, `/codex
// [model]`. Handled the same way for WhatsApp, the web UI and `orkestr send`:
// the input API answers directly, queued chat inputs are answered at delivery.

const USAGE = "Use /agent to show the executor, or /agent claude|codex [model] [now] to switch. Shortcuts: /claude, /codex.";
const errorReplies = {
  claude_code_admin_runtime_required: "Claude Code is limited to the host admin's own threads.",
  claude_code_disabled: "Claude Code is disabled on this host.",
  llm_account_profile_required: "No ready Claude account profile is connected. Connect one in LLM accounts first.",
  llm_account_profile_not_found: "The Claude account profile was not found.",
  llm_account_profile_not_ready: "The Claude account profile is not ready. Sign in again in LLM accounts.",
  llm_account_profile_revoked: "The Claude account profile was revoked.",
  claude_model_unsupported: "That Claude model is not allowed on this host.",
  claude_effort_unsupported: "Claude effort must be low, medium, high or max.",
  codex_model_invalid: "That Codex model name is not valid.",
  codex_effort_invalid: "That Codex reasoning effort is not valid.",
  executor_self_switch_rate_limited: "Executor self-switch is rate limited. Try again later.",
  executor_switch_raw_terminal_unsupported: "This thread is in attached-terminal mode. Use /switch api first.",
  executor_switch_unsupported_runtime: "This thread's runtime cannot switch executors.",
  executor_switch_start_failed: "The target executor failed to start; the thread stays on its previous executor.",
};

function clean(value = "") {
  return String(value || "").trim();
}

export function parseExecutorCommandText(text = "") {
  const tokens = clean(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return { action: "show" };
  const target = normalizeExecutorTarget(tokens[0]);
  if (!target) return { action: "invalid" };
  let when = "after_turn";
  const rest = [];
  for (const token of tokens.slice(1)) {
    if (["now", "--now", "interrupt", "force"].includes(token.toLowerCase())) when = "now";
    else rest.push(token);
  }
  return { action: "switch", target, model: rest[0] || "", effort: rest[1] || "", when };
}

export function executorCommandErrorText(error) {
  const code = clean(error?.code || error?.message);
  return errorReplies[code] || `Executor switch failed: ${code || "unknown error"}.`;
}

export async function runExecutorCommand(thread, text, options = {}, env = process.env) {
  const parsed = parseExecutorCommandText(text);
  if (parsed.action === "show") {
    const current = await getThread(thread.id, env) || thread;
    const executor = threadExecutorSummary(current);
    return { ok: true, action: "show", changed: false, executor, replyText: executorSwitchReplyText({ executor, changed: false }) };
  }
  if (parsed.action === "invalid") return { ok: false, action: "invalid", error: "executor_target_invalid", replyText: USAGE };
  try {
    const result = await switchThreadExecutor(thread.id, parsed.target, {
      model: parsed.model,
      effort: parsed.effort,
      when: parsed.when,
      actor: options.actor || "owner",
      principal: options.principal || null,
      reason: options.reason || `/${options.rawCommand || "agent"} command`,
      runtime: options.runtime,
    }, env);
    return { ...result, action: "switch", replyText: executorSwitchReplyText(result) };
  } catch (error) {
    return {
      ok: false,
      action: "switch",
      error: clean(error?.code || error?.message) || "executor_switch_failed",
      statusCode: Number(error?.statusCode) || 400,
      replyText: executorCommandErrorText(error),
    };
  }
}

function chatSenderMayControl(message = {}) {
  const connector = clean(message.connector || message.originSurface).toLowerCase();
  if (connector !== "whatsapp" && clean(message.source) !== "whatsapp_inbound") return true;
  return ["owner", "admin"].includes(clean(message.senderEffectiveRole).toLowerCase());
}

async function appendExecutorCommandReply(thread, parent, text, env) {
  const route = replyDeliveryProjectionParent(parent) || parent;
  const assistant = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "final_answer",
    state: "completed",
    text,
    parentMessageId: parent.id,
    eventId: `executor-command:${thread.id}:${parent.id}`,
    connector: route.connector || "",
    chatId: route.chatId || "",
    accountId: route.accountId || "",
    sourceEventId: parent.sourceEventId || "",
    routerTraceId: parent.routerTraceId || "",
    turnId: parent.turnId || "",
  }, env);
  markConnectorDeliverySignal(assistant);
  return assistant;
}

export function isExecutorCommandMessage(message = {}) {
  return message?.role === "user" && parseThreadInputCommand(message).command === "executor";
}

// Answers queued executor commands before any executor sees them, so a
// command is never forwarded to a model as prompt text.
export async function processQueuedExecutorCommands(thread, env = process.env, options = {}) {
  const candidates = (await listThreadMessageCandidates(thread.id, { states: ["queued", "pending_delivery"] }, env))
    .filter(isExecutorCommandMessage);
  const handled = [];
  for (const message of candidates) {
    const parsed = parseThreadInputCommand(message);
    const current = await getThread(thread.id, env) || thread;
    const result = chatSenderMayControl(message)
      ? await runExecutorCommand(current, parsed.text, { rawCommand: parsed.rawCommand, runtime: options.runtime }, env)
      : { ok: false, error: "executor_command_denied", replyText: "Only the thread owner or an Orkestr admin can switch executors." };
    await updateThreadMessage(thread.id, message.id, {
      state: result.ok ? "completed" : "failed",
      deliveryState: result.ok ? "delivered" : "failed",
      deliveredAt: new Date().toISOString(),
      observedVia: "orkestr_executor_command",
      error: result.ok ? null : result.replyText,
    }, env).catch(() => {});
    await appendExecutorCommandReply(current, message, result.replyText, env).catch(() => null);
    await appendEvent({
      type: "thread_executor_command",
      threadId: thread.id,
      messageId: message.id,
      action: result.action || null,
      ok: Boolean(result.ok),
      error: result.error || null,
      deferred: Boolean(result.deferred),
      target: normalizeExecutorTarget(clean(parsed.text).split(/\s+/)[0]) || null,
    }, env).catch(() => {});
    handled.push(message.id);
  }
  return handled;
}
