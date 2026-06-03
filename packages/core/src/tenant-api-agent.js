import { appendEvent } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { isAdminPrincipal } from "./policy.js";
import { userPrincipal } from "./principal.js";
import { assertCreditBudget, estimateOpenAICost, recordCreditUsage } from "./credit-usage.js";
import { startCodexAppServerThread, threadUsesCodexAppServer } from "./codex-app-server.js";
import { tenantApiAgentToolDefinitions, runTenantApiAgentTool } from "./tenant-api-agent-tools.js";
import { threadRequiresTenantIsolation } from "./tenant-policy.js";
import { appendThreadMessage, getThread, listThreadMessages, updateThread, updateThreadMessage } from "./threads.js";
import { readUserOnboardingState } from "./user-onboarding.js";
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

function codexEscalationAvailable(env = process.env) {
  const runtimeCommand = clean(env.ORKESTR_RUNTIME_CODEX_COMMAND);
  const codexBin = clean(env.ORKESTR_CODEX_BIN);
  if (/^__orkestr_codex_disabled/i.test(runtimeCommand)) return false;
  if (/^__orkestr_codex_disabled/i.test(codexBin)) return false;
  if (["0", "false", "off", "no"].includes(lower(env.ORKESTR_CODEX_ESCALATION_ENABLED))) return false;
  return true;
}

function falsey(value = "") {
  return ["0", "false", "off", "no"].includes(lower(value));
}

function webFetchAvailable(env = process.env) {
  return !falsey(env.ORKESTR_API_AGENT_WEB_FETCH_ENABLED);
}

function codexEscalationSentence(env = process.env) {
  return codexEscalationAvailable(env)
    ? "For workspace execution, send the task with /codex."
    : "Workspace and live browser execution are not available in this chat right now.";
}

function threadRuntimeKind(thread = {}) {
  return lower(thread.runtimeKind || thread.runtime?.runtimeKind || thread.executor?.metadata?.runtimeKind);
}

