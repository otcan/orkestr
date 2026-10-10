// WhatsApp messages as Agent Job triggers (owner decision 2026-10-10).
// Called from the existing inbound router (routeWhatsAppInbound); no new
// connector. A message starts a run only when:
//   * it was posted in the trigger's configured group (chat id or binding ref),
//   * its sender is on the trigger's allowlist, and
//   * it matches the optional `match` pattern.
// DMs and unknown senders are never accepted; the rejection is audited
// without the message text. The run_key dedupes on the WhatsApp message id,
// and the message plus its quoted/reply context is the run's trigger event.
// Allowlisted senders can also answer approvals of that job in the same group
// with "approve <approval-id>" or "deny <approval-id>".
import fs from "node:fs/promises";
import { admitRun } from "../../core/src/agent-job-admission.js";
import { decideApproval, getApproval } from "../../core/src/agent-job-ledger.js";
import { kickAgentJobRun } from "../../core/src/agent-job-scheduler.js";
import { agentJobDbPath, getRegisteredJob, getRun, listRegisteredJobs, recordTriggerAudit } from "../../core/src/agent-job-store.js";
import { readWhatsAppBindingRecords } from "./whatsapp-binding-registry.js";
import { comparableParticipantId, isWhatsAppGroupChatId } from "./whatsapp-inbound-routing.js";

const APPROVAL_RE = /^\s*(approve|deny)\s+(apr_[A-Za-z0-9_-]{4,64})\b/i;

function pick(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

async function whatsappTriggers(env) {
  const out = [];
  for (const { name } of await listRegisteredJobs(env)) {
    const job = await getRegisteredJob(name, env);
    (job?.spec?.triggers || []).forEach((trigger, index) => {
      if (trigger.type === "whatsapp") out.push({ job: name, index, trigger });
    });
  }
  return out;
}

async function groupChatId(group, env, cache) {
  if (!String(group || "").startsWith("binding:")) return String(group || "");
  if (!cache.bindings) cache.bindings = await readWhatsAppBindingRecords(env).catch(() => []);
  const binding = cache.bindings.find((entry) => entry.id === group.slice("binding:".length));
  return binding?.chatId && isWhatsAppGroupChatId(binding.chatId) ? binding.chatId : "";
}

function senderAllowed(trigger, sender) {
  return Boolean(sender) && trigger.senders.some((entry) => comparableParticipantId(entry) === sender);
}

// Normalize the router input into the trigger event the job receives.
export function whatsappTriggerEvent(input = {}) {
  const quoted = input.quoted && typeof input.quoted === "object" ? input.quoted : null;
  return {
    source: "whatsapp",
    messageId: pick(input.eventId, input.id, input.messageId),
    chatId: pick(input.chatId, input.chat?.id),
    accountId: pick(input.accountId),
    sender: pick(input.author, input.from, input.sender),
    text: String(input.text ?? input.body ?? ""),
    quoted: quoted ? {
      messageId: pick(quoted.messageId, quoted.id) || null,
      sender: pick(quoted.from, quoted.author, quoted.sender) || null,
      text: String(quoted.text ?? quoted.body ?? ""),
    } : null,
    receivedAt: pick(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
}

async function handleApprovalReply(match, { sender, chatId, messageId }, triggers, env, cache) {
  const approval = await getApproval(match[2], env).catch(() => null);
  const run = approval ? await getRun(approval.runId, env) : null;
  let allowed = false;
  for (const entry of triggers.filter((item) => item.job === run?.job)) {
    if ((await groupChatId(entry.trigger.group, env, cache)) === chatId && senderAllowed(entry.trigger, sender)) allowed = true;
  }
  if (!allowed) {
    await recordTriggerAudit({ job: run?.job || null, type: "whatsapp", outcome: "rejected", reason: "approval_sender_not_allowed", sourceRef: messageId, sender, chatId }, env);
    return { handled: true, decided: false, reason: "approval_sender_not_allowed" };
  }
  const decision = match[1].toLowerCase() === "approve" ? "approved" : "denied";
  try {
    await decideApproval(approval.approvalId, { decision, by: `whatsapp:${sender}`, comment: `whatsapp message ${messageId}` }, env);
  } catch (error) {
    return { handled: true, decided: false, reason: error?.code || "approval_failed" };
  }
  kickAgentJobRun(approval.runId);
  return { handled: true, decided: true, decision, approvalId: approval.approvalId };
}

/**
 * Offer one routed WhatsApp message to the Agent Job triggers.
 * Returns { admitted: [...], rejected: [...] } (or { skipped }); never throws
 * for policy reasons, so normal thread routing is unaffected.
 */
export async function dispatchWhatsAppJobTriggers(input = {}, env = process.env) {
  // No job store yet means no jobs: do not create one for every message.
  if (!(await fs.stat(await agentJobDbPath(env)).catch(() => null))) return { skipped: "no_agent_jobs" };
  const event = whatsappTriggerEvent(input);
  if (!event.messageId || !event.chatId) return { skipped: "missing_message_id" };
  const triggers = await whatsappTriggers(env);
  if (!triggers.length) return { skipped: "no_whatsapp_triggers" };
  const sender = comparableParticipantId(event.sender);
  const cache = {};
  const audit = (job, outcome, reason, runId = null) => recordTriggerAudit({
    job, type: "whatsapp", outcome, reason, sourceRef: event.messageId, sender: sender || null, chatId: event.chatId, runId,
  }, env);

  if (input.fromMe === true) return { skipped: "from_me" };
  if (!isWhatsAppGroupChatId(event.chatId)) {
    // Only audit DMs from people who could trigger a job in a group.
    const relevant = triggers.filter((entry) => senderAllowed(entry.trigger, sender));
    for (const entry of relevant) await audit(entry.job, "rejected", "dm_not_accepted");
    return { skipped: "not_a_group", rejected: relevant.map((entry) => entry.job) };
  }

  const inGroup = [];
  for (const entry of triggers) {
    if ((await groupChatId(entry.trigger.group, env, cache)) === event.chatId) inGroup.push(entry);
  }
  if (!inGroup.length) return { skipped: "group_not_configured" };

  const approvalMatch = event.text.match(APPROVAL_RE);
  if (approvalMatch) return handleApprovalReply(approvalMatch, { sender, chatId: event.chatId, messageId: event.messageId }, triggers, env, cache);

  const admitted = [];
  const rejected = [];
  for (const entry of inGroup) {
    if (!senderAllowed(entry.trigger, sender)) {
      await audit(entry.job, "rejected", "sender_not_allowed");
      rejected.push({ job: entry.job, reason: "sender_not_allowed" });
      continue;
    }
    if (entry.trigger.match && !new RegExp(entry.trigger.match, "i").test(event.text)) {
      await audit(entry.job, "ignored", "no_match");
      continue;
    }
    try {
      const result = await admitRun({ job: entry.job, type: "whatsapp", index: entry.index, dedupeKey: event.messageId, body: event }, env);
      if (!result.deduplicated) {
        await audit(entry.job, "accepted", null, result.run.id);
        kickAgentJobRun(result.run.id);
      }
      admitted.push({ job: entry.job, runId: result.run.id, deduplicated: result.deduplicated });
    } catch (error) {
      // admitRun already audits provider refusals.
      if (error?.code !== "provider_not_connected") await audit(entry.job, "rejected", error?.code || "admit_failed");
      rejected.push({ job: entry.job, reason: error?.code || "admit_failed" });
    }
  }
  return { admitted, rejected };
}
