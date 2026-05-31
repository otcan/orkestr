import { appendEvent } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { isAdminPrincipal } from "./policy.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { assertCreditBudget, estimateOpenAICost, recordCreditUsage } from "./credit-usage.js";
import { startCodexAppServerThread, threadUsesCodexAppServer } from "./codex-app-server.js";
import { tenantApiAgentToolDefinitions, runTenantApiAgentTool } from "./tenant-api-agent-tools.js";
import { threadRequiresTenantIsolation } from "./tenant-policy.js";
import { appendThreadMessage, getThread, listThreadMessages, updateThread, updateThreadMessage } from "./threads.js";
import { userScopedCapabilityHints } from "./user-skills.js";
import { adminUserId, normalizeUserId } from "./users.js";
import { appendTurnLifecycleEvent, turnLifecycleFromRuntimeStatus } from "./turn-lifecycle.js";

export const API_AGENT_RUNTIME_KIND = "api-agent";

const apiAgentRunning = new Set();

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function threadRuntimeKind(thread = {}) {
  return lower(thread.runtimeKind || thread.runtime?.runtimeKind || thread.executor?.metadata?.runtimeKind);
}

function threadOwnerUserId(thread = {}, env = process.env) {
  return normalizeUserId(thread.ownerUserId || thread.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function tenantPrincipalForThread(thread = {}, env = process.env) {
  const ownerUserId = threadOwnerUserId(thread, env);
  const adminId = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  if (ownerUserId === adminId) return adminPrincipal({ id: adminId, displayName: "Admin" });
  return userPrincipal({ id: ownerUserId, role: "user", source: "api-agent", displayName: ownerUserId });
}

export function threadUsesApiAgent(thread = {}, env = process.env) {
  if (!thread) return false;
  if (threadUsesCodexAppServer(thread, env)) return false;
  return threadRuntimeKind(thread) === API_AGENT_RUNTIME_KIND;
}

export function defaultTenantThreadRuntime(input = {}, principal = {}, env = process.env) {
  if (isAdminPrincipal(principal)) return null;
  const binding = input.binding && typeof input.binding === "object" ? input.binding : {};
  const connector = lower(binding.connector || input.connector);
  const generated = binding.generated === true || input.generated === true;
  const source = lower(input.source || input.originSurface || input.originTransport);
  if (connector === "whatsapp" || generated || source.includes("whatsapp")) return API_AGENT_RUNTIME_KIND;
  if (threadRequiresTenantIsolation(input, env) && lower(input.runtimeKind) === API_AGENT_RUNTIME_KIND) return API_AGENT_RUNTIME_KIND;
  return null;
}

function pendingApiAgentMessages(messages = []) {
  return messages.filter((message) =>
    lower(message.role) === "user" &&
    ["queued", "pending_delivery", "running"].includes(lower(message.state || "queued"))
  );
}

export function apiAgentRuntimeStatus(thread = {}, messages = [], env = process.env) {
  const pending = pendingApiAgentMessages(messages);
  const running = pending.filter((message) => lower(message.state) === "running");
  const state = running.length ? "working" : pending.length ? "queued" : "ready";
  const status = {
    state,
    status: state,
    runtimeState: state,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    lease: null,
    sessionName: null,
    paneId: null,
    promptReady: true,
    promptReadyStable: true,
    working: running.length > 0,
    foregroundWorking: running.length > 0,
    typingActive: running.length > 0,
    backgroundWork: false,
    pendingCount: pending.filter((message) => lower(message.state) !== "running").length,
    awaitingAckCount: 0,
    nextDeliveryAttemptAt: null,
    runningCount: running.length,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    hibernated: false,
    codexMode: null,
    codexModeSource: null,
    planImplementationReady: false,
    planImplementationMenuVisible: false,
    progress: running.length
      ? {
          stateHint: "working",
          summary: "Tenant API agent is preparing a reply.",
          tailLines: ["Tenant API agent is preparing a reply."],
          capturedAt: nowIso(),
        }
      : null,
  };
  return {
    ...status,
    turnLifecycle: turnLifecycleFromRuntimeStatus(status, messages),
  };
}

function apiAgentModel(env = process.env) {
  return clean(env.ORKESTR_API_AGENT_MODEL || env.OPENAI_API_AGENT_MODEL || "gpt-5-mini");
}

function maxOutputTokens(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_MAX_OUTPUT_TOKENS || 900);
  return Number.isFinite(parsed) ? Math.max(128, Math.floor(parsed)) : 900;
}

function apiAgentTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_TIMEOUT_MS || 45_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 45_000;
}

