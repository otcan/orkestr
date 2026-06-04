import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { appendThreadMessage, createThread } from "./threads.js";
import { API_AGENT_RUNTIME_KIND } from "./tenant-api-agent.js";
import { normalizeTimezone, setUserOnboardingState } from "./user-onboarding.js";
import { linkUserPrivateIdentity, normalizeUserId, publicUser, upsertUser } from "./users.js";
import { notifyWaitlistEntrySubmitted, setWaitlistNotification, waitlistNotificationRecord } from "./waitlist-notifications.js";

const waitlistStatuses = new Set(["pending", "contacted", "approved", "rejected", "paused"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function waitlistError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeEmailInput(value = "") {
  return clean(value).toLowerCase();
}

function normalizePhoneInput(value = "") {
  const text = clean(value);
  const hasPlus = text.startsWith("+");
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `${hasPlus ? "+" : ""}${digits}`;
}

function normalizeWaitlistStatus(value = "pending") {
  const status = clean(value).toLowerCase();
  return waitlistStatuses.has(status) ? status : "pending";
}

function validateEmail(value = "") {
  const email = normalizeEmailInput(value);
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeWaitlistTimezone(value = "") {
  const timezone = clean(value);
  if (!timezone) return "";
  try {
    return normalizeTimezone(timezone);
  } catch {
    throw waitlistError("waitlist_timezone_invalid", 400);
  }
}

function waitlistDefaults() {
  return {
    schemaVersion: 1,
    entries: [],
    updatedAt: nowIso(),
  };
}

function publicWaitlistEntry(entry = {}) {
  return {
    id: String(entry.id || ""),
    status: normalizeWaitlistStatus(entry.status || "pending"),
    createdAt: String(entry.createdAt || ""),
    updatedAt: String(entry.updatedAt || ""),
  };
}

function adminWaitlistEntry(entry = {}) {
  return {
    id: String(entry.id || ""),
    displayName: clean(entry.displayName),
    phoneNumber: normalizePhoneInput(entry.phoneNumber),
    email: normalizeEmailInput(entry.email),
    timezone: normalizeWaitlistTimezone(entry.timezone),
    intendedUse: clean(entry.intendedUse).slice(0, 1000),
    status: normalizeWaitlistStatus(entry.status || "pending"),
    acceptedTerms: Boolean(entry.acceptedTerms),
    consentToContact: Boolean(entry.consentToContact),
    source: {
      ip: clean(entry.source?.ip).slice(0, 80),
      userAgent: clean(entry.source?.userAgent).slice(0, 240),
    },
    adminNote: clean(entry.adminNote).slice(0, 1000),
    reviewedBy: clean(entry.reviewedBy).slice(0, 96),
    reviewedAt: clean(entry.reviewedAt),
    notification: waitlistNotificationRecord(entry.notification),
    createdAt: String(entry.createdAt || ""),
    updatedAt: String(entry.updatedAt || ""),
  };
}

export async function submitWaitlistEntry(input = {}, env = process.env, dependencies = {}) {
  const displayName = clean(input.displayName || input.name).slice(0, 120);
  const phoneNumber = normalizePhoneInput(input.phoneNumber || input.phone || input.whatsappNumber || input.whatsapp);
  const email = normalizeEmailInput(input.email);
  const timezone = normalizeWaitlistTimezone(input.timezone || input.timeZone);
  const intendedUse = clean(input.intendedUse || input.useCase || input.message).slice(0, 1000);
  const acceptedTerms = boolValue(input.acceptedTerms || input.termsAccepted || input.acceptTerms);
  const consentToContact = boolValue(input.consentToContact || input.contactConsent || input.allowContact);
  if (!displayName) throw waitlistError("waitlist_name_required", 400);
  if (!phoneNumber || phoneNumber.replace(/\D/g, "").length < 6) throw waitlistError("waitlist_whatsapp_number_required", 400);
  if (!validateEmail(email)) throw waitlistError("waitlist_email_invalid", 400);
  if (!acceptedTerms) throw waitlistError("waitlist_terms_required", 400);
  if (!consentToContact) throw waitlistError("waitlist_contact_consent_required", 400);

  const store = await readWaitlistStore(env);
  const now = nowIso();
  const existingIndex = store.entries.findIndex((entry) =>
    normalizePhoneInput(entry.phoneNumber) === phoneNumber ||
    (email && normalizeEmailInput(entry.email) === email)
  );
  const patch = {
    displayName,
    phoneNumber,
    email,
    ...(timezone ? { timezone } : {}),
    intendedUse,
    acceptedTerms,
    consentToContact,
    source: {
      ip: clean(input.sourceIp || input.ip).slice(0, 80),
      userAgent: clean(input.userAgent).slice(0, 240),
    },
    updatedAt: now,
  };
  let entry;
  let isNewEntry = false;
  let eventType = "waitlist_entry_submitted";
  if (existingIndex >= 0) {
    const existing = store.entries[existingIndex];
    entry = adminWaitlistEntry({
      ...existing,
      ...patch,
      status: normalizeWaitlistStatus(existing.status || "pending"),
      createdAt: existing.createdAt || now,
    });
    store.entries[existingIndex] = entry;
    eventType = "waitlist_entry_updated";
  } else {
    isNewEntry = true;
    entry = adminWaitlistEntry({
      id: `waitlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...patch,
      status: "pending",
      createdAt: now,
    });
    store.entries.push(entry);
  }
  await writeWaitlistStore(store, env);
  await appendEvent({
    type: eventType,
    waitlistEntryId: entry.id,
    hasEmail: Boolean(entry.email),
    hasPhone: Boolean(entry.phoneNumber),
  }, env).catch(() => {});
  const notification = await notifyWaitlistEntrySubmitted(entry, { isNewEntry, env, dependencies });
  if (notification) {
    entry = adminWaitlistEntry(await setWaitlistNotification(entry.id, notification, env).catch(() => entry) || entry);
  }
  return {
    ok: true,
    submitted: true,
    message: "Thanks. You are on the Orkestr waitlist. If invited, you will receive a WhatsApp onboarding chat.",
    waitlist: publicWaitlistEntry(entry),
  };
}

export async function listWaitlistEntries({ status = "", limit = 100 } = {}, env = process.env) {
  const normalizedStatus = clean(status).toLowerCase();
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const store = await readWaitlistStore(env);
  const entries = store.entries
    .map(adminWaitlistEntry)
    .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
    .slice(0, max);
  return { ok: true, entries, total: entries.length };
}

export async function updateWaitlistEntry(entryId, patch = {}, env = process.env) {
  const id = clean(entryId);
  if (!id) throw waitlistError("waitlist_entry_id_required", 400);
  const store = await readWaitlistStore(env);
  const index = store.entries.findIndex((entry) => String(entry.id || "") === id);
  if (index < 0) throw waitlistError("waitlist_entry_not_found", 404);
  const existing = adminWaitlistEntry(store.entries[index]);
  const now = nowIso();
  const next = adminWaitlistEntry({
    ...existing,
    status: patch.status === undefined || patch.status === "" ? existing.status : normalizeWaitlistStatus(patch.status),
    adminNote: patch.adminNote === undefined ? existing.adminNote : clean(patch.adminNote).slice(0, 1000),
    reviewedBy: clean(patch.reviewedBy || existing.reviewedBy),
    reviewedAt: patch.status === undefined || patch.status === "" ? existing.reviewedAt : now,
    updatedAt: now,
  });
  store.entries[index] = next;
  await writeWaitlistStore(store, env);
  await appendEvent({
    type: "waitlist_entry_reviewed",
    waitlistEntryId: next.id,
    status: next.status,
    reviewedBy: next.reviewedBy || null,
  }, env).catch(() => {});
  return { ok: true, entry: next };
}

export async function approveWaitlistEntry(entryId, input = {}, env = process.env, dependencies = {}) {
  const id = clean(entryId);
  if (!id) throw waitlistError("waitlist_entry_id_required", 400);
  const store = await readWaitlistStore(env);
  const entry = store.entries.map(adminWaitlistEntry).find((item) => item.id === id);
  if (!entry) throw waitlistError("waitlist_entry_not_found", 404);
  const userId = normalizeUserId(input.userId || entry.email || entry.phoneNumber || entry.displayName);
  const connectionName = clean(input.connectionName || input.chatName || `${entry.displayName || userId}-orkestr`);
  const actorUserId = clean(input.actorUserId || input.reviewedBy || "admin") || "admin";
  const user = await upsertUser({
    id: userId,
    role: "user",
    displayName: entry.displayName || userId,
    email: entry.email,
    phoneNumber: entry.phoneNumber,
    limits: { maxThreads: 1 },
  }, env);
  await linkUserPrivateIdentity(user.id, {
    provider: "whatsapp",
    accountId: clean(input.whatsappAccountId || input.accountId),
    externalId: entry.phoneNumber,
    displayName: entry.displayName,
    source: "manual",
  }, { env, actorUserId, migrate: true });
  let thread = await createThread({
    id: clean(input.threadId) || `onboarding-${user.id}`,
    ownerUserId: user.id,
    name: connectionName,
    title: connectionName,
    state: "sleeping",
    wakePolicy: "wake-on-message",
    runtimeKind: API_AGENT_RUNTIME_KIND,
    executorId: API_AGENT_RUNTIME_KIND,
    executor: {
      id: API_AGENT_RUNTIME_KIND,
      type: API_AGENT_RUNTIME_KIND,
      transport: API_AGENT_RUNTIME_KIND,
      metadata: { runtimeKind: API_AGENT_RUNTIME_KIND, transport: API_AGENT_RUNTIME_KIND },
    },
    bindingName: connectionName,
    binding: {
      connector: "whatsapp",
      chatId: clean(input.chatId || input.whatsappChatId),
      displayName: connectionName,
      enabled: Boolean(input.chatId || input.whatsappChatId),
      generated: false,
      mirrorToWhatsApp: true,
      senderAccountId: clean(input.whatsappAccountId || input.senderAccountId),
      responderAccountId: clean(input.responderAccountId || input.whatsappAccountId || input.senderAccountId),
      outboundAccountId: clean(input.outboundAccountId || input.responderAccountId || input.whatsappAccountId || input.senderAccountId),
      senderContactId: entry.phoneNumber,
      updatedAt: nowIso(),
    },
  }, env);
  const onboarding = await setUserOnboardingState(user.id, {
    state: "provisioned",
    invite: {
      source: "waitlist",
      waitlistEntryId: entry.id,
      connectionName,
      threadId: thread.id,
      phoneNumber: entry.phoneNumber,
      approvedAt: nowIso(),
      approvedBy: actorUserId,
    },
    profile: {
      displayName: entry.displayName,
      timezone: entry.timezone,
    },
  }, env);
  const reviewed = await updateWaitlistEntry(entry.id, {
    status: "approved",
    adminNote: clean(input.adminNote || entry.adminNote),
    reviewedBy: actorUserId,
  }, env);
  const firstPrompt = buildWaitlistOnboardingPrompt({ user, entry, connectionName });
  const provisioned = await provisionWaitlistWhatsAppOnboarding({
    thread,
    entry,
    firstPrompt,
    input,
    connectionName,
    env,
    dependencies,
  });
  thread = provisioned.thread || thread;
  const { thread: _thread, ...whatsapp } = provisioned;
  await appendEvent({
    type: "waitlist_entry_approved",
    waitlistEntryId: entry.id,
    userId: user.id,
    threadId: thread.id,
    reviewedBy: actorUserId,
  }, env).catch(() => {});
  return {
    ok: true,
    entry: reviewed.entry,
    user: publicUser(user, env),
    thread,
    onboarding: onboarding.onboarding,
    firstPrompt,
    whatsapp,
  };
}

async function provisionWaitlistWhatsAppOnboarding({
  thread = {},
  entry = {},
  firstPrompt = "",
  input = {},
  connectionName = "",
  env = process.env,
  dependencies = {},
} = {}) {
  let currentThread = thread;
  let group = null;
  let groupError = "";
  let promptMessage = null;
  let delivery = null;
  if (!clean(currentThread.binding?.chatId) && input.createWhatsAppGroup !== false && typeof dependencies.createWhatsAppThreadGroup === "function") {
    try {
      group = await dependencies.createWhatsAppThreadGroup(currentThread, {
        name: connectionName,
        senderAccountId: clean(input.senderAccountId || input.whatsappAccountId || input.accountId),
        responderAccountId: clean(input.responderAccountId || input.outboundAccountId || input.whatsappAccountId || input.accountId),
        outboundAccountId: clean(input.outboundAccountId || input.responderAccountId || input.whatsappAccountId || input.accountId),
        participantIds: Array.isArray(input.participantIds) && input.participantIds.length ? input.participantIds : [entry.phoneNumber],
        adminParticipantIds: Array.isArray(input.adminParticipantIds) ? input.adminParticipantIds : [],
        promoteParticipantsAsAdmins: input.promoteParticipantsAsAdmins !== false,
        generatePicture: input.generatePicture !== false,
        mirrorToWhatsApp: true,
      }, env);
      currentThread = group.thread || currentThread;
    } catch (error) {
      groupError = error?.message || String(error);
      await appendEvent({
        type: "waitlist_whatsapp_group_create_failed",
        waitlistEntryId: entry.id,
        threadId: currentThread.id,
        error: groupError,
      }, env).catch(() => {});
      if (input.requireWhatsAppGroup === true) throw error;
    }
  }
  const chatId = clean(currentThread.binding?.chatId);
  if (chatId && firstPrompt && input.sendFirstPrompt !== false) {
    try {
      promptMessage = await appendThreadMessage(currentThread.id, {
        role: "assistant",
        source: "orkestr_onboarding",
        connector: "whatsapp",
        chatId,
        accountId: clean(currentThread.binding?.responderAccountId || currentThread.binding?.outboundAccountId || currentThread.binding?.senderAccountId),
        text: firstPrompt,
        state: "completed",
      }, env);
      if (typeof dependencies.deliverWhatsAppReplies === "function") {
        delivery = await dependencies.deliverWhatsAppReplies(env);
      }
      await appendEvent({
        type: "waitlist_first_prompt_queued",
        waitlistEntryId: entry.id,
        threadId: currentThread.id,
        messageId: promptMessage.id,
        chatId,
      }, env).catch(() => {});
    } catch (error) {
      const promptError = error?.message || String(error);
      await appendEvent({
        type: "waitlist_first_prompt_failed",
        waitlistEntryId: entry.id,
        threadId: currentThread.id,
        chatId,
        error: promptError,
      }, env).catch(() => {});
      if (input.requireFirstPrompt === true) throw error;
      return waitlistWhatsAppResult({ thread: currentThread, entry, connectionName, group, groupError, promptError });
    }
  }
  return waitlistWhatsAppResult({ thread: currentThread, entry, connectionName, group, groupError, promptMessage, delivery });
}

function waitlistWhatsAppResult({
  thread = {},
  entry = {},
  connectionName = "",
  group = null,
  groupError = "",
  promptMessage = null,
  promptError = "",
  delivery = null,
} = {}) {
  const chatId = clean(thread.binding?.chatId);
  return {
    phoneNumber: entry.phoneNumber,
    connectionName,
    chatId,
    pendingChatCreation: !chatId,
    groupCreated: group?.created === true,
    groupReused: group?.reused === true,
    groupError,
    firstPromptMessageId: promptMessage?.id || "",
    firstPromptDelivery: delivery || null,
    promptError,
    thread,
  };
}

async function readWaitlistStore(env = process.env) {
  const fallback = waitlistDefaults();
  const payload = await readJson(dataPaths(env).waitlist, fallback);
  const entries = Array.isArray(payload.entries) ? payload.entries.map(adminWaitlistEntry).filter((entry) => entry.id) : [];
  return {
    ...fallback,
    ...payload,
    entries,
    updatedAt: clean(payload.updatedAt) || fallback.updatedAt,
  };
}

async function writeWaitlistStore(store = {}, env = process.env) {
  const next = {
    schemaVersion: 1,
    entries: Array.isArray(store.entries) ? store.entries.map(adminWaitlistEntry).filter((entry) => entry.id) : [],
    updatedAt: nowIso(),
  };
  await writeJson(dataPaths(env).waitlist, next);
  return next;
}

function buildWaitlistOnboardingPrompt({ user = {}, entry = {}, connectionName = "" } = {}) {
  const name = clean(entry.displayName || user.displayName || "there");
  const use = clean(entry.intendedUse);
  return [
    `Hi ${name}. This is your private Orkestr onboarding chat.`,
    "Tell me what you want help with, and I will help set up only the tools you choose.",
    "You can ask to connect Gmail, Outlook, Jira, Shopify, open a managed desktop, or create timers from this chat.",
    "Do not send passwords here. If a login is needed, I will send a safe link or open your managed desktop.",
    use ? `Your waitlist note was: ${use}` : "",
    connectionName ? `Chat name: ${connectionName}` : "",
  ].filter(Boolean).join("\n\n");
}
