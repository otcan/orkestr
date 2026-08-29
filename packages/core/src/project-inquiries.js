import { createHash, randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { sendProjectInquiryNotification } from "./project-inquiry-notifications.js";

const projectTypes = new Set(["build", "replace", "find", "collect", "automate", "not-sure"]);
const timeframes = new Set(["as-soon-as-practical", "1-3-months", "3-6-months", "6-plus-months", "exploring"]);

function clean(value = "") { return String(value || "").trim(); }
function lower(value = "") { return clean(value).toLowerCase(); }
function bool(value) { return value === true || value === "true" || value === 1 || value === "1"; }
function nowIso() { return new Date().toISOString(); }

function projectInquiryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function required(value, name, max) {
  const text = clean(value);
  if (!text) throw projectInquiryError(`project_${name}_required`, 400);
  if (text.length > max) throw projectInquiryError(`project_${name}_too_long`, 400);
  return text;
}

function validEmail(value) {
  const email = lower(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw projectInquiryError("project_email_invalid", 400);
  return email;
}

function readiness(inquiry) {
  const checks = {
    category: inquiry.projectType !== "not-sure",
    outcome: inquiry.desiredOutcome.length >= 80,
    context: inquiry.currentSituation.length >= 40,
    owner: Boolean(inquiry.decisionOwner),
    success: inquiry.successCriteria.length >= 30,
    timeframe: inquiry.timeframe !== "exploring",
  };
  const score = Object.values(checks).filter(Boolean).length;
  return { ready: score >= 5 && checks.category && checks.owner && checks.success, score, checks };
}

function schedulingUrlFor(inquiry, env = process.env) {
  if (!inquiry.readiness?.ready) return "";
  const configured = clean(env.ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL);
  if (!configured) return "";
  try {
    const url = new URL(configured);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname) return "";
    return url.toString();
  } catch { return ""; }
}

function normalizeInput(input = {}) {
  if (clean(input.companyWebsite)) throw projectInquiryError("project_submit_rejected", 400);
  const started = Number(input.formStartedAt || 0);
  if (started > 0 && Date.now() - started < 1200) throw projectInquiryError("project_submit_too_fast", 400);
  const projectType = lower(input.projectType);
  const timeframe = lower(input.timeframe);
  if (!projectTypes.has(projectType)) throw projectInquiryError("project_type_invalid", 400);
  if (!timeframes.has(timeframe)) throw projectInquiryError("project_timeframe_invalid", 400);
  if (!bool(input.consentToContact)) throw projectInquiryError("project_contact_consent_required", 400);
  const inquiry = {
    contactName: required(input.contactName, "contact_name", 120),
    workEmail: validEmail(input.workEmail),
    company: required(input.company, "company", 160),
    role: required(input.role, "role", 160),
    projectType,
    projectName: required(input.projectName, "name", 160),
    desiredOutcome: required(input.desiredOutcome, "desired_outcome", 2400),
    currentSituation: required(input.currentSituation, "current_situation", 2000),
    usersAndVolume: required(input.usersAndVolume, "users_and_volume", 1200),
    systemsOrSources: required(input.systemsOrSources, "systems_or_sources", 1600),
    decisionOwner: required(input.decisionOwner, "decision_owner", 200),
    constraints: required(input.constraints, "constraints", 1600),
    successCriteria: required(input.successCriteria, "success_criteria", 1600),
    timeframe,
    consentToContact: true,
  };
  return { ...inquiry, readiness: readiness(inquiry) };
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

function publicResult(inquiry, env) {
  return {
    id: inquiry.id,
    status: inquiry.status,
    readyForDiscovery: Boolean(inquiry.readiness?.ready),
    schedulingUrl: schedulingUrlFor(inquiry, env) || undefined,
  };
}

function dedupeKey(inquiry) {
  return createHash("sha256").update(`${inquiry.workEmail}\n${lower(inquiry.company)}\n${lower(inquiry.projectName)}`).digest("hex");
}

async function readState(env) {
  const state = await readJson(dataPaths(env).projectInquiries, { version: 1, inquiries: [] });
  return { version: 1, inquiries: Array.isArray(state?.inquiries) ? state.inquiries : [] };
}

export async function submitProjectInquiry(input = {}, env = process.env, deps = {}) {
  const normalized = normalizeInput(input);
  const state = await readState(env);
  const key = dedupeKey(normalized);
  const duplicate = state.inquiries.find((item) => item.dedupeKey === key && Date.now() - Date.parse(item.createdAt || 0) < 24 * 60 * 60 * 1000);
  if (duplicate) {
    return { ok: true, submitted: false, message: "This project is already queued for review.", inquiry: publicResult(duplicate, env) };
  }
  const createdAt = nowIso();
  let inquiry = {
    id: `prj_${randomUUID()}`,
    status: "submitted",
    ...normalized,
    dedupeKey: key,
    createdAt,
    updatedAt: createdAt,
    notification: notificationRecord(),
  };
  state.inquiries.push(inquiry);
  await writeJson(dataPaths(env).projectInquiries, state);
  await appendEvent({ type: "project_inquiry_submitted", projectInquiryId: inquiry.id, readyForDiscovery: inquiry.readiness.ready }, env);
  const notify = deps.sendProjectInquiryNotification || sendProjectInquiryNotification;
  try {
    const result = await notify(inquiry, env);
    inquiry = { ...inquiry, notification: notificationRecord({ state: result?.ok ? "sent" : "skipped", attemptedAt: nowIso(), recipients: result?.recipients, messageId: result?.messageId, skippedReason: result?.skippedReason }) };
  } catch (error) {
    inquiry = { ...inquiry, notification: notificationRecord({ state: "failed", attemptedAt: nowIso(), error: String(error?.message || error) }) };
  }
  state.inquiries[state.inquiries.length - 1] = inquiry;
  await writeJson(dataPaths(env).projectInquiries, state);
  return { ok: true, submitted: true, message: inquiry.readiness.ready ? "Your project is ready for Discovery review." : "Your project was submitted for review.", inquiry: publicResult(inquiry, env) };
}

export async function listProjectInquiries(env = process.env) {
  const state = await readState(env);
  return { inquiries: state.inquiries.map((inquiry) => ({ ...inquiry, dedupeKey: undefined })) };
}

export const __projectInquiryTestInternals = { normalizeInput, readiness, schedulingUrlFor };