function apiAgentBudgetPreflightUsd(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_PREFLIGHT_ESTIMATED_USD || 0.001);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0.001;
}

function openAIBaseUrl(env = process.env) {
  return clean(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/g, "");
}

function responseText(response = {}) {
  const direct = clean(response.output_text);
  if (direct) return direct;
  const chunks = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && clean(part.text)) chunks.push(clean(part.text));
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function normalizeTenantApiAgentText(text = "") {
  const original = clean(text);
  if (!/(Orkestr UI|Orkestr admin|Orkestr administrator)/i.test(original)) return original;
  const setupTarget = /gmail/i.test(original)
    ? "Gmail"
    : /outlook/i.test(original)
      ? "Outlook"
      : /(linkedin|desktop|browser)/i.test(original)
        ? "the managed desktop"
        : "";
  const replacement = setupTarget === "Gmail"
    ? "You can connect Gmail from this chat. Ask me to connect Gmail and I will send a Google sign-in link."
    : setupTarget
      ? `${setupTarget} is not connected or enabled for this chat yet.`
      : "That setup is not available from this chat yet.";
  return original
    .replace(/(^|[.!?]\s+)[^.!?]*(?:Orkestr UI|Orkestr admin|Orkestr administrator)[^.!?]*[.!?]?/gi, (_match, prefix = "") => `${prefix}${replacement}`)
    .replace(/\s+/g, " ")
    .trim();
}

function responseFunctionCalls(response = {}) {
  return (Array.isArray(response.output) ? response.output : []).filter((item) => item?.type === "function_call" && clean(item.name));
}

function responseFunctionCallInputItems(response = {}) {
  return responseFunctionCalls(response).map((item) => ({
    type: "function_call",
    name: item.name,
    arguments: item.arguments || "{}",
    call_id: item.call_id,
  }));
}

function messageInputItem(message = {}) {
  return {
    role: lower(message.role) === "assistant" ? "assistant" : "user",
    content: clean(message.text || message.promptFile || ""),
  };
}

function sourceChannelForMessage(message = {}) {
  return clean(message.connector || message.originSurface || message.source || "");
}

function publicSkillEnabled(skill = {}, capabilities = {}, scopedConnectors = {}) {
  if (skill.enabled !== true) return false;
  const id = clean(skill.id).toLowerCase();
  const connector = clean(skill.requiresConnector).toLowerCase();
  if (connector) return scopedConnectors[connector] === true && capabilities[connector] === true;
  const desktop = clean(skill.requiresDesktop).toLowerCase();
  if (desktop) return capabilities.desktopLeases === true || capabilities.virtualBrowsers === true || capabilities.linkedin === true;
  if (id === "files") return capabilities.files === true;
  if (id === "timers") return capabilities.timers === true;
  if (id === "whatsapp") return capabilities.whatsapp === true;
  if (id === "gmail") return capabilities.gmail === true;
  if (id === "outlook") return capabilities.outlook === true;
  if (id === "linkedin") return capabilities.linkedin === true || capabilities.desktopLeases === true || capabilities.virtualBrowsers === true;
  if (id === "learning") return capabilities.learning === true;
  return true;
}

