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
  return {
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

function responseFunctionCalls(response = {}) {
  return (Array.isArray(response.output) ? response.output : []).filter((item) => item?.type === "function_call" && clean(item.name));
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

function publicSkillContext(skills = []) {
  return (Array.isArray(skills) ? skills : []).slice(0, 50).map((skill) => ({
    id: clean(skill.id),
    name: clean(skill.name || skill.label || skill.id),
    description: clean(skill.description || skill.summary).slice(0, 1000),
    instructions: clean(skill.instructions).slice(0, 3000),
    enabled: skill.enabled === true,
    builtIn: skill.builtIn === true,
    requiresConnector: clean(skill.requiresConnector),
    requiresDesktop: clean(skill.requiresDesktop),
  })).filter((skill) => skill.id);
}

function publicTenantCapabilities(capabilities = {}) {
  const scopedConnectors = capabilities.scopedConnectors && typeof capabilities.scopedConnectors === "object" ? capabilities.scopedConnectors : {};
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
    enabledSkills: Array.isArray(capabilities.enabledSkills) ? [...capabilities.enabledSkills] : [],
    disabledSkills: Array.isArray(capabilities.disabledSkills) ? [...capabilities.disabledSkills] : [],
    skills: publicSkillContext(capabilities.skills),
    scopedConnectors: {
      whatsapp: scopedConnectors.whatsapp === true || capabilities.whatsapp === true,
      gmail: scopedConnectors.gmail === true,
      outlook: scopedConnectors.outlook === true,
      linkedin: scopedConnectors.linkedin === true,
    },
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
    "Use the provided Orkestr tools for tenant-scoped resources. If a connector or permission is missing, say what needs to be connected in Orkestr.",
    "If the user asks to use Gmail, Outlook, LinkedIn, files, or a browser desktop and the matching capability is false in the Tenant context JSON, say plainly that it is not connected or enabled for this chat yet. Do not imply that you checked it.",
    "When asked what you can do, list only capabilities that are true in the Tenant context JSON. Do not mention unavailable capabilities as if they are connected.",
    "Skills are unique per user and are described by the skill records in the Tenant context. Do not force provider categories, goals, or attachment models onto them; preserve the user's wording.",
    "Users manage skills through chat. When they ask to list, view, search, create, update, enable, disable, or delete skills, use the Orkestr skill tools.",
    "Do not create or update a skill for phishing, scams, credential theft, unauthorized login attempts, spam, or abuse. Refuse those requests instead of calling a tool.",
    "If asked for the WhatsApp number, WhatsApp account, connector ID, backend account, or controlled identity, do not reveal phone numbers, session IDs, account IDs, tokens, or connector internals. If WhatsApp is enabled, say you are connected to this chat through Orkestr and exact account details are admin-only.",
    "Never approve security, auth, browser-pairing, connector, or SSH challenges. Tell the user to use the trusted Orkestr UI or SSH command shown by Orkestr.",
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
  if (lowered.includes("gmail")) return "Gmail is not connected or enabled for this chat yet. Ask the Orkestr admin to connect Gmail for this user, then resend.";
  if (lowered.includes("outlook")) return "Outlook is not connected or enabled for this chat yet. Ask the Orkestr admin to connect Outlook for this user, then resend.";
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

  const toolInput = [...input, ...(Array.isArray(first.output) ? first.output : [])];
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
      output = await runTenantApiAgentTool(call.name, args, { principal, thread }, env);
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

async function processNextApiAgentMessage(thread, env = process.env, options = {}) {
  const messages = await listThreadMessages(thread.id, env);
  const message = messages.find((item) => lower(item.role) === "user" && ["queued", "pending_delivery"].includes(lower(item.state || "queued")));
  if (!message) return { ok: true, processed: false, reason: "no_queued_message" };
  if (explicitCodexEscalation(message.text)) {
    return handleCodexEscalation(thread, message, env);
  }
  const principal = tenantPrincipalForThread(thread, env);
  if (!isAdminPrincipal(principal)) {
    const capabilities = await scopedCapabilitiesForThread(thread, env);
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
  const latestMessages = await listThreadMessages(thread.id, env);
  const result = await runTenantApiAgentResponse({
    thread,
    messages: latestMessages,
    message,
    env,
    fetchImpl: options.fetchImpl || fetch,
  });
  const text = clean(result.text) || "Done.";
  const current = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia: "api_agent_response",
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
  await appendEvent({ type: "api_agent_response_completed", threadId: thread.id, messageId: message.id, assistantMessageId: assistant.id, ownerUserId: threadOwnerUserId(thread, env) }, env).catch(() => {});
  return { ok: true, processed: true, message: current, assistant, response: result.response };
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
