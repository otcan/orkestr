import { readConnectorConfig } from "../../storage/src/config.js";
import { callConnectorsMcpTool } from "./connectors-mcp-client.js";
import {
  startLocalWhatsAppTyping,
  stopLocalWhatsAppTyping,
  syncLocalWhatsAppTypingTargets,
} from "./whatsapp-local-bridge.js";

const externalTypingTargetsByRuntime = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value = "") {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function bridgeMode(config = {}, env = process.env) {
  const mode = clean(env.WHATSAPP_BRIDGE_MODE || config.bridgeMode || "local").toLowerCase();
  if (["relay", "parent-forward", "control-plane-forward", "control-plane", "controlplane", "broker"].includes(mode)) {
    return "external";
  }
  const enabled = mode === "external" && (
    clean(env.WHATSAPP_BRIDGE_MODE).toLowerCase() === "external" ||
    truthy(env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED) ||
    truthy(env.WHATSAPP_EXTERNAL_BRIDGE_ENABLED)
  );
  return enabled ? "external" : "local";
}

function runtimeKey(env = process.env) {
  return [
    clean(env.ORKESTR_HOME),
    clean(env.ORKESTR_CONNECTORS_MCP_URL),
    clean(env.ORKESTR_INSTANCE_ID || env.ORKESTR_TENANT_VM_ID || env.ORKESTR_RELEASE_INSTANCE_ID),
  ].join("|");
}

function targetKey(accountId = "", chatId = "") {
  return `${clean(accountId).toLowerCase()}:${clean(chatId).toLowerCase()}`;
}

function normalizeTarget(target = {}) {
  const chatId = clean(target.chatId || target.conversationId);
  if (!chatId) return null;
  return {
    accountId: clean(target.accountId),
    chatId,
    threadId: clean(target.threadId),
    messageId: clean(target.messageId),
  };
}

function typingResultOk(result = {}, active = false) {
  const expected = active ? "active" : "inactive";
  return result?.status === expected || result?.status === "ok" || result?.data?.active === active;
}

export async function setExternalWhatsAppTyping({
  accountId = "",
  chatId = "",
  threadId = "",
  active = false,
  env = process.env,
} = {}, options = {}) {
  const conversationId = clean(chatId);
  if (!conversationId) return { ok: false, active: false, reason: "missing_chat_id" };
  const callTool = options.callTool || callConnectorsMcpTool;
  const result = await callTool("orkestr_messaging", {
    service: "whatsapp",
    action: "set_typing",
    account_id: clean(accountId) || undefined,
    thread_id: clean(threadId) || undefined,
    conversation_id: conversationId,
    typing_state: active ? "composing" : "paused",
  }, env);
  if (!typingResultOk(result, active)) {
    return {
      ok: false,
      active: false,
      accountId: clean(accountId),
      chatId: conversationId,
      error: clean(result?.error?.code || result?.status || "whatsapp_typing_mcp_failed"),
    };
  }
  return {
    ok: true,
    active,
    accountId: clean(result?.scope?.account_id || accountId),
    chatId: conversationId,
    data: result?.data || null,
  };
}

export async function startWhatsAppTyping({ chatId = "", accountId = "", threadId = "", env = process.env } = {}, options = {}) {
  const config = options.config || await readConnectorConfig("whatsapp", env);
  if (bridgeMode(config, env) === "local") {
    return startLocalWhatsAppTyping({ chatId, accountId, env });
  }
  return setExternalWhatsAppTyping({ chatId, accountId, threadId, active: true, env }, options);
}

export async function stopWhatsAppTyping({ chatId = "", accountId = "", threadId = "", env = process.env } = {}, options = {}) {
  const config = options.config || await readConnectorConfig("whatsapp", env);
  if (bridgeMode(config, env) === "local") {
    return stopLocalWhatsAppTyping({ chatId, accountId, env });
  }
  return setExternalWhatsAppTyping({ chatId, accountId, threadId, active: false, env }, options);
}

export async function syncExternalWhatsAppTypingTargets(targets = [], env = process.env, options = {}) {
  const key = runtimeKey(env);
  const previous = externalTypingTargetsByRuntime.get(key) || new Map();
  const desired = new Map();
  for (const candidate of targets) {
    const target = normalizeTarget(candidate);
    if (target) desired.set(targetKey(target.accountId, target.chatId), target);
  }

  const next = new Map();
  const started = [];
  const kept = [];
  const stopped = [];
  const failed = [];
  for (const [targetId, target] of desired) {
    const result = await setExternalWhatsAppTyping({ ...target, active: true, env }, options).catch((error) => ({
      ok: false,
      active: false,
      accountId: target.accountId,
      chatId: target.chatId,
      error: clean(error?.message) || "whatsapp_typing_mcp_failed",
    }));
    if (!result.ok) {
      failed.push(result);
      if (previous.has(targetId)) next.set(targetId, target);
      continue;
    }
    next.set(targetId, target);
    if (previous.has(targetId)) kept.push(result);
    else started.push(result);
  }
  for (const [targetId, target] of previous) {
    if (desired.has(targetId)) continue;
    const result = await setExternalWhatsAppTyping({ ...target, active: false, env }, options).catch((error) => ({
      ok: false,
      active: false,
      accountId: target.accountId,
      chatId: target.chatId,
      error: clean(error?.message) || "whatsapp_typing_mcp_failed",
    }));
    if (result.ok) stopped.push(result);
    else {
      failed.push(result);
      next.set(targetId, target);
    }
  }
  if (next.size) externalTypingTargetsByRuntime.set(key, next);
  else externalTypingTargetsByRuntime.delete(key);
  return { ok: failed.length === 0, active: next.size, started, kept, stopped, failed };
}

export async function syncWhatsAppTypingTargets(targets = [], env = process.env, options = {}) {
  const config = options.config || await readConnectorConfig("whatsapp", env);
  if (bridgeMode(config, env) === "local") return syncLocalWhatsAppTypingTargets(targets, env);
  return syncExternalWhatsAppTypingTargets(targets, env, options);
}

export function resetExternalWhatsAppTypingForTest() {
  externalTypingTargetsByRuntime.clear();
}