function publicSkillContext(skills = [], capabilities = {}, scopedConnectors = {}) {
  return (Array.isArray(skills) ? skills : []).slice(0, 50).map((skill) => ({
    id: clean(skill.id),
    name: clean(skill.name || skill.label || skill.id),
    description: clean(skill.description || skill.summary).slice(0, 1000),
    instructions: clean(skill.instructions).slice(0, 3000),
    enabled: publicSkillEnabled(skill, capabilities, scopedConnectors),
    registryEnabled: skill.enabled === true,
    builtIn: skill.builtIn === true,
    requiresConnector: clean(skill.requiresConnector),
    requiresDesktop: clean(skill.requiresDesktop),
  })).filter((skill) => skill.id);
}

function publicTenantCapabilities(capabilities = {}) {
  const scopedConnectors = capabilities.scopedConnectors && typeof capabilities.scopedConnectors === "object" ? capabilities.scopedConnectors : {};
  const connectorAuth = capabilities.connectorAuth && typeof capabilities.connectorAuth === "object" ? capabilities.connectorAuth : {};
  const skills = publicSkillContext(capabilities.skills, capabilities, scopedConnectors);
  return {
    files: capabilities.files === true,
    timers: capabilities.timers === true,
    desktops: capabilities.desktopLeases === true || capabilities.virtualBrowsers === true,
    whatsapp: capabilities.whatsapp === true,
    gmail: capabilities.gmail === true,
    outlook: capabilities.outlook === true,
    linkedin: capabilities.linkedin === true,
    learning: capabilities.learning === true,
    codexEscalation: true,
    hostSkills: false,
    globalConnectorAccounts: false,
    privateOperatorData: false,
    enabledSkills: skills.filter((skill) => skill.enabled).map((skill) => skill.id),
    disabledSkills: skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
    skills,
    scopedConnectors: {
      whatsapp: scopedConnectors.whatsapp === true || capabilities.whatsapp === true,
      gmail: scopedConnectors.gmail === true,
      outlook: scopedConnectors.outlook === true,
      jira: scopedConnectors.jira === true,
      shopify: scopedConnectors.shopify === true,
      linkedin: scopedConnectors.linkedin === true,
    },
    connectorAuth: Object.fromEntries(["whatsapp", "gmail", "outlook", "jira", "shopify"].map((provider) => {
      const status = connectorAuth[provider] && typeof connectorAuth[provider] === "object" ? connectorAuth[provider] : {};
      return [provider, {
        state: clean(status.state || "unknown"),
        connected: status.connected === true,
        pending: status.pending === true,
        parentAppConfigured: status.parentAppConfigured === true,
        parentAppPartiallyConfigured: status.parentAppPartiallyConfigured === true,
        userConnectionRequired: status.userConnectionRequired === true,
      }];
    })),
  };
}

async function scopedCapabilitiesForThread(thread = {}, env = process.env) {
  try {
    return await userScopedCapabilityHints({ userId: threadOwnerUserId(thread, env), thread }, env);
  } catch {
    return {
      files: false,
      timers: false,
      virtualBrowsers: false,
      desktopLeases: false,
      whatsapp: Boolean(thread.binding?.connector === "whatsapp" || thread.binding?.chatId),
      gmail: false,
      outlook: false,
      linkedin: false,
      learning: false,
      enabledSkills: [],
      disabledSkills: [],
      scopedConnectors: {
        whatsapp: Boolean(thread.binding?.connector === "whatsapp" || thread.binding?.chatId),
        gmail: false,
        outlook: false,
        jira: false,
        shopify: false,
        linkedin: false,
      },
    };
  }
}

async function tenantContext(thread = {}, messages = [], env = process.env) {
  const ownerUserId = threadOwnerUserId(thread, env);
  const capabilities = await scopedCapabilitiesForThread(thread, env);
  return {
    tenantId: ownerUserId,
    threadId: thread.id || null,
    threadName: thread.bindingName || thread.name || thread.title || thread.id || null,
    sourceChannel: thread.binding?.connector === "whatsapp" || thread.binding?.chatId ? "whatsapp" : "web",
    runtimeKind: API_AGENT_RUNTIME_KIND,
    capabilities: publicTenantCapabilities(capabilities),
    recentMessageCount: Math.min(20, messages.length),
  };
}

