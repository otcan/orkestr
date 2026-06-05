import { appendEvent } from "../../storage/src/store.js";
import { sendEmail } from "./email-notifications.js";
import { appendThreadMessage, createThread, getThread } from "./threads.js";
import { adminUserId, normalizeUserId } from "./users.js";

const suggestionThreadId = "ops-api-agent-suggestions";

function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => clean(item))
    .filter(Boolean);
}

function clip(value = "", max = 1600) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function suggestionText({ thread = {}, message = {}, error = "" } = {}) {
  return [
    "API-agent failure suggestion",
    "",
    `Thread: ${clean(thread.id) || "(unknown)"}`,
    `Owner: ${clean(thread.ownerUserId || thread.userId) || "(unknown)"}`,
    `Message: ${clean(message.id) || "(unknown)"}`,
    `Source: ${clean(message.source) || "(unknown)"}`,
    `Connector: ${clean(message.connector) || "(none)"}`,
    `Error: ${clip(error, 500) || "(unknown)"}`,
    "",
    "Suggested follow-up:",
    "Review whether the failed request needed a missing provider + verb + object action, a stricter tool result contract, or a connector capability/status tool. Add the action to the registry and prefer model-selected tools over pre-model natural-language routing.",
    "",
    "User text:",
    clip(message.text || "", 1600),
  ].join("\n");
}

async function ensureSuggestionThread(env = process.env) {
  const existing = await getThread(suggestionThreadId, env).catch(() => null);
  if (existing) return existing;
  return createThread({
    id: suggestionThreadId,
    ownerUserId: normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId),
    name: "API Agent Suggestions",
    title: "API Agent Suggestions",
    runtimeKind: "api-agent-suggestions",
    wakePolicy: "manual",
  }, env);
}

export async function recordApiAgentFailureSuggestion({ thread = {}, message = {}, error = null } = {}, env = process.env) {
  const errorText = clean(error?.message || error || "");
  const text = suggestionText({ thread, message, error: errorText });
  let suggestionThread = null;
  let email = null;
  try {
    suggestionThread = await ensureSuggestionThread(env);
    await appendThreadMessage(suggestionThread.id, {
      role: "user",
      source: "api-agent-suggestion",
      phase: "final_answer",
      text,
      state: "completed",
      connector: "",
    }, env);
  } catch (suggestionError) {
    await appendEvent({
      type: "api_agent_failure_suggestion_thread_failed",
      threadId: clean(thread.id),
      messageId: clean(message.id),
      error: clean(suggestionError?.message || suggestionError),
    }, env).catch(() => {});
  }

  const recipients = splitList(env.ORKESTR_API_AGENT_SUGGESTION_EMAILS || env.ORKESTR_API_AGENT_SUGGESTION_EMAIL);
  if (recipients.length) {
    email = await sendEmail({
      to: recipients,
      subject: `Orkestr API-agent suggestion: ${clean(thread.id) || "unknown thread"}`,
      text,
    }, env).catch((emailError) => ({ ok: false, error: clean(emailError?.message || emailError) }));
  }

  await appendEvent({
    type: "api_agent_failure_suggestion_recorded",
    threadId: clean(thread.id),
    messageId: clean(message.id),
    suggestionThreadId,
    emailConfigured: recipients.length > 0,
    emailOk: email?.ok === true,
    emailSkippedReason: clean(email?.skippedReason || email?.error),
  }, env).catch(() => {});
  return { ok: true, suggestionThreadId: suggestionThread?.id || suggestionThreadId, email: email || null };
}
