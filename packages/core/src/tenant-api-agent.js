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
import { builtinUserSkillDefinitions, userScopedCapabilityHints } from "./user-skills.js";
import { routingFailureFromError } from "./routing-failures.js";
import { adminUserId, normalizeUserId } from "./users.js";
import { appendTurnLifecycleEvent, turnLifecycleFromRuntimeStatus } from "./turn-lifecycle.js";
import { actionRegistryInstructions } from "./action-registry.js";
import { recordApiAgentFailureSuggestion } from "./api-agent-suggestions.js";

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

function apiAgentToolCapability(tool = "") {
  const name = lower(tool);
  if (["orkestr_list_timers", "orkestr_create_timer", "orkestr_delete_timer", "orkestr_run_timer"].includes(name)) return "timers";
  if (name.includes("automation")) return "timers";
  if (name.includes("action_registry")) return "skills";
  if (name.includes("gmail") || name.includes("google_calendar") || name.includes("google_drive") || name.includes("google_workspace")) return "gmail";
  if (name.includes("outlook")) return "outlook";
  if (name.includes("desktop") || name.includes("browser") || name.includes("linkedin")) return "linkedin";
  if (name.includes("file")) return "files";
  if (name.includes("whatsapp")) return "whatsapp";
  if (name.includes("skill")) return "skills";
  return "";
}

function messageCapabilityIntent(text = "") {
  const value = lower(text);
  if (/\b(?:gmail|google workspace|google calendar|calendar events?|google drive|drive file)\b/.test(value)) return "gmail";
  if (/\b(?:timer|automation|automations|push|notify|notification|notifications|watch|monitor|remind|reminder|schedule|in\s+\d+\s*(?:m|min|minute|minutes|h|hour|hours|d|day|days))\b/.test(value)) return "timers";
  if (/\boutlook\b/.test(value)) return "outlook";
  if (/\b(?:linkedin|desktop|browser)\b/.test(value)) return "linkedin";
  if (/\bwhatsapp\b/.test(value)) return "whatsapp";
  if (/\bfile\b/.test(value)) return "files";
  return "";
}

function capabilityAvailable(capabilities = {}, capability = "") {
  const id = clean(capability);
  if (!id || id === "skills") return true;
  return capabilities[id] === true;
}

