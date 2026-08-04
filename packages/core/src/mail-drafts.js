import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { sendEmail } from "./email-notifications.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal } from "./policy.js";
import { getThreadForPrincipal } from "./threads.js";
import { adminUserId, normalizeUserId } from "./users.js";

function clean(value = "") { return String(value || "").trim(); }
function nowIso(now = new Date()) { return now.toISOString(); }

function draftError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function draftsPath(env = process.env) { return dataPaths(env).mailDrafts; }

function normalizeAddressList(value = "") {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/g);
  const addresses = [...new Set(values.map((entry) => clean(entry).toLowerCase()).filter(Boolean))];
  if (addresses.some((address) => !/^[^\s@<>]+@[^\s@<>]+$/.test(address))) throw draftError("mail_draft_recipient_invalid");
  return addresses.slice(0, 50);
}

function normalizeDraft(draft = {}) {
  const status = ["draft", "sent", "send_failed"].includes(clean(draft.status)) ? clean(draft.status) : "draft";
  return {
    id: clean(draft.id) || randomUUID(),
    ownerUserId: normalizeUserId(draft.ownerUserId || draft.userId || adminUserId),
    threadId: clean(draft.threadId),
    to: normalizeAddressList(draft.to || []),
    subject: clean(draft.subject).replace(/[\r\n]+/g, " ").slice(0, 500),
    body: String(draft.body || "").replace(/\u0000/g, "").slice(0, 50_000),
    status,
    provider: clean(draft.provider).slice(0, 80),
    createdAt: clean(draft.createdAt) || nowIso(),
    updatedAt: clean(draft.updatedAt) || nowIso(),
    sentAt: clean(draft.sentAt),
    lastError: clean(draft.lastError).slice(0, 500),
  };
}

async function readDraftStore(env = process.env) {
  const payload = await readJson(draftsPath(env), { schemaVersion: 1, drafts: [] });
  return {
    schemaVersion: 1,
    drafts: Array.isArray(payload?.drafts) ? payload.drafts.map(normalizeDraft) : [],
  };
}

async function writeDraftStore(store, env = process.env) {
  await writeJson(draftsPath(env), {
    schemaVersion: 1,
    drafts: Array.isArray(store?.drafts) ? store.drafts.map(normalizeDraft) : [],
    updatedAt: nowIso(),
  });
}

function publicDraft(draft = {}) {
  return normalizeDraft(draft);
}

function ownerFor(principal, input = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) return normalizeUserId(principal?.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

async function assertDraftThread(input = {}, principal, env = process.env) {
  const threadId = clean(input.threadId || input.targetThreadId);
  if (!threadId) return null;
  return getThreadForPrincipal(threadId, principal, env);
}

export async function listOrkestrMailDraftsForPrincipal(principal, input = {}, env = process.env) {
  const threadId = clean(input.threadId || input.targetThreadId);
  const store = await readDraftStore(env);
  const drafts = store.drafts.filter((draft) => (
    (!threadId || draft.threadId === threadId)
    && (isAdminPrincipal(principal) || canAccessOwner(principal, draft.ownerUserId, env))
  ));
  return { drafts: drafts.map(publicDraft) };
}

export async function createOrkestrMailDraftForPrincipal(input = {}, principal, env = process.env) {
  const thread = await assertDraftThread(input, principal, env);
  const ownerUserId = ownerFor(principal, input, env);
  if (thread && thread.ownerUserId !== ownerUserId) throw draftError("mail_draft_thread_owner_mismatch", 403);
  const to = normalizeAddressList(input.to);
  if (!to.length) throw draftError("mail_draft_recipient_required");
  const draft = normalizeDraft({
    id: randomUUID(),
    ownerUserId,
    threadId: thread?.id || "",
    to,
    subject: input.subject,
    body: input.body,
    status: "draft",
  });
  const store = await readDraftStore(env);
  store.drafts.push(draft);
  await writeDraftStore(store, env);
  await appendEvent({ type: "orkestr_mail_draft_created", draftId: draft.id, ownerUserId, threadId: draft.threadId || null }, env).catch(() => {});
  return { draft: publicDraft(draft) };
}

export async function updateOrkestrMailDraftForPrincipal(draftId, input = {}, principal, env = process.env) {
  const store = await readDraftStore(env);
  const draft = store.drafts.find((entry) => entry.id === clean(draftId));
  if (!draft) throw draftError("mail_draft_not_found", 404);
  assertOwnerAccess(principal, draft.ownerUserId, "mail_draft_update", env);
  if (draft.status === "sent") throw draftError("mail_draft_already_sent", 409);
  if (input.to !== undefined) draft.to = normalizeAddressList(input.to);
  if (!draft.to.length) throw draftError("mail_draft_recipient_required");
  if (input.subject !== undefined) draft.subject = clean(input.subject).replace(/[\r\n]+/g, " ").slice(0, 500);
  if (input.body !== undefined) draft.body = String(input.body || "").replace(/\u0000/g, "").slice(0, 50_000);
  draft.status = "draft";
  draft.lastError = "";
  draft.updatedAt = nowIso();
  await writeDraftStore(store, env);
  await appendEvent({ type: "orkestr_mail_draft_updated", draftId: draft.id, ownerUserId: draft.ownerUserId }, env).catch(() => {});
  return { draft: publicDraft(draft) };
}

export async function sendOrkestrMailDraftForPrincipal(draftId, principal, env = process.env, options = {}) {
  const store = await readDraftStore(env);
  const draft = store.drafts.find((entry) => entry.id === clean(draftId));
  if (!draft) throw draftError("mail_draft_not_found", 404);
  assertOwnerAccess(principal, draft.ownerUserId, "mail_draft_send", env);
  if (draft.status === "sent") throw draftError("mail_draft_already_sent", 409);
  const send = options.sendImpl || sendEmail;
  let result;
  try {
    result = await send({ to: draft.to, subject: draft.subject, text: draft.body }, env);
  } catch (error) {
    result = { ok: false, configured: true, skippedReason: clean(error?.message || error) || "mail_send_failed" };
  }
  if (result?.ok) {
    draft.status = "sent";
    draft.provider = clean(result.provider);
    draft.sentAt = nowIso();
    draft.lastError = "";
  } else {
    draft.status = "send_failed";
    draft.lastError = clean(result?.skippedReason || result?.error || "mail_send_failed").slice(0, 500);
  }
  draft.updatedAt = nowIso();
  await writeDraftStore(store, env);
  await appendEvent({
    type: result?.ok ? "orkestr_mail_draft_sent" : "orkestr_mail_draft_send_failed",
    draftId: draft.id,
    ownerUserId: draft.ownerUserId,
    provider: draft.provider || null,
    error: draft.lastError || null,
  }, env).catch(() => {});
  return { ok: Boolean(result?.ok), draft: publicDraft(draft), delivery: result };
}