export async function buildTenantApiAgentInstructions(thread = {}, messages = [], env = process.env) {
  const context = await tenantContext(thread, messages, env);
  return [
    "You are the user-facing assistant for one Orkestr tenant chat.",
    "Be natural, concise, and helpful. Do not expose Orkestr internals, Codex runtime details, queues, tmux, shell paths, debug strings, or implementation wording unless the user explicitly asks about Orkestr operations.",
    "You are scoped to the tenant in the JSON context below. Do not claim access to files, Gmail, Outlook, LinkedIn, WhatsApp accounts, browser desktops, timers, or other chats unless the provided Orkestr tools or context show them for this tenant.",
    "Use the provided Orkestr tools for tenant-scoped resources. If the user asks whether Gmail, Outlook, Jira, Shopify, or WhatsApp is connected, available, enabled, or accessible, use the connector status tool before answering.",
    "If the user asks to connect, sign in, log in, set up, disconnect, or reconnect Gmail, Outlook, Jira, or Shopify, use the connector auth/disconnect tools and give the returned sign-in instructions.",
    "Connector setup is user-owned by default. When a connector is not connected or a matching capability is false, say that it is not connected for this chat yet and that you can help set it up here.",
    "Only say setup is unavailable on this Orkestr installation if a tool or Tenant context explicitly reports missing parent app/platform configuration. Even then, do not offer an admin note or tell the user to contact an admin unless the user explicitly asks how to escalate setup.",
    "If the user asks to use Gmail, Outlook, LinkedIn, files, or a browser desktop and the matching capability is false in the Tenant context JSON, say plainly that it is not connected or enabled for this chat yet. Do not imply that you checked it unless you used a tool.",
    "Do not tell contained users to open, check, or use the Orkestr UI for connector setup. This chat is the user surface; connector setup should happen through the sign-in instructions you provide in chat when parent app credentials exist.",
    "When asked what you can do or what skills you have, list only capabilities that are true in the Tenant context JSON and skills whose enabled field is true. Do not treat registryEnabled as availability; registryEnabled only means the user has not disabled the skill.",
    "Skills are unique per user and are described by the skill records in the Tenant context. Do not force provider categories, goals, or attachment models onto them; preserve the user's wording.",
    "Users manage skills through chat. When they ask to list, view, search, create, update, enable, disable, or delete skills, use the Orkestr skill tools.",
    "Do not create or update a skill for phishing, scams, credential theft, unauthorized login attempts, spam, or abuse. Refuse those requests instead of calling a tool.",
    "If asked for the WhatsApp number, WhatsApp account, connector ID, backend account, or controlled identity, do not reveal phone numbers, session IDs, account IDs, tokens, or connector internals. If WhatsApp is enabled, say you are connected to this chat through Orkestr and exact account details are admin-only.",
    "Never approve security, auth, browser-pairing, connector, or SSH challenges. Tell the user to use the trusted Orkestr approval flow or SSH command shown by Orkestr.",
    "If the user asks for code/workspace execution, ask them to send the same task with /codex to explicitly escalate to a contained Codex worker.",
    "",
    `Tenant context JSON: ${JSON.stringify(context)}`,
  ].join("\n");
}