async function appendApiAgentCapabilityDecision(input = {}, env = process.env) {
  await appendEvent({
    type: "api_agent_capability_decision",
    threadId: clean(input.threadId),
    messageId: clean(input.messageId),
    ownerUserId: normalizeUserId(input.ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    action: clean(input.action || "capability_check"),
    tool: clean(input.tool),
    capability: clean(input.capability),
    result: clean(input.result || "unknown"),
    reason: clean(input.reason),
    retryable: input.retryable === true,
    targetInstanceId: clean(input.targetInstanceId),
  }, env).catch(() => {});
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

function tenantApiAgentInternalThoughtParagraph(text = "") {
  const value = clean(text).replace(/\s+/g, " ");
  if (!value) return false;
  if (/^(?:User|The user)\s+(?:wants?|wanted|asked|asks|said|says|requested|previously|has|is|may|might|probably|expects?)\b/i.test(value)) return true;
  if (/^(?:Now what\?|They\s+(?:might|may|probably)|We\s+(?:should|need|must|did|have|already)|Need to|Maybe|Possibly)\b/i.test(value) &&
    /\b(?:user|assistant|developer|system|tool calls?|timer tool|prompt|thread|chat|respond|offer|ask|wait|instruction|final|turn|previous)\b/i.test(value)) return true;
  if (/^(?:The\s+)?(?:developer|system)\s+instructions?\b/i.test(value)) return true;
  return /^(?:User|The user|We|They|Now|Need|Maybe|Possibly|The)\b/i.test(value) &&
    /\b(?:developer instructions?|system instructions?|tool calls?|function_call|output_text|assistant turn|latest user message|we should wait|create_timer tool|orkestr_[a-z0-9_]+)\b/i.test(value);
}

function stripTenantApiAgentInternalThought(text = "") {
  const original = clean(text);
  if (!original) return "";

  const paragraphs = original.split(/\n\s*\n+/);
  const keptParagraphs = [];
  for (const paragraph of paragraphs) {
    if (tenantApiAgentInternalThoughtParagraph(paragraph)) {
      return clean(keptParagraphs.join("\n\n"));
    }
    keptParagraphs.push(paragraph);
  }

  const lines = original.split(/\r?\n/);
  const keptLines = [];
  for (const line of lines) {
    if (tenantApiAgentInternalThoughtParagraph(line)) {
      return clean(keptLines.join("\n"));
    }
    keptLines.push(line);
  }

  return original;
}

function sanitizeTenantApiAgentRuntimeWording(text = "") {
  return String(text || "")
    .replace(/\bcontained\s+Codex worker\b/gi, "contained workspace worker")
    .replace(/\bCodex worker\b/gi, "workspace worker")
    .replace(/\bCodex runtime details\b/gi, "workspace runtime details")
    .replace(/\bCodex runtime\b/gi, "workspace runtime");
}

function normalizeTenantApiAgentText(text = "") {
  const original = sanitizeTenantApiAgentRuntimeWording(stripTenantApiAgentInternalThought(text));
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

function assistantLeaksInternalRuntimeText(text = "") {
  const value = clean(text);
  return /\bcodexEscalation\b/i.test(value) ||
    /\bcontained execution workspace\b/i.test(value) ||
    /\bnot running Codex right now\b/i.test(value) ||
    /\bworkspace does support\b/i.test(value) ||
    /\[local file path omitted]/i.test(value);
}

function fallbackInternalRuntimeLeakAnswer(message = {}, env = process.env) {
  const text = clean(message.text);
  if (/\b(?:run|code|workspace|execute|terminal|script|command)\b/i.test(text) && codexEscalationAvailable(env)) {
    return "I can help with that. Send the task as `/codex <what you want to run>` and I will route it to the workspace worker.";
  }
  return "I can help in this chat with connected Orkestr skills and tenant-scoped tools. Tell me the specific task you want to do.";
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

function gmailTestingAccessDeniedMessage(text = "") {
  const value = lower(text);
  return value.includes("access_denied") &&
    (value.includes("google verification process") || value.includes("app is currently being tested") || value.includes("developer-approved testers"));
}

function emailFromText(text = "") {
  return clean(clean(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "").toLowerCase();
}

function splitList(value = "") {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[\s,]+/g).map(clean).filter(Boolean);
}

function gmailTesterAllowlistConfigured(env = process.env) {
  return splitList(
    env.GMAIL_OAUTH_APPROVED_TESTERS ||
    env.GOOGLE_OAUTH_APPROVED_TESTERS ||
    env.GMAIL_OAUTH_ALLOWED_ACCOUNTS ||
    env.GOOGLE_OAUTH_ALLOWED_ACCOUNTS
  ).length > 0;
}

function gmailSignInIntent(text = "") {
  const value = lower(text);
  return /\bgmail\b/.test(value) &&
    /\b(?:connect|sign\s*in|login|log\s*in|authorize|authorise|auth|oauth|set\s*up|setup|reconnect|register|add)\b/.test(value);
}

function compactField(value = "", max = 240) {
  const normalized = clean(value).replace(/\s+/g, " ");
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...` : normalized;
}

function parseStructuredGmailPromptPush(text = "") {
  const value = clean(text);
  if (!/^new\s+gmail\s+message\b/i.test(value)) return null;
  const fields = {};
  const pattern = /(?:^|\n)\s*([A-Za-z][A-Za-z ]{1,24}):\s*([\s\S]*?)(?=\n\s*[A-Za-z][A-Za-z ]{1,24}:\s*|\s*$)/g;
  for (const match of value.matchAll(pattern)) {
    const key = lower(match[1]).replace(/\s+/g, " ");
    if (!fields[key]) fields[key] = compactField(match[2], key === "snippet" ? 500 : 240);
  }
  const info = {
    from: fields.from || "",
    subject: fields.subject || "",
    date: fields.received || fields.date || "",
    snippet: fields.snippet || "",
  };
  return Object.values(info).some(Boolean) ? info : null;
}

function isGmailPromptPushMessage(message = {}) {
  return lower(message.source) === "connector_prompt_push" &&
    lower(message.connector || message.originSurface) === "gmail";
}

function gmailPromptPushInfo(message = {}) {
  if (!isGmailPromptPushMessage(message)) return null;
  const parsed = parseStructuredGmailPromptPush(message.text) || {};
  const messageId = clean(message.externalId);
  if (!messageId && !Object.values(parsed).some(Boolean)) return null;
  return { ...parsed, messageId };
}

function gmailPromptPushLabel(info = {}) {
  const subject = compactField(info.subject || "(no subject)", 180);
  const from = compactField(info.from, 180);
  return `${from ? `${from} - ` : ""}${subject}`;
}

function gmailPromptPushModelContext(message = {}) {
  const info = gmailPromptPushInfo(message);
  if (!info) return "";
  const details = [
    "Private connector context for API-agent tool use only: Gmail notification.",
    info.messageId ? `Gmail message id: ${info.messageId}.` : "",
    info.from ? `From: ${info.from}.` : "",
    info.subject ? `Subject: ${info.subject}.` : "",
    info.date ? `Date: ${info.date}.` : "",
    "Use this context for follow-up tool calls, and do not print private connector ids unless the user explicitly asks.",
  ].filter(Boolean).join(" ");
  return `[${details}]`;
}

function latestGmailPromptPushBefore(messages = [], message = {}) {
  const index = messages.findIndex((item) => clean(item.id) === clean(message.id));
  const before = index >= 0 ? messages.slice(0, index) : messages;
  for (const item of before.slice().reverse()) {
    const info = gmailPromptPushInfo(item);
    if (info) return { message: item, ...info };
  }
  return null;
}

function gmailContextInstructions(message = {}, gmailContext = null) {
  const current = gmailPromptPushInfo(message);
  const info = current || gmailContext;
  if (!info) return "";
  const lines = [
    current
      ? "Latest message is a structured Gmail notification delivered by a connector prompt-push."
      : "Recent Gmail notification context is available for the latest user message.",
    `Gmail notification summary: ${gmailPromptPushLabel(info)}.`,
  ];
  if (info.messageId) {
    lines.push(`Private Gmail message id for tool calls: ${info.messageId}.`);
  }
  lines.push(
    "If the latest user message asks to open, read, summarize, extract details from, or act on that Gmail notification, the Gmail read tools can use the private message id when available.",
    "Do not let this stale Gmail context override the current user request. If the current request asks to notify, alert, push, watch, monitor, create/update automations, or manage notification rules, use the notification or automation tools instead of reading this email.",
    "If no tool is called or the model cannot act, answer from the notification context without claiming the external action was completed.",
  );
  return lines.join("\n");
}

function genericTenantApiAgentHelpText(text = "") {
  const value = clean(text).replace(/\s+/g, " ");
  if (!value) return true;
  return /^I can help in this chat\. Tell me what you want(?: to do)?\b/i.test(value) ||
    /^Tell me what you want(?: to do)?\b/i.test(value);
}

function fallbackGmailPromptPushAnswer(message = {}) {
  const info = gmailPromptPushInfo(message);
  if (!info) return "";
  return [
    `Got it - new Gmail message${info.from ? ` from ${info.from}` : ""}.`,
    info.subject ? `Subject: ${info.subject}` : "",
    info.date ? `Received: ${info.date}` : "",
    info.snippet ? `Snippet: "${info.snippet}"` : "",
    "",
    "Available next actions: read the full message, summarize it, extract details, mark it read/archive/delete, draft a reply, save it, or set a reminder.",
  ].filter((line) => line !== "").join("\n");
}

function fallbackGmailContextAnswer(message = {}, gmailContext = null) {
  if (!gmailContext) return "";
  const label = gmailPromptPushLabel(gmailContext);
  return [
    "Yes, I can help with that.",
    `The latest relevant Gmail notification before your question was: ${label}.`,
    "The next step is to read the full email with the Gmail tool before giving a specific answer, so we can confirm what it is, extract transaction/support details, and avoid treating a one-off receipt as a recurring subscription. I will not cancel, send, delete, or modify anything without your explicit approval.",
  ].join("\n\n");
}

function gmailAddressRequiredForTestingAnswer() {
  return "Which Gmail address do you want to connect? This Orkestr Gmail app is in Google testing mode, so I need the exact address before sending a sign-in link.";
}

function fallbackGmailTestingAccessDeniedAnswer(message = {}) {
  const account = emailFromText(message.text);
  return [
    `Gmail sign-in did not complete${account ? ` for ${account}` : ""}.`,
    "This Google OAuth app is still in testing mode, so only Gmail addresses on the approved Google test-user list can register.",
    "Add that Gmail address as a Google OAuth test user first, then try Gmail sign-in again from this chat.",
  ].join(" ");
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
  const gmailPrompt = gmailPromptPushInfo(message);
  if (gmailPrompt && (weakTenantApiAgentText(text) || genericTenantApiAgentHelpText(text))) return true;
  if (options.gmailContext && genericTenantApiAgentHelpText(text)) return true;
  if (weakTenantApiAgentText(text) && (
    userMessageNeedsSubstantiveAnswer(message.text) ||
    bareConfirmationText(message.text) ||
    gmailTestingAccessDeniedMessage(message.text) ||
    options.pendingActionConfirmation === true
  )) return true;
  if (assistantLeaksInternalRuntimeText(text)) return true;
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

function fallbackWeakTenantApiAgentAnswer(message = {}, env = process.env, options = {}) {
  const gmailPromptFallback = fallbackGmailPromptPushAnswer(message);
  if (gmailPromptFallback) return gmailPromptFallback;
  const gmailContextFallback = fallbackGmailContextAnswer(message, options.gmailContext);
  if (gmailContextFallback) return gmailContextFallback;
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
  if (assistantLeaksInternalRuntimeText(options.originalText) || assistantLeaksInternalRuntimeText(options.repairedText)) {
    return fallbackInternalRuntimeLeakAnswer(message, env);
  }
  if (gmailTestingAccessDeniedMessage(message.text)) return fallbackGmailTestingAccessDeniedAnswer(message);
  if (options.pendingActionConfirmation === true) return fallbackPendingActionConfirmationAnswer(env);
  if (assistantPromisesUnconfirmedAction(options.originalText) || assistantPromisesUnconfirmedAction(options.repairedText)) {
    const gmailFallback = fallbackGmailPromptPushAnswer(message) || fallbackGmailContextAnswer(message, options.gmailContext);
    if (gmailFallback) return gmailFallback;
    return fallbackUnconfirmedActionAnswer(env);
  }
  return fallbackWeakTenantApiAgentAnswer(message, env, options);
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
  const content = [
    clean(message.text || message.promptFile || ""),
    gmailPromptPushModelContext(message),
  ].filter(Boolean).join("\n\n");
  return {
    role: lower(message.role) === "assistant" ? "assistant" : "user",
    content,
  };
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
  if (webFetchLooksLikeBrowserChallenge(output)) {
    return `The public fetch returned a browser challenge for ${clean(output.url || output.requestedUrl) || "the requested page"}; it did not return useful page contents.`;
  }
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

function publicAppBaseUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_URL || env.ORKESTR_APP_URL || env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_CONNECT_PUBLIC_URL);
}

function publicFacingUrl(value = "", env = process.env) {
  const raw = clean(value);
  if (!raw || !raw.startsWith("/")) return raw;
  const base = publicAppBaseUrl(env);
  if (!base) return raw;
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
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
    if (/gmail_account_required_for_tester_check/i.test(error)) {
      return gmailAddressRequiredForTestingAnswer();
    }
    if (/gmail_account_not_approved_for_testing/i.test(error)) {
      const account = clean(args.account);
      return `${provider} sign-in cannot start${account ? ` for ${account}` : ""} because this Google OAuth app is still in testing mode and that address is not on the approved test-user list. Add it as a Google OAuth test user first, then try again.`;
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
      const url = publicFacingUrl(desktop.url, context.env);
      lines.push(`${clean(desktop.label || desktop.slug || "Desktop")} is ${clean(desktop.state || desktop.status || "unknown")}${url ? ` at ${url}` : ""}.`);
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
  const url = publicFacingUrl(output.openedUrl || output.url || desktop.url, context.env);
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

function formatGmailNotificationTool(result = {}) {
  const output = result.output || {};
  if (output.ok === false || clean(output.error)) {
    const error = clean(output.error || "tool_failed");
    if (/gmail_notifications_disabled/i.test(error)) return "Gmail background notifications are not enabled on this Orkestr installation yet.";
    if (/gmail_not_connected|connector_prompt_push_capability_required/i.test(error)) return "Gmail is not connected or enabled for this chat yet.";
    return `Gmail notification tool failed: ${error}.`;
  }
  if (Array.isArray(output.notifications)) {
    if (!output.notifications.length) return "No Gmail notification rules are configured for this chat.";
    return [
      "Gmail notification rules:",
      ...output.notifications.slice(0, 10).map((notification) => {
        const state = notification.enabled === false ? "disabled" : "enabled";
        const every = clean(notification.every) || `${Math.round(Number(notification.intervalMs || 0) / 60_000)}m`;
        const query = clean(notification.query) || "default query";
        return `- ${clean(notification.label || notification.id)} (${state}, every ${every}, ${query})`;
      }),
    ].join("\n");
  }
  if (output.notification) {
    const notification = output.notification;
    const every = clean(notification.every) || `${Math.round(Number(notification.intervalMs || 0) / 60_000)}m`;
    if (output.run) {
      const delivered = Array.isArray(output.run.delivered) ? output.run.delivered.length : 0;
      const skipped = Array.isArray(output.run.skipped) ? output.run.skipped.length : 0;
      return `Gmail notification ran now: ${delivered} delivered${skipped ? `, ${skipped} skipped` : ""}.`;
    }
    const action = result.name === "orkestr_update_gmail_notification" ? "updated" : "created";
    return `Gmail notification ${action}: ${clean(notification.label || notification.id)}. It is ${notification.enabled === false ? "disabled" : "enabled"} and checks every ${every}.`;
  }
  if (output.run) {
    const delivered = Array.isArray(output.run.delivered) ? output.run.delivered.length : 0;
    return `Gmail notification ran now: ${delivered} delivered.`;
  }
  if (output.ok !== undefined) return output.ok ? "Gmail notification was updated." : "Gmail notification action failed.";
  return "";
}

function formatGoogleWorkspaceTool(result = {}) {
  const output = result.output || {};
  const error = clean(output.error);
  if (output.ok === false || error) {
    if (/google_workspace_not_connected|gmail_not_connected|capability_not_granted/i.test(error)) {
      return "Google Workspace is not connected or the requested capability was not granted for this chat yet.";
    }
    return `Google Workspace tool failed: ${error || "tool_failed"}.`;
  }
  if (result.name === "orkestr_modify_gmail_message") {
    return `Gmail message ${clean(output.messageId || output.message?.id || "updated")} was updated.`;
  }
  if (result.name === "orkestr_create_gmail_draft") {
    return `Gmail draft created${clean(output.draft?.id) ? `: ${clean(output.draft.id)}` : ""}.`;
  }
  if (result.name === "orkestr_send_gmail_draft" || result.name === "orkestr_send_gmail_message") {
    return `Gmail message sent${clean(output.message?.id) ? `: ${clean(output.message.id)}` : ""}.`;
  }
  if (result.name === "orkestr_list_google_calendar_events") {
    const events = Array.isArray(output.events) ? output.events : [];
    if (!events.length) return "No matching Google Calendar events were found.";
    return [
      `Found ${events.length} Google Calendar event${events.length === 1 ? "" : "s"}:`,
      ...events.slice(0, 10).map((event) => {
        const start = clean(event.start?.dateTime || event.start?.date);
        return `- ${clean(event.summary || "(no title)")}${start ? ` (${start})` : ""}${clean(event.location) ? ` at ${clean(event.location)}` : ""}`;
      }),
    ].join("\n");
  }
  if (result.name === "orkestr_create_google_calendar_event") {
    const event = output.event || {};
    return `Google Calendar event created${clean(event.summary) ? `: ${clean(event.summary)}` : ""}${clean(event.id) ? ` (${clean(event.id)})` : ""}.`;
  }
  if (result.name === "orkestr_update_google_calendar_event") {
    const event = output.event || {};
    return `Google Calendar event updated${clean(event.summary) ? `: ${clean(event.summary)}` : ""}${clean(output.eventId || event.id) ? ` (${clean(output.eventId || event.id)})` : ""}.`;
  }
  if (result.name === "orkestr_delete_google_calendar_event") {
    return `Google Calendar event deleted${clean(output.eventId) ? `: ${clean(output.eventId)}` : ""}.`;
  }
  if (result.name === "orkestr_get_google_drive_file") {
    const file = output.file || {};
    return [
      `Google Drive file: ${clean(file.name || file.id || "file")}`,
      clean(file.mimeType) ? `Type: ${clean(file.mimeType)}` : "",
      clean(output.content) ? clean(output.content).slice(0, 1200) : "",
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

function formatActionRegistryTool(result = {}) {
  const actions = Array.isArray(result.output?.actions) ? result.output.actions : [];
  if (!actions.length) return "No matching actions are registered for this chat.";
  return [
    "Registered actions:",
    ...actions.slice(0, 12).map((action) => {
      const status = clean(action.status) ? `, ${clean(action.status)}` : "";
      return `- ${clean(action.provider)}.${clean(action.verb)}.${clean(action.object)} (${clean(action.tool)}${status})`;
    }),
  ].join("\n");
}

function formatAutomationTool(result = {}) {
  const output = result.output || {};
  if (output.ok === false || clean(output.error)) return `Automation tool failed: ${clean(output.error || "tool_failed")}.`;
  if (Array.isArray(output.automations)) {
    return output.automations.length
      ? [
          "Automations:",
          ...output.automations.slice(0, 12).map((automation) => {
            const state = automation.enabled === false ? "paused" : "enabled";
            const nextRun = clean(automation.schedule?.nextRunAt) ? `, next ${clean(automation.schedule.nextRunAt)}` : "";
            return `- ${clean(automation.label || automation.automationId)} (${clean(automation.type || automation.provider)}, ${state}${nextRun})`;
          }),
        ].join("\n")
      : "No automations are configured for this chat.";
  }
  if (output.automation) {
    const state = output.automation.enabled === false ? "paused" : "enabled";
    return `Automation saved: ${clean(output.automation.label || output.automation.automationId)} (${clean(output.automation.type)}, ${state}).`;
  }
  if (output.event) return `Automation ran now: ${clean(output.event.label || output.automationId || "timer")}.`;
  if (output.run) {
    const delivered = Array.isArray(output.run.delivered) ? output.run.delivered.length : 0;
    const skipped = Array.isArray(output.run.skipped) ? output.run.skipped.length : 0;
    return `Automation ran now: ${delivered} delivered${skipped ? `, ${skipped} skipped` : ""}.`;
  }
  if (output.ok !== undefined) return output.ok ? "Automation updated." : "Automation action failed.";
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
    else if (["orkestr_create_gmail_notification", "orkestr_update_gmail_notification", "orkestr_list_gmail_notifications", "orkestr_delete_gmail_notification", "orkestr_run_gmail_notification_now"].includes(result.name)) formatted = formatGmailNotificationTool(result);
    else if (["orkestr_modify_gmail_message", "orkestr_create_gmail_draft", "orkestr_send_gmail_draft", "orkestr_send_gmail_message", "orkestr_list_google_calendar_events", "orkestr_create_google_calendar_event", "orkestr_update_google_calendar_event", "orkestr_delete_google_calendar_event", "orkestr_get_google_drive_file"].includes(result.name)) formatted = formatGoogleWorkspaceTool(result);
    else if (["orkestr_list_files", "orkestr_read_file", "orkestr_write_file"].includes(result.name)) formatted = formatFileTool(result);
    else if (["orkestr_list_timers", "orkestr_create_timer", "orkestr_delete_timer", "orkestr_run_timer"].includes(result.name)) formatted = formatTimerTool(result);
    else if (result.name === "orkestr_list_action_registry") formatted = formatActionRegistryTool(result);
    else if (["orkestr_list_automations", "orkestr_create_automation", "orkestr_update_automation", "orkestr_delete_automation", "orkestr_run_automation", "orkestr_pause_automation", "orkestr_resume_automation"].includes(result.name)) formatted = formatAutomationTool(result);
    else if (result.name === "orkestr_fetch_web_page") formatted = fallbackWebFetchToolAnswer([result.output]);
    if (formatted) parts.push(formatted);
  }
  return parts.join("\n\n").trim();
}

function gmailNotificationToolResultsHaveFailure(toolResults = []) {
  return (Array.isArray(toolResults) ? toolResults : []).some((result) => {
    if (!["orkestr_create_gmail_notification", "orkestr_update_gmail_notification", "orkestr_delete_gmail_notification", "orkestr_run_gmail_notification_now"].includes(clean(result?.name))) return false;
    const output = result?.output || {};
    return output.ok === false || Boolean(clean(output.error));
  });
}

function gmailReadToolResultNeedsNarrativeRepair(toolResults = [], message = {}, gmailContext = null) {
  if (!Array.isArray(toolResults) || !toolResults.length) return false;
  const hasReadMessage = toolResults.some((result) =>
    ["orkestr_read_gmail_message", "orkestr_read_latest_gmail_message"].includes(result.name) &&
    result.output?.ok !== false &&
    result.output?.message
  );
  return hasReadMessage && (Boolean(gmailContext) || userMessageNeedsSubstantiveAnswer(message.text));
}

function firstEmailAddress(text = "") {
  return clean(clean(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "");
}

function fallbackGmailReadNarrativeAnswer(toolResults = [], message = {}, gmailContext = null) {
  const readResult = (Array.isArray(toolResults) ? toolResults : []).find((result) =>
    ["orkestr_read_gmail_message", "orkestr_read_latest_gmail_message"].includes(result.name) &&
    result.output?.ok !== false &&
    result.output?.message
  );
  const gmail = readResult?.output?.message;
  if (!gmail) return fallbackGmailContextAnswer(message, gmailContext);
  const body = compactField(gmail.text || gmail.snippet, 900);
  const supportEmail = firstEmailAddress(body);
  return [
    `I read the Gmail message: ${compactField(gmail.subject || gmailContext?.subject || "(no subject)", 220)}.`,
    clean(gmail.from || gmailContext?.from) ? `From: ${clean(gmail.from || gmailContext?.from)}` : "",
    body ? `What it says: ${body}` : "",
    "I did not cancel, send, delete, archive, or modify anything.",
    [
      "For your request, this email gives the message content and transaction/support context.",
      supportEmail ? `The support contact shown is ${supportEmail}.` : "",
      "I can draft a support/cancellation/dispute message from these details, or search Gmail for a separate subscription or billing-agreement email.",
    ].filter(Boolean).join(" "),
  ].filter(Boolean).join("\n\n");
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
  if (id === "timers") return ["list", "create", "update", "pause", "resume", "delete", "run", "automations"];
  if (id === "gmail") return ["status", "search", "read", "notify", "list_notifications", "automations"];
  if (["outlook", "jira", "shopify", "whatsapp"].includes(id)) return ["status"];
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

export function publicTenantCapabilities(capabilities = {}, env = process.env) {
  const scopedConnectors = capabilities.scopedConnectors && typeof capabilities.scopedConnectors === "object" ? capabilities.scopedConnectors : {};
  const connectorAuth = capabilities.connectorAuth && typeof capabilities.connectorAuth === "object" ? capabilities.connectorAuth : {};
  const skills = publicSkillContext(capabilities.skills, capabilities, scopedConnectors);
  const workspaceExecutionAvailable = codexEscalationAvailable(env);
  return {
    files: capabilities.files === true,
    timers: capabilities.timers === true,
    desktops: capabilities.desktopLeases === true || capabilities.virtualBrowsers === true,
    whatsapp: capabilities.whatsapp === true,
    gmail: capabilities.gmail === true,
    outlook: capabilities.outlook === true,
    linkedin: capabilities.linkedin === true,
    learning: capabilities.learning === true,
    workspace: {
      executionAvailable: workspaceExecutionAvailable,
      command: workspaceExecutionAvailable ? "/codex" : "",
    },
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
        capabilities: Array.isArray(status.capabilities) ? status.capabilities.map(clean).filter(Boolean) : [],
        capabilityLabels: Array.isArray(status.capabilityLabels) ? status.capabilityLabels.map(clean).filter(Boolean) : [],
      }];
    })),
  };
}

function fallbackCapabilitySkills() {
  return builtinUserSkillDefinitions().map((skill) => ({
    id: clean(skill.id),
    name: clean(skill.label || skill.id),
    label: clean(skill.label || skill.id),
    description: clean(skill.summary),
    summary: clean(skill.summary),
    instructions: "",
    category: clean(skill.category || "user"),
    enabled: ["whereiam", "timers", "whatsapp"].includes(clean(skill.id)),
    enabledByDefault: skill.enabledByDefault !== false,
    builtIn: true,
    createdBy: "system",
    scopes: Array.isArray(skill.scopes) ? [...skill.scopes] : [],
    requiresConnector: clean(skill.requiresConnector),
    requiresDesktop: clean(skill.requiresDesktop),
  }));
}

function fallbackCapabilitiesForThread(thread = {}, env = process.env, error = null) {
  const hasWhatsApp = Boolean(thread?.binding?.connector === "whatsapp" || thread?.binding?.chatId);
  const reason = clean(error?.message || error || "capability_lookup_failed");
  return {
    threads: true,
    whereiam: true,
    files: false,
    timers: true,
    virtualBrowsers: false,
    desktopLeases: false,
    whatsapp: hasWhatsApp,
    gmail: false,
    outlook: false,
    linkedin: false,
    learning: false,
    hostSkills: false,
    globalConnectorAccounts: false,
    privateOperatorData: false,
    skillRegistry: {
      userId: threadOwnerUserId(thread, env),
      source: "capability-lookup-fallback",
      userFound: false,
      error: reason,
    },
    enabledSkills: hasWhatsApp ? ["whereiam", "timers", "whatsapp"] : ["whereiam", "timers"],
    disabledSkills: [],
    skills: fallbackCapabilitySkills(),
    scopedConnectors: {
      whatsapp: hasWhatsApp,
      gmail: false,
      outlook: false,
      jira: false,
      shopify: false,
      linkedin: false,
    },
    connectorAuth: {},
    capabilityDecision: {
      result: "fallback",
      reason,
      timers: {
        available: true,
        reason: "timer_builtin_fallback",
      },
    },
  };
}

export async function scopedCapabilitiesForThread(thread = {}, env = process.env) {
  try {
    return await userScopedCapabilityHints({ userId: threadOwnerUserId(thread, env), thread }, env);
  } catch (error) {
    const fallback = fallbackCapabilitiesForThread(thread, env, error);
    await appendApiAgentCapabilityDecision({
      threadId: thread.id,
      ownerUserId: threadOwnerUserId(thread, env),
      action: "capability_lookup",
      capability: "timers",
      result: "fallback_available",
      reason: fallback.capabilityDecision.reason,
      retryable: true,
      targetInstanceId: clean(fallback.skillRegistry?.source),
    }, env);
    return fallback;
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
  const codexAvailable = codexEscalationAvailable(env);
  const webFetch = context.capabilities.webFetch === true;
  return [
    "You are the user-facing assistant for one Orkestr tenant chat.",
    "Treat this as a real conversation in the user's chat, not as a job runner that answers normal messages with a completion token.",
    codexAvailable
      ? "Be natural, concise, and helpful. Do not expose Orkestr internals, workspace runtime details, queues, tmux, shell paths, debug strings, or implementation wording unless the user explicitly asks about Orkestr operations."
      : "Be natural, concise, and helpful. Do not expose Orkestr internals, runtime details, queues, tmux, shell paths, debug strings, or implementation wording unless the user explicitly asks about Orkestr operations.",
    "Never mention internal JSON field names, runtime flags, capability keys, or redaction placeholders. Convert capabilities into plain user-facing language, and do not quote bracketed placeholder text from prior messages.",
    "You are scoped to the tenant in the JSON context below. Do not claim access to files, Gmail, Outlook, LinkedIn, WhatsApp accounts, browser desktops, timers, or other chats unless the provided Orkestr tools or context show them for this tenant.",
    "Use the recent message history for conversational identity. If the user says their name or identity, acknowledge it and use it in later turns. If the user asks 'who am I?', answer from the conversation and the Tenant context instead of asking a vague clarification.",
    "When the user shares non-secret onboarding details, preferences, timezone, language, requested tools, or setup notes, save them with the onboarding profile tool. Never store passwords, tokens, recovery codes, or secrets.",
    "For reminders, timers, calendar scheduling, daily summaries, or any other time-specific instruction, use Tenant context JSON onboardingProfile.timezone when it is present. If it is missing, ask the user for their IANA timezone before scheduling or giving time-specific instructions. When the user gives a timezone, call orkestr_update_onboarding_profile before continuing.",
    codexAvailable
      ? "If the user asks how you can help, what you can do, or what skills you have, answer with a short capability summary grounded in the Tenant context and enabled skills. For workspace/code execution, mention /codex as the explicit escalation path."
      : "If the user asks how you can help, what you can do, or what skills you have, answer with a short capability summary grounded in the Tenant context and enabled skills. Workspace/code execution is not available in this chat right now; do not mention a slash-command escalation path.",
    "Never answer a normal chat question, introduction, or capability question with only 'Done', 'OK', 'Sure', or another bare acknowledgement.",
    "Use the provided Orkestr tools for tenant-scoped resources. If the user asks whether Gmail, Outlook, Jira, Shopify, or WhatsApp is connected, available, enabled, or accessible, use the connector status tool before answering.",
    "If the user asks to connect, sign in, log in, set up, disconnect, or reconnect Gmail, Outlook, Jira, or Shopify, use the connector auth/disconnect tools and give the returned sign-in instructions. If they ask for Google Workspace with selectable Gmail, Calendar, or Drive permissions from WhatsApp, tell them to send /connect google.",
    "For Gmail sign-in, if the user did not provide the exact Gmail address they want to connect, ask for that address before starting auth. If Orkestr reports that the address is not approved for Google testing, explain that it must be added as a Google OAuth test user first and do not send a sign-in link.",
    "Connector setup is user-owned by default. When a connector is not connected or a matching capability is false, say that it is not connected for this chat yet and that you can help set it up here.",
    "Only say setup is unavailable on this Orkestr installation if a tool or Tenant context explicitly reports missing parent app/platform configuration. Even then, do not offer an admin note or tell the user to contact an admin unless the user explicitly asks how to escalate setup.",
    "If the user asks to use Gmail, Outlook, LinkedIn, files, or a browser desktop and the matching capability is false in the Tenant context JSON, say plainly that it is not connected or enabled for this chat yet. Do not imply that you checked it unless you used a tool.",
    "Do not tell contained users to open, check, or use the Orkestr UI for connector setup. This chat is the user surface; connector setup should happen through the sign-in instructions you provide in chat when parent app credentials exist.",
    "When Gmail capability is true and the user asks to search, list, open, read, inspect, or summarize Gmail, use the scoped Gmail tools directly. The user's request is consent for that same-user Gmail action; do not ask for repeated confirmation unless the target email or search is ambiguous.",
    "When Gmail capability is true and the Tenant connectorAuth.gmail capabilities include Gmail actions, Gmail send, Calendar read, Calendar actions, or Drive selected files, use the matching Google Workspace tools. For sending email, require explicit approval of recipients, subject, and body before sending; drafts may be created when the user asks to draft. For Calendar actions, require explicit approval of the calendar, title, time, and changed/deleted event before creating, updating, or deleting events.",
    "When Gmail capability is true and the user asks to notify, alert, push, monitor, or periodically check new Gmail in this chat, call a Gmail notification or generic automation tool in that turn to create or manage the rule. Do not ask for yes/no confirmation when the safe defaults are enough; the user's request is consent for a same-chat notification rule. Use the safe default query when the user did not specify a narrower query, and explain after the tool result if the requested interval was rounded up by policy.",
    actionRegistryInstructions(),
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
      ? "If the user asks for code/workspace execution, ask them to send the same task with /codex to explicitly escalate to a contained workspace worker."
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
  if (lowered.includes("target_instance_unhealthy")) return "This Orkestr instance is temporarily unavailable for this chat. Please resend the message after it comes back online.";
  if (lowered.includes("timer")) return "Timers are not available for this chat right now. Please try again in a moment.";
  if (lowered.includes("gmail_oauth_config_required")) return "Gmail sign-in is not available on this Orkestr installation yet because the Gmail app credentials are not configured.";
  if (lowered.includes("gmail_account_required_for_tester_check")) return gmailAddressRequiredForTestingAnswer();
  if (lowered.includes("gmail_account_not_approved_for_testing")) return "Gmail sign-in cannot start for that address because this Google OAuth app is still in testing mode and the address is not on the approved test-user list. Add it as a Google OAuth test user first, then try again.";
  if (lowered.includes("gmail_notifications_disabled")) return "Gmail background notifications are not enabled on this Orkestr installation yet.";
  if (lowered.includes("connector_prompt_push") && lowered.includes("capability")) return "Gmail is not connected or enabled for this chat yet. Ask me to connect Gmail and I will send a Google sign-in link.";
  if (lowered.includes("connector_prompt_push") || (lowered.includes("gmail") && /\b(?:push|notification|notify|poll|every|background)\b/.test(lowered))) return "I couldn't manage Gmail notifications for this chat right now. Please try again in a moment.";
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
      sourceEventId: message.sourceEventId || "",
      routerTraceId: message.routerTraceId || "",
      turnId: message.turnId || "",
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
    text: "I moved this request to a contained workspace worker for execution.",
    parentMessageId: message.id,
    state: "completed",
    connector: message.connector,
    chatId: message.chatId,
    accountId: message.accountId,
    sourceEventId: message.sourceEventId || "",
    routerTraceId: message.routerTraceId || "",
    turnId: message.turnId || "",
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

async function repairWeakTenantApiAgentResponse({
  baseBody,
  inputItems,
  thread,
  message,
  text,
  principal = null,
  pendingAction = null,
  gmailContext = null,
  env,
  fetchImpl,
  allowTools = false,
}) {
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
      "If tenant tool results are present in the conversation, answer the user's latest request from those results instead of returning a raw tool dump or a generic capability fallback.",
      allowTools
        ? "If the latest user message asks for an Orkestr action and a matching tool is available, call the tool before finalizing."
        : "Do not use tools during this repair step.",
      gmailContextInstructions(message, gmailContext),
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
  if (!allowTools) {
    delete repairBody.tools;
    delete repairBody.tool_choice;
    delete repairBody.parallel_tool_calls;
  }
  const response = await postOpenAIResponse(repairBody, env, fetchImpl, `orkestr-${thread.id}-${message.id}-repair`);
  await recordResponseUsage({ response, thread, message, callKind: "assistant_repair" }, env);
  if (allowTools && responseFunctionCalls(response).length) {
    return runTenantApiAgentToolResultResponse({
      baseBody: repairBody,
      inputItems: repairBody.input,
      responseWithCalls: response,
      thread,
      message,
      principal,
      pendingAction,
      gmailContext,
      env,
      fetchImpl,
      idempotencySuffix: "repair-2",
      callKind: "assistant_repair_tool_result",
    });
  }
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
  gmailContext = null,
  env,
  fetchImpl,
  idempotencySuffix = "2",
  callKind = "assistant_tool_result",
  fallbackFromToolOutputs = null,
  toolDepth = 1,
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
      const capabilities = await scopedCapabilitiesForThread(thread, env);
      const capability = apiAgentToolCapability(call.name);
      if (capability) {
        await appendApiAgentCapabilityDecision({
          threadId: thread.id,
          messageId: message.id,
          ownerUserId: threadOwnerUserId(thread, env),
          action: "api_agent_tool_call",
          tool: call.name,
          capability,
          result: capabilityAvailable(capabilities, capability) ? "available" : "unavailable",
          reason: capabilityAvailable(capabilities, capability) ? "capability_true" : "capability_false",
        }, env);
      }
      await assertSanitizedAction({
        action: `api-agent.tool.${call.name}`,
        principal,
        resource: {
          type: "thread",
          id: thread.id,
          ownerUserId: threadOwnerUserId(thread, env),
          capabilities,
        },
        input: { tool: call.name, args },
      }, env);
      output = await runTenantApiAgentTool(call.name, args, { principal, thread, fetchImpl }, env);
    } catch (error) {
      output = { ok: false, error: clean(error?.message || error || "tool_failed") };
      const failure = routingFailureFromError(error, {
        capability: apiAgentToolCapability(call.name),
        threadId: thread.id,
        retryable: false,
      });
      if (failure.capability) {
        output.routingFailure = failure;
        await appendApiAgentCapabilityDecision({
          threadId: thread.id,
          messageId: message.id,
          ownerUserId: threadOwnerUserId(thread, env),
          action: "api_agent_tool_error",
          tool: call.name,
          capability: failure.capability,
          result: "failed",
          reason: failure.code,
          retryable: failure.retryable,
        }, env);
      }
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
  if (responseFunctionCalls(second).length && toolDepth < 3) {
    return runTenantApiAgentToolResultResponse({
      baseBody,
      inputItems: toolInput,
      responseWithCalls: second,
      thread,
      message,
      principal,
      pendingAction,
      gmailContext,
      env,
      fetchImpl,
      idempotencySuffix: `${idempotencySuffix}-${toolDepth + 1}`,
      callKind: `${callKind}_next`,
      fallbackFromToolOutputs,
      toolDepth: toolDepth + 1,
    });
  }
  const text = responseText(second);
  const customFallback = typeof fallbackFromToolOutputs === "function" ? clean(fallbackFromToolOutputs(toolOutputs, { message, text })) : "";
  const toolFallback = clean(formatToolResultFallback(toolResults, { message, text, pendingAction, env }));
  const fallback = customFallback || toolFallback;
  const repairGmailReadNarrative = gmailReadToolResultNeedsNarrativeRepair(toolResults, message, gmailContext);
  if (fallback && shouldPreferWebFetchFallback(text, fallback, message)) return { response: second, text: fallback };
  if (fallback && gmailNotificationToolResultsHaveFailure(toolResults) && !repairGmailReadNarrative) return { response: second, text: fallback };
  if (fallback && genericToolFallbackText(text) && !repairGmailReadNarrative) return { response: second, text: fallback };
  if (!repairGmailReadNarrative && !tenantApiAgentTextNeedsRepair(text, message, { pendingActionConfirmation: Boolean(pendingAction), gmailContext, env })) return { response: second, text };
  if (fallback && !repairGmailReadNarrative) return { response: second, text: fallback };
  const repaired = await repairWeakTenantApiAgentResponse({
    baseBody,
    inputItems: toolInput,
    thread,
    message,
    text,
    principal,
    pendingAction,
    gmailContext,
    env,
    fetchImpl,
  });
  const repairedText = responseText(repaired.response) || repaired.text;
  if (fallback && genericToolFallbackText(repairedText)) {
    return {
      response: repaired.response,
      text: repairGmailReadNarrative ? fallbackGmailReadNarrativeAnswer(toolResults, message, gmailContext) : fallback,
    };
  }
  return {
    response: repaired.response,
    text: tenantApiAgentTextNeedsRepair(repairedText, message, { pendingActionConfirmation: Boolean(pendingAction), gmailContext, env })
      ? repairGmailReadNarrative
        ? fallbackGmailReadNarrativeAnswer(toolResults, message, gmailContext)
        : fallbackTenantApiAgentRepairAnswer(message, {
          pendingActionConfirmation: Boolean(pendingAction),
          originalText: text,
          repairedText,
          gmailContext,
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
  const gmailContext = latestGmailPromptPushBefore(messages, message);
  const instructions = [
    await buildTenantApiAgentInstructions(thread, messages, env),
    gmailContextInstructions(message, gmailContext),
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
    if (!tenantApiAgentTextNeedsRepair(text, message, { pendingActionConfirmation: Boolean(pendingAction), gmailContext, env })) return { response: first, text };
    const repaired = await repairWeakTenantApiAgentResponse({
      baseBody,
      inputItems: input,
      thread,
      message,
      text,
      principal,
      pendingAction,
      gmailContext,
      env,
      fetchImpl,
      allowTools: true,
    });
    return {
      response: repaired.response,
      text: tenantApiAgentTextNeedsRepair(repaired.text, message, { pendingActionConfirmation: Boolean(pendingAction), gmailContext, env })
        ? fallbackTenantApiAgentRepairAnswer(message, {
          pendingActionConfirmation: Boolean(pendingAction),
          originalText: text,
          repairedText: repaired.text,
          gmailContext,
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
    gmailContext,
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
    sourceEventId: message.sourceEventId || "",
    routerTraceId: message.routerTraceId || "",
    turnId: message.turnId || "",
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
  await recordApiAgentFailureSuggestion({ thread, message, error }, env).catch(() => null);
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
    sourceEventId: message.sourceEventId || "",
    routerTraceId: message.routerTraceId || "",
    turnId: message.turnId || "",
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
  const requestedCapability = messageCapabilityIntent(message.text);
  if (requestedCapability) {
    await appendApiAgentCapabilityDecision({
      threadId: thread.id,
      messageId: message.id,
      ownerUserId: threadOwnerUserId(thread, env),
      action: "api_agent_input",
      capability: requestedCapability,
      result: capabilityAvailable(capabilities, requestedCapability) ? "available" : "unavailable",
      reason: capabilityAvailable(capabilities, requestedCapability) ? "capability_true" : "capability_false",
    }, env);
  }
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
  const gmailContext = latestGmailPromptPushBefore(latestMessages, message);
  const text = normalizeTenantApiAgentText(clean(result.text) || fallbackTenantApiAgentRepairAnswer(message, { gmailContext, env })) ||
    fallbackTenantApiAgentRepairAnswer(message, { gmailContext, env });
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
