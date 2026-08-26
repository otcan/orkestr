import { createHash, randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { sendWorkflowLeadNotification } from "./workflow-lead-notifications.js";

const frequencies = new Set(["daily", "weekly", "monthly", "event-driven", "one-time"]);

function clean(value = "") { return String(value || "").trim(); }
function lower(value = "") { return clean(value).toLowerCase(); }
function bool(value) { return value === true || value === "true" || value === 1 || value === "1"; }
function nowIso() { return new Date().toISOString(); }

function workflowLeadError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function required(value, name, max) {
  const text = clean(value);
  if (!text) throw workflowLeadError(`workflow_${name}_required`, 400);
  if (text.length > max) throw workflowLeadError(`workflow_${name}_too_long`, 400);
  return text;
}

function validEmail(value) {
  const email = lower(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw workflowLeadError("workflow_email_invalid", 400);
  return email;
}

function systemCount(value) {
  return clean(value).split(/[\n,;→>]+/).map(clean).filter(Boolean).length;
}

function qualification(lead) {
  const checks = {
    repeated: lead.frequency !== "one-time",
    volume: lead.monthlyVolume >= 10,
    systemCrossing: systemCount(lead.systems) >= 2,
    owner: Boolean(lead.workflowOwner),
    approvalBoundary: Boolean(lead.approvals),
    measurablePain: Boolean(lead.costOrDelay && lead.successCriteria),
  };
  const score = Object.values(checks).filter(Boolean).length;
  return { qualified: score === Object.keys(checks).length, score, checks };
}

function schedulingUrlFor(lead, env = process.env) {
  if (!lead.qualification?.qualified) return "";
  const configured = clean(env.ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL);
  if (!configured) return "";
  try {
    const url = new URL(configured);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname) return "";
    return url.toString();
  } catch { return ""; }
}

function normalizeInput(input = {}) {
  if (clean(input.companyWebsite)) throw workflowLeadError("workflow_submit_rejected", 400);
  const started = Number(input.formStartedAt || 0);
  if (started > 0 && Date.now() - started < 1200) throw workflowLeadError("workflow_submit_too_fast", 400);
  const frequency = lower(input.frequency);
  if (!frequencies.has(frequency)) throw workflowLeadError("workflow_frequency_invalid", 400);
  const monthlyVolume = Number(input.monthlyVolume);
  if (!Number.isInteger(monthlyVolume) || monthlyVolume < 1 || monthlyVolume > 1_000_000) throw workflowLeadError("workflow_monthly_volume_invalid", 400);
  if (!bool(input.consentToContact)) throw workflowLeadError("workflow_contact_consent_required", 400);
  const lead = {
    contactName: required(input.contactName, "contact_name", 120),
    workEmail: validEmail(input.workEmail),
    company: required(input.company, "company", 160),
    role: required(input.role, "role", 160),
    workflowName: required(input.workflowName, "name", 160),
    workflowDescription: required(input.workflowDescription, "description", 2400),
    frequency,
    monthlyVolume,
    systems: required(input.systems, "systems", 1200),
    workflowOwner: required(input.workflowOwner, "owner", 200),
    approvals: required(input.approvals, "approvals", 1600),
    costOrDelay: required(input.costOrDelay, "cost_or_delay", 1600),
    successCriteria: required(input.successCriteria, "success_criteria", 1600),
    consentToContact: true,
  };
  return { ...lead, qualification: qualification(lead) };
}

function notificationRecord(value = {}) {
  return {
    state: clean(value.state || "pending"),
    attemptedAt: clean(value.attemptedAt),
    recipients: Array.isArray(value.recipients) ? value.recipients.map(clean).filter(Boolean) : [],
    messageId: clean(value.messageId),
    skippedReason: clean(value.skippedReason),
    error: clean(value.error),
  };
}

function publicResult(lead, env) {
  return {
    id: lead.id,
    status: lead.status,
    qualified: Boolean(lead.qualification?.qualified),
    schedulingUrl: schedulingUrlFor(lead, env) || undefined,
  };
}

function dedupeKey(lead) {
  return createHash("sha256").update(`${lead.workEmail}\n${lower(lead.company)}\n${lower(lead.workflowName)}`).digest("hex");
}

async function readState(env) {
  const state = await readJson(dataPaths(env).workflowLeads, { version: 1, leads: [] });
  return { version: 1, leads: Array.isArray(state?.leads) ? state.leads : [] };
}

export async function submitWorkflowLead(input = {}, env = process.env, deps = {}) {
  const normalized = normalizeInput(input);
  const state = await readState(env);
  const key = dedupeKey(normalized);
  const duplicate = state.leads.find((item) => item.dedupeKey === key && Date.now() - Date.parse(item.createdAt || 0) < 24 * 60 * 60 * 1000);
  if (duplicate) {
    return { ok: true, submitted: false, message: "This workflow map is already queued for review.", lead: publicResult(duplicate, env) };
  }
  const createdAt = nowIso();
  let lead = {
    id: `wfl_${randomUUID()}`,
    status: "submitted",
    ...normalized,
    dedupeKey: key,
    createdAt,
    updatedAt: createdAt,
    notification: notificationRecord(),
  };
  state.leads.push(lead);
  await writeJson(dataPaths(env).workflowLeads, state);
  await appendEvent({ type: "workflow_lead_submitted", workflowLeadId: lead.id, qualified: lead.qualification.qualified }, env);
  const notify = deps.sendWorkflowLeadNotification || sendWorkflowLeadNotification;
  try {
    const result = await notify(lead, env);
    lead = { ...lead, notification: notificationRecord({ state: result?.ok ? "sent" : "skipped", attemptedAt: nowIso(), recipients: result?.recipients, messageId: result?.messageId, skippedReason: result?.skippedReason }) };
  } catch (error) {
    lead = { ...lead, notification: notificationRecord({ state: "failed", attemptedAt: nowIso(), error: String(error?.message || error) }) };
  }
  state.leads[state.leads.length - 1] = lead;
  await writeJson(dataPaths(env).workflowLeads, state);
  return { ok: true, submitted: true, message: lead.qualification.qualified ? "Your workflow map is ready for qualification review." : "Your workflow map was submitted for review.", lead: publicResult(lead, env) };
}

export async function listWorkflowLeads(env = process.env) {
  const state = await readState(env);
  return { leads: state.leads.map((lead) => ({ ...lead, dedupeKey: undefined })) };
}

export const __workflowLeadTestInternals = { normalizeInput, qualification, systemCount, schedulingUrlFor };