function threadOwnerUserId(thread = {}, env = process.env) {
  return normalizeUserId(thread.ownerUserId || thread.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function tenantPrincipalForThread(thread = {}, env = process.env) {
  const ownerUserId = threadOwnerUserId(thread, env);
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

function weakTenantApiAgentText(text = "") {
  const value = clean(text);
  return !value || /^(?:done|ok|okay|sure|yes|no|acknowledged|completed|finished|handled)[.!?]*$/i.test(value);
}

function bareConfirmationText(text = "") {
  const value = clean(text);
  if (!value || /[?]/.test(value)) return false;
  const normalized = lower(value)
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:yes|yeah|yep|y|ok|okay|sure|please|please do|do it|go ahead|proceed|confirmed|confirm|yes and yes)$/i.test(normalized)) return true;
  return /^(?:yes|yeah|yep|ok|okay|sure)\b/.test(normalized) && normalized.length <= 80;
}

function assistantOfferedAction(text = "") {
  const value = clean(text);
  if (!value) return false;
  const offered = /\b(?:shall i|should i|would you like me to|do you want me to|want me to|may i|tell me if you want|reply\s+(?:yes|ok|go ahead))\b/i.test(value);
  const action = /\b(?:open|start|prepare|fetch|gather|check|search|inspect|visit|summari[sz]e|translate|read|look up|find|run|connect|send)\b/i.test(value);
  const capability = /\b(?:desktop|browser|skill|gmail|outlook|jira|shopify|whatsapp|file|timer|managed|connector|linkedin|url|site|web)\b/i.test(value) ||
    /https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(value);
  return offered && action && capability;
}

function assistantPromisesUnconfirmedAction(text = "") {
  const value = clean(text);
  if (!value) return false;
  const promise = /\b(?:i(?:'|’)?ll|i\s+will|i(?:'|’)?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|i\s+can\s+(?:open|start|prepare|fetch|gather|check|search|inspect|visit|summari[sz]e|translate|read|look up|find|run|connect|send)|(?:can|able\s+to)\s+(?:open|start|prepare|fetch|gather|collect|check|search|inspect|visit|summari[sz]e|translate|read|look up|find|run|connect|send))\b/i.test(value);
  const action = /\b(?:open|start|prepare|fetch|gather|collect|check|search|inspect|visit|summari[sz]e|translate|read|look up|find|run|connect|send)\b/i.test(value);
  const externalState = /\b(?:desktop|browser|site|url|web|gmail|outlook|jira|shopify|whatsapp|linkedin|page contents?|trending topics?|top entries|translations?|login state|research)\b/i.test(value) ||
    /https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(value);
  return promise && action && externalState;
}

function assistantMentionsUnavailableCodex(text = "", env = process.env) {
  return !codexEscalationAvailable(env) && /(^|\s)\/codex(?:\s|$|[.!?,;:])/i.test(clean(text));
}

function pendingActionConfirmation(messages = [], message = {}) {
  if (!bareConfirmationText(message.text)) return null;
  const index = messages.findIndex((item) => item.id === message.id);
  const previous = (index >= 0 ? messages.slice(0, index) : messages)
    .slice()
    .reverse()
    .find((item) => lower(item.role) === "assistant" && clean(item.text));
  if (!previous || !assistantOfferedAction(previous.text)) return null;
  return {
    previousAssistantMessageId: clean(previous.id),
    previousAssistantText: clean(previous.text).replace(/\s+/g, " ").slice(0, 1200),
    confirmationText: clean(message.text).replace(/\s+/g, " ").slice(0, 500),
  };
}

function userMessageNeedsSubstantiveAnswer(text = "") {
  const value = clean(text);
  if (!value) return false;
  if (/[?]/.test(value)) return true;
  if (/^(?:who|what|why|how|when|where|which|can|could|would|should|do|does|did|is|are|am|will|tell|explain|help)\b/i.test(value)) return true;
  if (/\b(?:who am i|what can you do|how can you help|what skills|which skills)\b/i.test(value)) return true;
  if (/\b(?:i am|i['"]m|im|my name is|call me)\s+[a-z]/i.test(value)) return true;
  return false;
}

function tenantApiAgentTextNeedsRepair(text = "", message = {}, options = {}) {
  if (weakTenantApiAgentText(text) && (
    userMessageNeedsSubstantiveAnswer(message.text) ||
    bareConfirmationText(message.text) ||
    options.pendingActionConfirmation === true
  )) return true;
  if (assistantMentionsUnavailableCodex(text, options.env)) return true;
  return assistantPromisesUnconfirmedAction(text);
}

function introducedName(text = "") {
  const match = clean(text).match(/\b(?:i am|i['"]m|im|my name is|call me)\s+([a-z][a-z .'-]{0,48})/i);
  if (!match) return "";
  return clean(match[1])
    .replace(/[.?!,;:].*$/g, "")
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

function fallbackWeakTenantApiAgentAnswer(message = {}, env = process.env) {
  const text = clean(message.text);
  const name = introducedName(text);
  if (name) {
    return `Got it, ${name}. I can help in this chat with questions, planning, drafting, and tenant features that are connected for this user. ${codexEscalationSentence(env)}`;
  }
  if (/\bwho\s+am\s+i\b/i.test(text)) {
    return "You are the person messaging this Orkestr chat. I can use identity details you share in this conversation, but I will not guess private profile details.";
  }
  if (/\b(?:what can you do|how can you help|what skills|which skills)\b/i.test(text)) {
    return `I can help in this chat with questions, planning, drafting, and tenant features that are connected for this user. ${codexEscalationSentence(env)}`;
  }
  if (bareConfirmationText(text)) {
    return `I do not have a confirmed action to complete from that message alone. Tell me the specific task you want. ${codexEscalationSentence(env)}`;
  }
  return `I can help in this chat. Tell me what you want to do. ${codexEscalationSentence(env)}`;
}

function fallbackPendingActionConfirmationAnswer(env = process.env) {
  return `I can't mark that as done yet. I need to run an available Orkestr skill action first, and I can only report what a tool result confirms. ${codexEscalationSentence(env)}`;
}

function fallbackUnconfirmedActionAnswer(env = process.env) {
  return `I can't truthfully complete or claim external browser, workspace, file, or account work from this chat without a tool result. ${codexEscalationSentence(env)}`;
}

function fallbackTenantApiAgentRepairAnswer(message = {}, options = {}) {
  const env = options.env || process.env;
  if (options.pendingActionConfirmation === true) return fallbackPendingActionConfirmationAnswer(env);
  if (assistantPromisesUnconfirmedAction(options.originalText) || assistantPromisesUnconfirmedAction(options.repairedText)) {
    return fallbackUnconfirmedActionAnswer(env);
  }
  return fallbackWeakTenantApiAgentAnswer(message, env);
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

function publicWebContentRequest(text = "") {
  const value = clean(text);
  if (!value) return false;
  if (/https?:\/\/|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i.test(value)) return true;
  return /\b(?:fetch|check|open|read|inspect|summari[sz]e|look up|visit|tell me|what are|top|trending|gundem|gündem|topics?|links?|entries?|page|site|web)\b/i.test(value) &&
    /\b(?:public|website|site|web|page|url|link|news|trending|topics?|entries?|gundem|gündem|eksi|ekşi|sozluk|sözlük)\b/i.test(value);
}

function publicWebFetchTargetForMessage(text = "") {
  const value = clean(text);
  if (!publicWebContentRequest(value)) return null;
  const explicitUrl = value.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
  if (explicitUrl) return { url: explicitUrl, maxLinks: 80, maxChars: 20_000, reason: "explicit_url" };
  const domainPath = value.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s<>"')]+)?/i);
  if (domainPath) return { url: `https://${domainPath[1]}${domainPath[2] || "/"}`, maxLinks: 80, maxChars: 20_000, reason: "domain" };
  if (/\b(?:eksi|ekşi)\s*(?:sozluk|sözlük)\b/i.test(value) && /\b(?:gundem|gündem|trending|topics?|başlıklar|basliklar|top)\b/i.test(value)) {
    return { url: "https://eksisozluk.com/basliklar/gundem", maxLinks: 80, maxChars: 20_000, reason: "eksi_gundem" };
  }
  return null;
}

function countedWebTextLines(text = "", limit = 10) {
  const seen = new Set();
  const entries = [];
  for (const rawLine of String(text || "").split(/\r?\n/g)) {
    const line = clean(rawLine).replace(/\s+/g, " ");
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(.{2,140}?)\s+(\d{1,6})$/);
    if (!match) continue;
    const label = clean(match[1]);
    const count = Number(match[2]);
    const key = lower(label);
    if (!label || !Number.isFinite(count) || seen.has(key)) continue;
    seen.add(key);
    entries.push({ label, count });
    if (entries.length >= limit) break;
  }
  return entries;
}

function fallbackWebFetchToolAnswer(toolOutputs = []) {
  const output = toolOutputs.find((item) => item?.ok === true && (clean(item.text) || Array.isArray(item.links)));
  if (!output) return "";
  const countedLinks = (Array.isArray(output.links) ? output.links : [])
    .map((link) => ({ label: clean(link.text), count: Number(link.count) }))
    .filter((entry) => entry.label && Number.isFinite(entry.count) && entry.count > 0)
    .filter((entry, index, all) => all.findIndex((candidate) => lower(candidate.label) === lower(entry.label)) === index)
    .slice(0, 10);
  if (countedLinks.length) {
    return [
      `Fetched ${clean(output.title) || clean(output.url) || "the public page"}. Top counted items I found:`,
      ...countedLinks.map((entry, index) => `${index + 1}. ${entry.label} (${entry.count})`),
    ].join("\n");
  }
  const entries = countedWebTextLines(output.text, 10);
  if (entries.length) {
    return [
      `Fetched ${clean(output.title) || clean(output.url) || "the public page"}. Top counted items I found:`,
      ...entries.map((entry, index) => `${index + 1}. ${entry.label} (${entry.count})`),
    ].join("\n");
  }
  const links = (Array.isArray(output.links) ? output.links : [])
    .map((link) => clean(link.text))
    .filter(Boolean)
    .filter((text, index, all) => all.findIndex((candidate) => lower(candidate) === lower(text)) === index)
    .slice(0, 10);
  if (links.length) {
    return [
      `Fetched ${clean(output.title) || clean(output.url) || "the public page"}. Links I found:`,
      ...links.map((label, index) => `${index + 1}. ${label}`),
    ].join("\n");
  }
  const text = clean(output.text).slice(0, 1200);
  return text ? `Fetched ${clean(output.title) || clean(output.url) || "the public page"}:\n${text}` : "";
}

function webFetchLooksLikeBrowserChallenge(output = {}) {
  const text = lower([
    output.title,
    output.text,
    ...(Array.isArray(output.links) ? output.links.map((link) => link.text) : []),
  ].filter(Boolean).join(" "));
  return /\b(?:cloudflare|checking your browser|just a moment|attention required|verify you are human|captcha|ddos-guard|enable cookies|access denied)\b/i.test(text);
}

function webFetchDirectAnswerUsable(output = {}, answer = "") {
  if (!output?.ok || !clean(answer)) return false;
  if (webFetchLooksLikeBrowserChallenge(output)) return false;
  const links = Array.isArray(output.links) ? output.links.filter((link) => clean(link.text)) : [];
  return links.length > 0 || clean(output.text).length >= 40;
}

function webFetchDesktopFallbackAllowed(output = {}) {
  const error = clean(output?.error);
  if (!error) return true;
  return !/(?:url_host_forbidden|url_resolves_to_forbidden_address|unsupported_url_protocol|invalid_url|private|localhost|loopback)/i.test(error);
}

function webFetchIssue(output = {}) {
  if (webFetchLooksLikeBrowserChallenge(output)) return "the public fetch looked like a browser challenge";
  if (output?.ok === false) return clean(output.error || "web_fetch_failed");
  return "the public fetch did not return useful page contents";
}

async function openPublicWebFetchInDesktop({ target, output, thread, principal, env, fetchImpl }) {
  if (!webFetchDesktopFallbackAllowed(output)) return "";
  const args = { skillId: "linkedin", action: "open_url", target: "", url: clean(target?.url) };
  let opened = null;
  try {
    await assertSanitizedAction({
      action: "api-agent.tool.orkestr_run_skill_action",
      principal,
      resource: {
        type: "thread",
        id: thread.id,
        ownerUserId: threadOwnerUserId(thread, env),
        capabilities: await scopedCapabilitiesForThread(thread, env),
      },
      input: { tool: "orkestr_run_skill_action", args },
    }, env);
    opened = await runTenantApiAgentTool("orkestr_run_skill_action", args, { principal, thread, fetchImpl }, env);
  } catch (error) {
    opened = { ok: false, error: clean(error?.message || error || "desktop_fallback_failed") };
  }
  if (opened?.ok === false || clean(opened?.error)) {
    return `I couldn't fetch useful page contents from this chat (${webFetchIssue(output)}), and the managed desktop fallback could not open it: ${clean(opened.error || "desktop_fallback_failed")}.`;
  }
  const desktop = opened.desktop || {};
  const desktopLabel = clean(desktop.label || desktop.slug || "the managed desktop");
  const openedUrl = clean(opened.openedUrl || opened.url || target?.url);
  return [
    `I couldn't fetch useful page contents from this chat (${webFetchIssue(output)}), so I opened ${openedUrl || clean(target?.url)} in ${desktopLabel}.`,
    "The desktop action only confirms that the URL was opened; it does not return page contents or login state.",
  ].join("\n");
}

function providerLabel(provider = "") {
  const id = lower(provider);
  if (id === "gmail") return "Gmail";
  if (id === "outlook") return "Outlook";
  if (id === "jira") return "Jira";
  if (id === "shopify") return "Shopify";
  if (id === "whatsapp") return "WhatsApp";
  return clean(provider) || "Connector";
}

function genericToolFallbackText(text = "") {
  return /without a tool result|can't truthfully complete|cannot truthfully complete|workspace and live browser execution are not available|tell me what you want to do/i.test(clean(text));
}

function formatConnectorStatusTool(result = {}) {
  const output = result.output || {};
  const args = result.args || {};
  const provider = providerLabel(output.provider || args.provider);
  const state = clean(output.state || output.error || "unknown");
  if (output.ok === false || clean(output.error)) {
    const error = clean(output.error);
    if (/config_required|config_missing|parent_config_missing|oauth_config/i.test(error)) {
      return `${provider} is not available for sign-in yet because the parent app configuration is missing on this Orkestr installation.`;
    }
    if (/capability\s+is\s+false|capability_not_available|not\s+enabled|not\s+connected/i.test(error)) {
      return `${provider} is not connected or enabled for this chat yet.`;
    }
    return `${provider} status could not be checked: ${error || "tool_failed"}.`;
  }
  if (output.connected === true) return `${provider} is connected for this chat.`;
  if (state === "pending" || state === "authorization_url_ready") {
    return `${provider} sign-in is pending for this chat. Finish the existing sign-in flow, then ask me to check again.`;
  }
  if (state === "parent_config_missing" || state === "parent_config_partial") {
    return `${provider} is not connected for this chat. ${provider} app configuration is missing on this Orkestr installation, so I cannot start sign-in yet.`;
  }
  if (output.parentConnector?.parentAppConfigured === true || output.parentConnector?.parentAppPartiallyConfigured === true) {
    return `${provider} is not connected for this chat yet. I can help start the ${provider} sign-in flow from here.`;
  }
  if (clean(output.message)) return clean(output.message);
  return `${provider} is not connected for this chat yet.`;
}

function formatConnectorAuthTool(result = {}) {
  const output = result.output || {};
  const args = result.args || {};
  const provider = providerLabel(output.provider || args.provider);
  if (output.ok === false || clean(output.error)) {
    const error = clean(output.error);
    if (/config_required|config_missing|parent_config_missing|oauth_config/i.test(error)) {
      return `${provider} sign-in is not available yet because the parent app configuration is missing on this Orkestr installation.`;
    }
    if (/shopify_shop_required/i.test(error)) return "Shopify sign-in needs a shop name first.";
    return `${provider} sign-in could not be started: ${error || "tool_failed"}.`;
  }
  const authorizeUrl = clean(output.authorizeUrl || output.url);
  const verificationUri = clean(output.verificationUri || output.verification_uri || output.verificationUrl);
  const userCode = clean(output.userCode || output.user_code);
  if (authorizeUrl) {
    return [
      `${provider} sign-in is ready.`,
      `Open this link to finish authorization: ${authorizeUrl}`,
    ].join("\n");
  }
  if (verificationUri || userCode) {
    return [
      `${provider} sign-in is ready.`,
      verificationUri ? `Open: ${verificationUri}` : "",
      userCode ? `Enter code: ${userCode}` : "",
    ].filter(Boolean).join("\n");
  }
  if (clean(output.message)) return clean(output.message);
  return `${provider} sign-in flow was started.`;
}

function skillLabel(skill = {}) {
  return clean(skill.name || skill.label || skill.id || "Skill");
}

function formatSkillActionsTool(result = {}, context = {}) {
  const output = result.output || {};
  const skills = Array.isArray(output.skills) ? output.skills : [];
  if (output.ok === false || clean(output.error)) return `Skill actions could not be checked: ${clean(output.error || "tool_failed")}.`;
  if (!skills.length) return "No matching enabled skill was found for this chat.";
  const lines = [];
  for (const skill of skills.slice(0, 6)) {
    const available = skill.available === true || skill.enabled === true;
    lines.push(`${skillLabel(skill)} is ${available ? "available" : "not available"} for this chat.`);
    if (clean(skill.setupState) && !available) lines.push(`Reason: ${clean(skill.setupState)}.`);
    const actions = Array.isArray(skill.availableActions) ? skill.availableActions.map(clean).filter(Boolean) : [];
    if (actions.length) lines.push(`Available actions: ${actions.join(", ")}.`);
    const desktops = Array.isArray(skill.desktops) ? skill.desktops : [];
    for (const desktop of desktops.slice(0, 2)) {
      lines.push(`${clean(desktop.label || desktop.slug || "Desktop")} is ${clean(desktop.state || desktop.status || "unknown")}${clean(desktop.url) ? ` at ${clean(desktop.url)}` : ""}.`);
    }
  }
  if (/\blogged\s*in|login|signed\s*in/i.test(clean(context.message?.text))) {
    lines.push("This status does not report login state, so I cannot confirm whether you are logged in.");
  }
  return lines.join("\n");
}

function formatRunSkillActionTool(result = {}, context = {}) {
  const output = result.output || {};
  const args = result.args || {};
  const action = clean(output.action || args.action || "action");
  const skill = output.skill || {};
  const label = skillLabel(skill);
  if (output.ok === false || clean(output.error)) {
    return `${label} ${action} could not be completed: ${clean(output.error || "tool_failed")}.`;
  }
  const desktop = output.desktop || {};
  const desktopLabel = clean(desktop.label || desktop.slug || label);
  const url = clean(output.openedUrl || output.url || desktop.url);
  const lines = [];
  if (action === "open_url") lines.push(`I opened ${url || "the requested URL"} in ${desktopLabel}.`);
  else if (action === "open" || action === "start") lines.push(`${desktopLabel} is open${url ? ` at ${url}` : ""}.`);
  else if (action === "prepare") lines.push(`${desktopLabel} is prepared.`);
  else if (action === "stop") lines.push(`${desktopLabel} was stopped.`);
  else if (action === "restart") lines.push(`${desktopLabel} was restarted.`);
  else lines.push(clean(output.message) || `${label} ${action} completed.`);
  if (/\blogged\s*in|login|signed\s*in/i.test(clean(context.message?.text))) {
    lines.push("The tool result only confirms the desktop action; it does not report login state, so I cannot confirm whether you are logged in.");
  } else if (/(page contents?|trending|entries|research|summary|summari[sz]e)/i.test(clean(context.message?.text))) {
    lines.push("The tool result only confirms the desktop action; it does not return page contents or research results.");
  }
  return lines.join("\n");
}

function formatListSkillsTool(result = {}) {
  const output = result.output || {};
  const skills = Array.isArray(output.skills) ? output.skills : [];
  if (!skills.length) return "";
  const enabled = skills.filter((skill) => skill.available === true || skill.enabled === true).slice(0, 8);
  if (!enabled.length) return "No skills are currently enabled for this chat.";
  return [
    "Enabled skills for this chat:",
    ...enabled.map((skill) => {
      const actions = Array.isArray(skill.availableActions) ? skill.availableActions.map(clean).filter(Boolean) : [];
      return `- ${skillLabel(skill)}${actions.length ? `: ${actions.join(", ")}` : ""}`;
    }),
  ].join("\n");
}

function formatGmailTool(result = {}) {
  const output = result.output || {};
  if (output.ok === false || clean(output.error)) {
    const error = clean(output.error);
    if (/gmail_not_connected|gmail/i.test(error)) return "Gmail is not connected or enabled for this chat yet.";
    return `Gmail could not be read: ${error || "tool_failed"}.`;
  }
  if (Array.isArray(output.messages)) {
    if (!output.messages.length) return "No matching Gmail messages were found.";
    return [
      `Found ${output.messages.length} Gmail message${output.messages.length === 1 ? "" : "s"}:`,
      ...output.messages.slice(0, 5).map((message) => `- ${clean(message.subject || "(no subject)")}${clean(message.from) ? ` from ${clean(message.from)}` : ""}${clean(message.date) ? ` (${clean(message.date)})` : ""}`),
    ].join("\n");
  }
  if (output.message) {
    const message = output.message;
    if (!message) return "No matching Gmail message was found.";
    return [
      `Gmail message: ${clean(message.subject || "(no subject)")}`,
      clean(message.from) ? `From: ${clean(message.from)}` : "",
      clean(message.snippet) ? `Snippet: ${clean(message.snippet)}` : "",
      clean(message.text) ? clean(message.text).slice(0, 1200) : "",
    ].filter(Boolean).join("\n");
  }
  return "";
}

function formatFileTool(result = {}) {
  const output = result.output || {};
  const name = result.name;
  if (output.ok === false || clean(output.error)) return `File tool failed: ${clean(output.error || "tool_failed")}.`;
  if (name === "orkestr_list_files") {
    const files = Array.isArray(output.entries || output.files) ? (output.entries || output.files) : [];
    return files.length ? [`Files:`, ...files.slice(0, 10).map((file) => `- ${clean(file.name || file.path || file)}`)].join("\n") : "No files were found.";
  }
  if (name === "orkestr_read_file") return `Read ${clean(output.path || "file")} (${output.size ?? clean(output.text).length} bytes):\n${clean(output.text).slice(0, 1200)}`;
  if (name === "orkestr_write_file") return `Wrote ${clean(output.path || "file")}${output.size !== undefined ? ` (${output.size} bytes)` : ""}.`;
  return "";
}

function formatTimerTool(result = {}) {
  const output = result.output || {};
  if (output.ok === false || clean(output.error)) return `Timer tool failed: ${clean(output.error || "tool_failed")}.`;
  if (Array.isArray(output.timers)) {
    return output.timers.length ? [`Timers:`, ...output.timers.slice(0, 10).map((timer) => `- ${clean(timer.label || timer.id)} (${clean(timer.cadence || timer.schedule || "timer")})`)].join("\n") : "No timers are configured for this chat.";
  }
  if (output.timer) return `Timer created: ${clean(output.timer.label || output.timer.id)}.`;
  if (output.event) return "Timer was run now.";
  if (output.ok !== undefined) return output.ok ? "Timer was updated." : "Timer action failed.";
  return "";
}

function formatToolResultFallback(toolResults = [], context = {}) {
  if (!Array.isArray(toolResults) || !toolResults.length) return "";
  const hasRunSkillAction = toolResults.some((result) => result.name === "orkestr_run_skill_action");
  const parts = [];
  for (const result of toolResults) {
    if (hasRunSkillAction && result.name === "orkestr_list_skill_actions") continue;
    let formatted = "";
    if (result.name === "orkestr_connector_status") formatted = formatConnectorStatusTool(result);
    else if (result.name === "orkestr_start_connector_auth") formatted = formatConnectorAuthTool(result);
    else if (result.name === "orkestr_disconnect_connector") formatted = formatConnectorStatusTool({ ...result, output: result.output?.status || result.output });
    else if (result.name === "orkestr_list_skill_actions") formatted = formatSkillActionsTool(result, context);
    else if (result.name === "orkestr_run_skill_action") formatted = formatRunSkillActionTool(result, context);
    else if (result.name === "orkestr_list_skills") formatted = formatListSkillsTool(result);
    else if (["orkestr_search_gmail", "orkestr_read_gmail_message", "orkestr_read_latest_gmail_message"].includes(result.name)) formatted = formatGmailTool(result);
    else if (["orkestr_list_files", "orkestr_read_file", "orkestr_write_file"].includes(result.name)) formatted = formatFileTool(result);
    else if (["orkestr_list_timers", "orkestr_create_timer", "orkestr_delete_timer", "orkestr_run_timer"].includes(result.name)) formatted = formatTimerTool(result);
    else if (result.name === "orkestr_fetch_web_page") formatted = fallbackWebFetchToolAnswer([result.output]);
    if (formatted) parts.push(formatted);
  }
  return parts.join("\n\n").trim();
}

function requestedNumberedItemCount(text = "") {
  const value = clean(text);
  const topMatch = value.match(/\btop\s+(\d{1,2})\b/i);
  if (topMatch) return Number(topMatch[1]) || 0;
  const countMatch = value.match(/\b(\d{1,2})\s+(?:topics?|items?|links?|entries?|results?)\b/i);
  return countMatch ? Number(countMatch[1]) || 0 : 0;
}

function numberedLineCount(text = "") {
  return String(text || "").split(/\r?\n/g).filter((line) => /^\s*\d+\.\s+\S/.test(line)).length;
}

function shouldPreferWebFetchFallback(modelText = "", fallbackText = "", message = {}) {
  const requested = requestedNumberedItemCount(message.text);
  if (!requested) return false;
  const modelCount = numberedLineCount(modelText);
  const fallbackCount = numberedLineCount(fallbackText);
  return fallbackCount > modelCount && fallbackCount >= Math.min(requested, 10);
}

function sourceChannelForMessage(message = {}) {
  return clean(message.connector || message.originSurface || message.source || "");
}

function sourceChannelForThread(thread = {}) {
  return thread.binding?.connector === "whatsapp" || thread.binding?.chatId ? "whatsapp" : "web";
}

function publicThreadLabel(thread = {}) {
  return clean(thread.bindingName || thread.binding?.displayName || thread.name || thread.title || thread.id);
}

function publicChatContext(thread = {}) {
  const binding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const channel = sourceChannelForThread(thread);
  const chatName = clean(binding.displayName || thread.bindingName || thread.name || thread.title);
  return {
    channel,
    surface: channel === "whatsapp" ? "WhatsApp chat" : "web chat",
    chatName: chatName || null,
    threadLabel: publicThreadLabel(thread) || null,
    connector: clean(binding.connector) || (channel === "whatsapp" ? "whatsapp" : ""),
    hasChatBinding: Boolean(binding.chatId || binding.connector),
  };
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

function publicSkillActionHints(skill = {}, available = false) {
  const id = clean(skill.id).toLowerCase();
  if (!available) return ["status"];
  if (clean(skill.requiresDesktop)) return ["status", "list_actions"];
  if (id === "files") return ["list", "read", "write"];
  if (id === "timers") return ["list", "create", "delete", "run"];
  if (["gmail", "outlook", "jira", "shopify", "whatsapp"].includes(id)) return ["status"];
  if (id === "whereiam") return ["status"];
  return ["status"];
}

function publicSkillContext(skills = [], capabilities = {}, scopedConnectors = {}) {
  return (Array.isArray(skills) ? skills : []).slice(0, 50).map((skill) => {
    const available = publicSkillEnabled(skill, capabilities, scopedConnectors);
    return {
      id: clean(skill.id),
      name: clean(skill.name || skill.label || skill.id),
      description: clean(skill.description || skill.summary).slice(0, 1000),
      instructions: clean(skill.instructions).slice(0, 3000),
      enabled: available,
      available,
      registryEnabled: skill.enabled === true,
      builtIn: skill.builtIn === true,
      requiresConnector: clean(skill.requiresConnector),
      requiresDesktop: clean(skill.requiresDesktop),
      setupState: available ? "available" : skill.enabled === true ? "capability_not_available" : "skill_disabled",
      availableActions: publicSkillActionHints(skill, available),
      actionTool: "orkestr_list_skill_actions",
    };
  }).filter((skill) => skill.id);
}

function publicTenantCapabilities(capabilities = {}, env = process.env) {
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
    codexEscalation: codexEscalationAvailable(env),
    webFetch: webFetchAvailable(env),
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
  const chat = publicChatContext(thread);
  const onboarding = await readUserOnboardingState(ownerUserId, env).catch(() => null);
  return {
    tenantId: ownerUserId,
    threadId: thread.id || null,
    threadName: chat.threadLabel,
    sourceChannel: chat.channel,
    chat,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    capabilities: publicTenantCapabilities(capabilities, env),
    onboardingProfile: onboarding?.profile || null,
    recentMessageCount: Math.min(20, messages.length),
  };
}

export async function buildTenantApiAgentInstructions(thread = {}, messages = [], env = process.env) {
  const context = await tenantContext(thread, messages, env);
  const codexAvailable = context.capabilities.codexEscalation === true;
  const webFetch = context.capabilities.webFetch === true;
  return [
    "You are the user-facing assistant for one Orkestr tenant chat.",
    "Treat this as a real conversation in the user's chat, not as a job runner that answers normal messages with a completion token.",
    codexAvailable
      ? "Be natural, concise, and helpful. Do not expose Orkestr internals, Codex runtime details, queues, tmux, shell paths, debug strings, or implementation wording unless the user explicitly asks about Orkestr operations."
      : "Be natural, concise, and helpful. Do not expose Orkestr internals, runtime details, queues, tmux, shell paths, debug strings, or implementation wording unless the user explicitly asks about Orkestr operations.",
    "You are scoped to the tenant in the JSON context below. Do not claim access to files, Gmail, Outlook, LinkedIn, WhatsApp accounts, browser desktops, timers, or other chats unless the provided Orkestr tools or context show them for this tenant.",
    "Use the recent message history for conversational identity. If the user says their name or identity, acknowledge it and use it in later turns. If the user asks 'who am I?', answer from the conversation and the Tenant context instead of asking a vague clarification.",
    "When the user shares non-secret onboarding details, preferences, timezone, language, requested tools, or setup notes, save them with the onboarding profile tool. Never store passwords, tokens, recovery codes, or secrets.",
    codexAvailable
      ? "If the user asks how you can help, what you can do, or what skills you have, answer with a short capability summary grounded in the Tenant context and enabled skills. For workspace/code execution, mention /codex as the explicit escalation path."
      : "If the user asks how you can help, what you can do, or what skills you have, answer with a short capability summary grounded in the Tenant context and enabled skills. Workspace/code execution is not available in this chat right now; do not mention a slash-command escalation path.",
    "Never answer a normal chat question, introduction, or capability question with only 'Done', 'OK', 'Sure', or another bare acknowledgement.",
    "Use the provided Orkestr tools for tenant-scoped resources. If the user asks whether Gmail, Outlook, Jira, Shopify, or WhatsApp is connected, available, enabled, or accessible, use the connector status tool before answering.",
    "If the user asks to connect, sign in, log in, set up, disconnect, or reconnect Gmail, Outlook, Jira, or Shopify, use the connector auth/disconnect tools and give the returned sign-in instructions.",
    "Connector setup is user-owned by default. When a connector is not connected or a matching capability is false, say that it is not connected for this chat yet and that you can help set it up here.",
    "Only say setup is unavailable on this Orkestr installation if a tool or Tenant context explicitly reports missing parent app/platform configuration. Even then, do not offer an admin note or tell the user to contact an admin unless the user explicitly asks how to escalate setup.",
    "If the user asks to use Gmail, Outlook, LinkedIn, files, or a browser desktop and the matching capability is false in the Tenant context JSON, say plainly that it is not connected or enabled for this chat yet. Do not imply that you checked it unless you used a tool.",
    "Do not tell contained users to open, check, or use the Orkestr UI for connector setup. This chat is the user surface; connector setup should happen through the sign-in instructions you provide in chat when parent app credentials exist.",
    "When Gmail capability is true and the user asks to search, list, open, read, inspect, or summarize Gmail, use the scoped Gmail tools directly. The user's request is consent for that same-user Gmail action; do not ask for repeated confirmation unless the target email or search is ambiguous.",
    webFetch
      ? "When the user asks for current public web page content, public site topics, public links, or a public page summary, use orkestr_fetch_web_page first. Answer only from the returned title, text, links, and counts. If the fetch fails or the returned content is insufficient, say that plainly instead of claiming you checked the page."
      : "Public web page fetching is not available in this chat right now. Do not claim you checked current public web content unless another tool result explicitly returns it.",
    "When asked what you can do or what skills you have, list only capabilities that are true in the Tenant context JSON and skills whose enabled field is true. Do not treat registryEnabled as availability; registryEnabled only means the user has not disabled the skill.",
    "For capability and action questions, reason from skills first: use orkestr_list_skills or orkestr_list_skill_actions to inspect enabled skills, current availability, and available actions before saying what you can do.",
    "If the user asks you to open, start, stop, restart, check, or otherwise act through a skill, use orkestr_list_skill_actions first and then orkestr_run_skill_action only when that action is available.",
    "After running a skill action, answer from the tool result. If the tool only opens a desktop or returns status, say exactly that; do not claim that you inspected account login, page contents, messages, or external state unless a tool result explicitly confirms that.",
    codexAvailable
      ? "Managed desktop and browser skill actions are controls, not page-reading tools. Opening a desktop or visiting a URL does not prove page contents, trending topics, translations, account login state, or successful research. For public HTTP(S) content, use orkestr_fetch_web_page. If the user asks to gather content that no Orkestr tool returns, say what was opened if a tool confirms it, then tell them to send the task with /codex for browser/content work."
      : "Managed desktop and browser skill actions are controls, not page-reading tools. Opening a desktop or visiting a URL does not prove page contents, trending topics, translations, account login state, or successful research. For public HTTP(S) content, use orkestr_fetch_web_page when available. If no Orkestr tool returns the requested content, say the chat cannot run live browser/content work right now; do not mention a slash-command escalation path.",
    "Skills are unique per user and are described by the skill records in the Tenant context. Do not force provider categories, goals, or attachment models onto them; preserve the user's wording.",
    "Users manage skills through chat. When they ask to list, view, search, create, update, enable, disable, or delete skills, use the Orkestr skill tools.",
    "Do not create or update a skill for phishing, scams, credential theft, unauthorized login attempts, spam, or abuse. Refuse those requests instead of calling a tool.",
    "If asked for the WhatsApp number, WhatsApp account, connector ID, backend account, or controlled identity, do not reveal phone numbers, session IDs, account IDs, tokens, or connector internals. If WhatsApp is enabled, say you are connected to this chat through Orkestr and exact account details are admin-only.",
    "Never approve security, auth, browser-pairing, connector, or SSH challenges. Tell the user to use the trusted Orkestr approval flow or SSH command shown by Orkestr.",
    codexAvailable
      ? "If the user asks for code/workspace execution, ask them to send the same task with /codex to explicitly escalate to a contained Codex worker."
      : "If the user asks for code/workspace execution, say this chat cannot start a workspace worker right now. Do not claim the task was moved and do not mention a slash-command escalation path.",
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
  if (error?.sanitizer?.unavailable === true || /llm_sanitizer_(?:http|timeout|empty_response|invalid_json|unavailable)/i.test(code)) {
    return "I couldn't safely verify this because the sanitizer service was temporarily unavailable. Please resend the message.";
  }
  if (code.includes("sanitizer") || error?.sanitizer) return "I couldn't safely verify this request, so I did not run it. Please try a simpler request or ask an admin to check the sanitizer setup.";
  return "I couldn't complete this request right now. Please try again in a moment.";
}

function explicitCodexEscalation(text = "") {
  return /^\/codex(?:\s+|$)/i.test(String(text || "").trim());
}

async function handleCodexEscalation(thread, message, env = process.env) {
  const task = clean(message.text).replace(/^\/codex\s*/i, "").trim();
  if (!codexEscalationAvailable(env)) {
    await updateThreadMessage(thread.id, message.id, {
      text: task || message.text,
      state: "completed",
      deliveryState: "api_agent_completed",
      observedVia: "api_agent_codex_unavailable",
      deliveredAt: nowIso(),
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "api-agent",
      phase: "final_answer",
      text: "This chat cannot start a workspace worker right now. Workspace and live browser execution are not available here.",
      parentMessageId: message.id,
      state: "completed",
      connector: message.connector,
      chatId: message.chatId,
      accountId: message.accountId,
    }, env);
    await appendEvent({ type: "api_agent_codex_unavailable", threadId: thread.id, messageId: message.id, ownerUserId: threadOwnerUserId(thread, env) }, env).catch(() => {});
    return { ok: true, processed: true, codexUnavailable: true };
  }
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

function repairConversationInput(inputItems = []) {
  return inputItems.map((item) => {
    if (clean(item?.role) && item.content !== undefined) {
      return { role: lower(item.role) === "assistant" ? "assistant" : "user", content: clean(item.content) };
    }
    if (item?.type === "function_call") {
      return { role: "assistant", content: `Called tenant tool ${clean(item.name)} with ${clean(item.arguments || "{}")}.` };
    }
    if (item?.type === "function_call_output") {
      return { role: "user", content: `Tenant tool result: ${clean(item.output).slice(0, 20_000)}` };
    }
    return null;
  }).filter(Boolean);
}

async function repairWeakTenantApiAgentResponse({ baseBody, inputItems, thread, message, text, env, fetchImpl }) {
  const codexAvailable = codexEscalationAvailable(env);
  const repairBody = {
    ...baseBody,
    instructions: [
      baseBody.instructions,
      "",
      "Response repair: the previous draft was not acceptable as the final answer for the latest user message.",
      "Write the actual final answer now. Keep it concise, conversational, and grounded in the Tenant context.",
      "If the latest user message introduced a name or identity, acknowledge it and briefly say how you can help.",
      codexAvailable
        ? "If the latest user message asks what you can do or how you can help, provide a short practical capability summary and mention /codex for workspace execution."
        : "If the latest user message asks what you can do or how you can help, provide a short practical capability summary and say workspace execution is not available in this chat right now.",
      "If the latest user message is only a confirmation like yes/ok and no tool result confirms completed work, do not say Done and do not promise future browser or workspace work. Ask for the concrete task or explain the pending limitation.",
      "Do not use tools during this repair step.",
    ].join("\n"),
    input: [
      ...repairConversationInput(inputItems).slice(-30),
      { role: "assistant", content: clean(text) || "Done." },
      {
        role: "user",
        content: [
          "Rewrite the previous assistant draft as a useful final answer for this latest user message.",
          `Latest user message: ${clean(message.text).slice(0, 4000)}`,
        ].join("\n"),
      },
    ],
  };
  delete repairBody.tools;
  delete repairBody.tool_choice;
  delete repairBody.parallel_tool_calls;
  const response = await postOpenAIResponse(repairBody, env, fetchImpl, `orkestr-${thread.id}-${message.id}-repair`);
  await recordResponseUsage({ response, thread, message, callKind: "assistant_repair" }, env);
  return { response, text: responseText(response) };
}

function pendingActionConfirmationInstructions(pending = null, env = process.env) {
  if (!pending) return "";
  const codexAvailable = codexEscalationAvailable(env);
  const webFetch = webFetchAvailable(env);
  return [
    "Pending action confirmation: the latest user message is a confirmation of the previous assistant offer.",
    `Previous assistant offer: ${pending.previousAssistantText}`,
    `Latest confirmation: ${pending.confirmationText}`,
    "Do not answer with a bare acknowledgement such as Done.",
    "Inspect live skill/action availability before claiming an action is possible or complete.",
    "Run only actions exposed by Orkestr tools. If a managed desktop/browser action can open or visit a URL, use that action when appropriate.",
    webFetch
      ? "If the pending action is for current public HTTP(S) page content, use orkestr_fetch_web_page and answer from the returned title, text, links, and counts."
      : "Public web page fetching is not available in this chat right now.",
    codexAvailable
      ? "If no tool returns page contents, trends, translations, login state, or research output, do not claim those were gathered; say what the tool confirmed and use /codex for browser/content work."
      : "If no tool returns page contents, trends, translations, login state, or research output, do not claim those were gathered; say the content was not available from the current tools.",
  ].join("\n");
}

async function runTenantApiAgentToolResultResponse({
  baseBody,
  inputItems,
  responseWithCalls,
  thread,
  message,
  principal,
  pendingAction,
  env,
  fetchImpl,
  idempotencySuffix = "2",
  callKind = "assistant_tool_result",
  fallbackFromToolOutputs = null,
}) {
  const toolInput = [...inputItems, ...responseFunctionCallInputItems(responseWithCalls)];
  const calls = responseFunctionCalls(responseWithCalls);
  const toolOutputs = [];
  const toolResults = [];
  for (const call of calls.slice(0, 3)) {
    let output = {};
    let args = {};
    try {
      args = JSON.parse(call.arguments || "{}");
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
    toolResults.push({ name: clean(call.name), args, output });
    toolOutputs.push(output);
    toolInput.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(output).slice(0, 30_000),
    });
  }
  const second = await postOpenAIResponse({
    ...baseBody,
    input: toolInput,
  }, env, fetchImpl, `orkestr-${thread.id}-${message.id}-${idempotencySuffix}`);
  await recordResponseUsage({ response: second, thread, message, callKind }, env);
  const text = responseText(second);
  const customFallback = typeof fallbackFromToolOutputs === "function" ? clean(fallbackFromToolOutputs(toolOutputs, { message, text })) : "";
  const toolFallback = clean(formatToolResultFallback(toolResults, { message, text, pendingAction }));
  const fallback = customFallback || toolFallback;
  if (fallback && shouldPreferWebFetchFallback(text, fallback, message)) return { response: second, text: fallback };
  if (fallback && genericToolFallbackText(text)) return { response: second, text: fallback };
  if (!tenantApiAgentTextNeedsRepair(text, message, { pendingActionConfirmation: Boolean(pendingAction), env })) return { response: second, text };
  if (fallback) return { response: second, text: fallback };
  const repaired = await repairWeakTenantApiAgentResponse({
    baseBody,
    inputItems: toolInput,
    thread,
    message,
    text,
    env,
    fetchImpl,
  });
  const repairedText = responseText(repaired.response) || repaired.text;
  if (fallback && genericToolFallbackText(repairedText)) return { response: repaired.response, text: fallback };
  return {
    response: repaired.response,
    text: tenantApiAgentTextNeedsRepair(repairedText, message, { pendingActionConfirmation: Boolean(pendingAction), env })
      ? fallbackTenantApiAgentRepairAnswer(message, {
        pendingActionConfirmation: Boolean(pendingAction),
        originalText: text,
        repairedText,
        env,
      })
      : repairedText,
  };
}

async function retryPendingActionConfirmationWithTools({ baseBody, inputItems, thread, message, text, principal, pendingAction, env, fetchImpl }) {
  const retryBody = {
    ...baseBody,
    instructions: [
      baseBody.instructions,
      "",
      "Action confirmation retry: the previous draft did not run any tool and cannot be accepted for this confirmation turn.",
      pendingActionConfirmationInstructions(pendingAction, env),
      "Use the available tools now if an Orkestr skill action is available. Otherwise answer honestly with the limitation.",
    ].filter(Boolean).join("\n"),
    input: [
      ...repairConversationInput(inputItems).slice(-30),
      { role: "assistant", content: clean(text) || "Done." },
      {
        role: "user",
        content: [
          "The previous assistant draft was not enough because this is a confirmation of an offered action.",
          "Inspect skill/action availability and run only confirmed Orkestr actions before finalizing.",
        ].join("\n"),
      },
    ],
  };
  const retry = await postOpenAIResponse(retryBody, env, fetchImpl, `orkestr-${thread.id}-${message.id}-action-retry`);
  await recordResponseUsage({ response: retry, thread, message, callKind: "assistant_action_retry" }, env);
  if (responseFunctionCalls(retry).length) {
    return runTenantApiAgentToolResultResponse({
      baseBody: retryBody,
      inputItems: retryBody.input,
      responseWithCalls: retry,
      thread,
      message,
      principal,
      pendingAction,
      env,
      fetchImpl,
      idempotencySuffix: "action-retry-2",
      callKind: "assistant_action_retry_tool_result",
    });
  }
  const retryText = responseText(retry);
  if (!tenantApiAgentTextNeedsRepair(retryText, message, { pendingActionConfirmation: true, env })) return { response: retry, text: retryText };
  return { response: retry, text: fallbackPendingActionConfirmationAnswer(env) };
}

async function runTenantApiAgentResponse({ thread, messages, message, env, fetchImpl }) {
  const model = apiAgentModel(env);
  const principal = tenantPrincipalForThread(thread, env);
  const pendingAction = pendingActionConfirmation(messages, message);
  const instructions = [
    await buildTenantApiAgentInstructions(thread, messages, env),
    pendingActionConfirmationInstructions(pendingAction, env),
  ].filter(Boolean).join("\n");
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

  const webFetchTarget = webFetchAvailable(env) ? publicWebFetchTargetForMessage(message.text) : null;
  if (webFetchTarget) {
    let output = {};
    try {
      await assertSanitizedAction({
        action: "api-agent.tool.orkestr_fetch_web_page",
        principal,
        resource: {
          type: "thread",
          id: thread.id,
          ownerUserId: threadOwnerUserId(thread, env),
          capabilities: await scopedCapabilitiesForThread(thread, env),
        },
        input: {
          tool: "orkestr_fetch_web_page",
          args: {
            url: webFetchTarget.url,
            maxLinks: webFetchTarget.maxLinks,
            maxChars: webFetchTarget.maxChars,
          },
        },
      }, env);
      output = await runTenantApiAgentTool("orkestr_fetch_web_page", {
        url: webFetchTarget.url,
        maxLinks: webFetchTarget.maxLinks,
        maxChars: webFetchTarget.maxChars,
      }, { principal, thread, fetchImpl }, env);
    } catch (error) {
      output = { ok: false, error: clean(error?.message || error || "web_fetch_failed") };
    }
    const directAnswer = fallbackWebFetchToolAnswer([output]);
    const text = webFetchDirectAnswerUsable(output, directAnswer)
      ? directAnswer
      : await openPublicWebFetchInDesktop({ target: webFetchTarget, output, thread, principal, env, fetchImpl }) || (
        output?.ok === false
          ? `I couldn't fetch that public page from this chat right now: ${clean(output.error || "web_fetch_failed")}.`
          : "I fetched the public page, but I could not extract useful content from it."
      );
    return {
      response: {
        id: `web_fetch_direct_${message.id}`,
        model: "orkestr-api-agent-web-fetch",
        output_text: text,
        output: [],
        usage: {},
      },
      text,
    };
  }

  const first = await postOpenAIResponse(baseBody, env, fetchImpl, `orkestr-${thread.id}-${message.id}-1`);
  await recordResponseUsage({ response: first, thread, message, callKind: "assistant" }, env);
  const calls = responseFunctionCalls(first);
  if (!calls.length) {
    const text = responseText(first);
    if (pendingAction && weakTenantApiAgentText(text)) {
      return retryPendingActionConfirmationWithTools({
        baseBody,
        inputItems: input,
        thread,
        message,
        text,
        principal,
        pendingAction,
        env,
        fetchImpl,
      });
    }
    if (!tenantApiAgentTextNeedsRepair(text, message, { pendingActionConfirmation: Boolean(pendingAction), env })) return { response: first, text };
    const repaired = await repairWeakTenantApiAgentResponse({
      baseBody,
      inputItems: input,
      thread,
      message,
      text,
      env,
      fetchImpl,
    });
    return {
      response: repaired.response,
      text: tenantApiAgentTextNeedsRepair(repaired.text, message, { pendingActionConfirmation: Boolean(pendingAction), env })
        ? fallbackTenantApiAgentRepairAnswer(message, {
          pendingActionConfirmation: Boolean(pendingAction),
          originalText: text,
          repairedText: repaired.text,
          env,
        })
        : repaired.text,
    };
  }

  return runTenantApiAgentToolResultResponse({
    baseBody,
    inputItems: input,
    responseWithCalls: first,
    thread,
    message,
    principal,
    pendingAction,
    env,
    fetchImpl,
    idempotencySuffix: "2",
    callKind: "assistant_tool_result",
  });
}

function apiAgentBatchLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_MAX_BATCH_MESSAGES || 5);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(25, Math.floor(parsed))) : 5;
}

function apiAgentStaleRunningMs(env = process.env) {
  const parsed = Number(env.ORKESTR_API_AGENT_STALE_RUNNING_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.floor(parsed)) : 120_000;
}

function messageTimestampMs(message = {}) {
  const value = message.updatedAt || message.deliveredAt || message.createdAt;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function staleApiAgentRunningMessage(messages = [], env = process.env) {
  const threshold = apiAgentStaleRunningMs(env);
  const now = Date.now();
  return messages.find((message) => {
    if (lower(message.role) !== "user" || lower(message.state) !== "running") return false;
    const deliveryState = lower(message.deliveryState);
    const observedVia = lower(message.observedVia);
    if (deliveryState !== "api_agent_running" && observedVia !== "api_agent") return false;
    const startedAt = messageTimestampMs(message);
    return !startedAt || now - startedAt >= threshold;
  }) || null;
}

async function recoverStaleApiAgentMessage(thread, messages, env = process.env) {
  const stale = staleApiAgentRunningMessage(messages, env);
  if (!stale) return null;
  const recovered = await updateThreadMessage(thread.id, stale.id, {
    state: "queued",
    deliveryState: "api_agent_retrying_stale",
    observedVia: "api_agent_stale_recovery",
    staleDeliveryState: stale.deliveryState || "",
    staleObservedVia: stale.observedVia || "",
    staleRecoveredAt: nowIso(),
  }, env);
  await appendTurnLifecycleEvent("queued", {
    threadId: thread.id,
    messageId: stale.id,
    runtimeKind: API_AGENT_RUNTIME_KIND,
    state: "queued",
    source: "api-agent",
    reason: "stale_running_recovery",
  }, env).catch(() => {});
  await appendEvent({
    type: "api_agent_stale_running_recovered",
    threadId: thread.id,
    messageId: stale.id,
    ownerUserId: threadOwnerUserId(thread, env),
  }, env).catch(() => {});
  return recovered;
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
  const message = messages.find((item) => lower(item.role) === "user" && ["queued", "pending_delivery"].includes(lower(item.state || "queued"))) ||
    await recoverStaleApiAgentMessage(thread, messages, env);
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
      if (!result.processed || result.ok === false || result.escalated || result.codexUnavailable) {
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