async function postOpenAIResponse(body, env = process.env, fetchImpl = fetch, idempotencyKey = "") {
  const apiKey = clean(env.OPENAI_API_KEY || env.ORKESTR_OPENAI_API_KEY);
  if (!apiKey) {
    const error = new Error("openai_api_key_required");
    error.statusCode = 503;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiAgentTimeoutMs(env));
  try {
    const response = await fetchImpl(`${openAIBaseUrl(env)}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.error || `openai_response_failed_${response.status}`);
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("openai_response_timeout");
      timeout.statusCode = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function recordResponseUsage({ response, thread, message, callKind, status = "completed", error = "" }, env = process.env) {
  const usage = response?.usage || {};
  return recordCreditUsage({
    tenantId: threadOwnerUserId(thread, env),
    threadId: thread.id,
    messageId: message.id,
    responseId: clean(response?.id),
    runtimeKind: API_AGENT_RUNTIME_KIND,
    sourceChannel: sourceChannelForMessage(message),
    callKind,
    model: clean(response?.model) || apiAgentModel(env),
    usage,
    toolCallCount: responseFunctionCalls(response).length,
    status,
    error,
    estimatedCostUsd: estimateOpenAICost({ model: clean(response?.model) || apiAgentModel(env), usage }, env),
  }, env);
}

function userSafeApiAgentError(error) {
  const code = clean(error?.sanitizer?.reason || error?.message || error);
  const lowered = lower(code);
  if (code.includes("budget_exceeded")) return "I can't answer right now because this chat has reached its OpenAI usage budget. Ask an admin to raise the limit or try again later.";
  if (code.includes("openai_api_key_required")) return "This chat is not connected to the OpenAI API yet. Ask an admin to configure the API-agent key in Orkestr.";
  if (lowered.includes("gmail_oauth_config_required")) return "Gmail sign-in is not available on this Orkestr installation yet because the Gmail app credentials are not configured.";
  if (lowered.includes("gmail")) return "Gmail is not connected or enabled for this chat yet. Ask me to connect Gmail and I will send a Google sign-in link.";
  if (lowered.includes("outlook")) return "Outlook is not connected or enabled for this chat yet. Ask me to connect Outlook and I will send Microsoft sign-in instructions.";
  if (lowered.includes("linkedin") || lowered.includes("desktop")) return "The managed desktop is not connected or enabled for this chat yet. Ask the Orkestr admin to enable the desktop for this user, then resend.";
  if (lowered.includes("whatsapp") || lowered.includes("connector") || lowered.includes("account identity") || lowered.includes("capability")) {
    return "I can use this WhatsApp chat, but I can't expose backend WhatsApp account or connector identity from here. Ask the Orkestr admin to check connector settings.";
  }
  if (code.includes("sanitizer") || error?.sanitizer) return "I couldn't safely verify this request, so I did not run it. Please try a simpler request or ask an admin to check the sanitizer setup.";
  return "I couldn't complete this request right now. Please try again in a moment.";
}

function explicitCodexEscalation(text = "") {
  return /^\/codex(?:\s+|$)/i.test(String(text || "").trim());
}

async function handleCodexEscalation(thread, message, env = process.env) {
  const task = clean(message.text).replace(/^\/codex\s*/i, "").trim();
  const updated = await updateThread(thread.id, {
    runtimeKind: "codex-app-server",
    executorId: "codex",
    executor: {
      ...(thread.executor || {}),
      type: "codex",
      metadata: {
        ...(thread.executor?.metadata || {}),
        runtimeKind: "codex-app-server",
      },
    },
  }, env);
  await updateThreadMessage(thread.id, message.id, {
    text: task || message.text,
    state: "queued",
    deliveryState: "codex_escalated",
    observedVia: "api_agent_codex_escalation",
  }, env);
  await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "I moved this request to a contained Codex worker for workspace execution.",
    parentMessageId: message.id,
    state: "completed",
    connector: message.connector,
    chatId: message.chatId,
    accountId: message.accountId,
  }, env);
  await startCodexAppServerThread(updated, env).catch(() => null);
  await appendEvent({ type: "api_agent_codex_escalated", threadId: thread.id, messageId: message.id, ownerUserId: threadOwnerUserId(thread, env) }, env).catch(() => {});
  return { escalated: true, thread: updated };
}

async function runTenantApiAgentResponse({ thread, messages, message, env, fetchImpl }) {
  const model = apiAgentModel(env);
  const principal = tenantPrincipalForThread(thread, env);
  const instructions = await buildTenantApiAgentInstructions(thread, messages, env);
  const input = messages
    .filter((item) => clean(item.text || item.promptFile))
    .slice(-20)
    .map(messageInputItem);
  const tools = tenantApiAgentToolDefinitions();
  const baseBody = {
    model,
    instructions,
    input,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_output_tokens: maxOutputTokens(env),
    metadata: {
      orkestr_runtime: API_AGENT_RUNTIME_KIND,
      tenant_id: threadOwnerUserId(thread, env),
      thread_id: clean(thread.id).slice(0, 128),
      message_id: clean(message.id).slice(0, 128),
    },
    safety_identifier: `orkestr:${threadOwnerUserId(thread, env)}`,
    store: false,
  };

  const first = await postOpenAIResponse(baseBody, env, fetchImpl, `orkestr-${thread.id}-${message.id}-1`);
  await recordResponseUsage({ response: first, thread, message, callKind: "assistant" }, env);
  const calls = responseFunctionCalls(first);
  if (!calls.length) return { response: first, text: responseText(first) };

  const toolInput = [...input, ...responseFunctionCallInputItems(first)];
  for (const call of calls.slice(0, 3)) {
    let output = {};
    try {
      const args = JSON.parse(call.arguments || "{}");
      await assertSanitizedAction({
        action: `api-agent.tool.${call.name}`,
        principal,
        resource: {
          type: "thread",
          id: thread.id,
          ownerUserId: threadOwnerUserId(thread, env),
          capabilities: await scopedCapabilitiesForThread(thread, env),
        },
        input: { tool: call.name, args },
      }, env);
      output = await runTenantApiAgentTool(call.name, args, { principal, thread, fetchImpl }, env);
    } catch (error) {
      output = { ok: false, error: clean(error?.message || error || "tool_failed") };
    }
    toolInput.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(output).slice(0, 30_000),
    });
  }
  const second = await postOpenAIResponse({
    ...baseBody,
    input: toolInput,
  }, env, fetchImpl, `orkestr-${thread.id}-${message.id}-2`);
  await recordResponseUsage({ response: second, thread, message, callKind: "assistant_tool_result" }, env);
  return { response: second, text: responseText(second) };
}

function apiAgentBatchLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_MAX_BATCH_MESSAGES || 5);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(25, Math.floor(parsed))) : 5;
}

async function failApiAgentMessage(thread, error, env = process.env) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const message = messages.find((item) => lower(item.role) === "user" && lower(item.state) === "running") ||
    messages.find((item) => lower(item.role) === "user" && ["queued", "pending_delivery"].includes(lower(item.state || "queued")));
  if (!message) {
    await updateThread(thread.id, { state: "ready" }, env).catch(() => {});
    throw error;
  }
  await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "api_agent_failed",
    observedVia: "api_agent_error",
    error: clean(error?.message || error),
  }, env).catch(() => null);
  await appendTurnLifecycleEvent("failed", {
    threadId: thread.id,
    messageId: message.id,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    state: "failed",
    source: "api-agent",
    reason: clean(error?.message || error),
  }, env).catch(() => null);
  const assistant = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: userSafeApiAgentError(error),
    parentMessageId: message.id,
    state: "completed",
    connector: message.connector,
    chatId: message.chatId,
    accountId: message.accountId,
  }, env).catch(() => null);
  await recordCreditUsage({
    tenantId: threadOwnerUserId(thread, env),
    threadId: thread.id,
    messageId: message.id,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    sourceChannel: sourceChannelForMessage(message),
    callKind: "assistant_error",
    model: apiAgentModel(env),
    status: "failed",
    error: clean(error?.message || error),
    estimatedCostUsd: 0,
  }, env).catch(() => null);
  await updateThread(thread.id, { state: "ready" }, env).catch(() => {});
  return { ok: false, error: clean(error?.message || error), message, assistant };
}

async function completeApiAgentMessage(thread, message, text, env = process.env, options = {}) {
  const current = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia: options.observedVia || "api_agent_response",
    deliveredAt: nowIso(),
    error: null,
  }, env);
  const assistant = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text,
    parentMessageId: message.id,
    state: "completed",
    connector: message.connector,
    chatId: message.chatId,
    accountId: message.accountId,
  }, env);
  await updateThread(thread.id, { state: "ready" }, env).catch(() => {});
  await appendTurnLifecycleEvent("completed", {
    threadId: thread.id,
    messageId: message.id,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    state: "completed",
    source: "api-agent",
  }, env).catch(() => {});
  await appendEvent({
    type: options.eventType || "api_agent_response_completed",
    threadId: thread.id,
    messageId: message.id,
    assistantMessageId: assistant.id,
    ownerUserId: threadOwnerUserId(thread, env),
    ...(options.event || {}),
  }, env).catch(() => {});
  return { ok: true, processed: true, message: current, assistant, response: options.response || null };
}

async function processNextApiAgentMessage(thread, env = process.env, options = {}) {
  const messages = await listThreadMessages(thread.id, env);
  const message = messages.find((item) => lower(item.role) === "user" && ["queued", "pending_delivery"].includes(lower(item.state || "queued")));
  if (!message) return { ok: true, processed: false, reason: "no_queued_message" };
  if (explicitCodexEscalation(message.text)) {
    return handleCodexEscalation(thread, message, env);
  }
  const principal = tenantPrincipalForThread(thread, env);
  const capabilities = await scopedCapabilitiesForThread(thread, env);
  if (!isAdminPrincipal(principal)) {
    await assertSanitizedAction({
      action: "api-agent.input",
      principal,
      resource: {
        type: "thread",
        id: thread.id,
        ownerUserId: threadOwnerUserId(thread, env),
        capabilities,
      },
      input: {
        text: clean(message.text).slice(0, 8000),
        source: message.source || "",
        connector: message.connector || "",
      },
    }, env);
  }
  await assertCreditBudget(threadOwnerUserId(thread, env), apiAgentBudgetPreflightUsd(env), env);
  await updateThreadMessage(thread.id, message.id, {
    state: "running",
    deliveryState: "api_agent_running",
    observedVia: "api_agent",
    deliveredAt: nowIso(),
  }, env);
  await updateThread(thread.id, { state: "working" }, env).catch(() => {});
  await appendTurnLifecycleEvent("started", {
    threadId: thread.id,
    messageId: message.id,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    state: "running",
    source: "api-agent",
  }, env).catch(() => {});
  const latestMessages = await listThreadMessages(thread.id, env);
  const result = await runTenantApiAgentResponse({
    thread,
    messages: latestMessages,
    message,
    env,
    fetchImpl: options.fetchImpl || fetch,
  });
  const text = normalizeTenantApiAgentText(clean(result.text) || "Done.");
  return completeApiAgentMessage(thread, message, text, env, { response: result.response });
}

export async function processApiAgentThreadInput(threadId, env = process.env, options = {}) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (!threadUsesApiAgent(thread, env)) return { ok: false, skipped: true, reason: "not_api_agent" };
  if (apiAgentRunning.has(thread.id)) return { ok: true, running: true };
  apiAgentRunning.add(thread.id);
  try {
    const results = [];
    for (let index = 0; index < apiAgentBatchLimit(env); index += 1) {
      const result = await processNextApiAgentMessage(thread, env, options);
      if (result.processed) results.push(result);
      if (!result.processed || result.ok === false || result.escalated) {
        return results.length ? { ...result, results, processedCount: results.length } : result;
      }
    }
    return { ok: true, processed: true, results, processedCount: results.length, batchLimitReached: true };
  } catch (error) {
    return failApiAgentMessage(thread, error, env);
  } finally {
    apiAgentRunning.delete(thread.id);
  }
}
