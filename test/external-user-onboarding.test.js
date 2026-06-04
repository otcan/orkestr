import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";
import { listThreadMessages, listThreads, updateThread } from "../packages/core/src/threads.js";
import {
  linkUserPrivateIdentity,
  readUserPrivateIdentities,
  upsertUser,
  getUser,
} from "../packages/core/src/users.js";
import {
  buildExternalUserInviteTemplate,
  buildProvisioningChecklist,
  offboardUser,
  readUserOnboardingState,
  recordUserSupportRequest,
  setUserOnboardingState,
} from "../packages/core/src/user-onboarding.js";
import {
  approveWaitlistEntry,
  listWaitlistEntries,
  submitWaitlistEntry,
  updateWaitlistEntry,
} from "../packages/core/src/user-waitlist.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

test("external user invite template and checklist describe the full beta flow", () => {
  const env = {
    ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example",
    ORKESTR_PUBLIC_APP_URL: "https://app.orkestr.example",
  };
  const invite = buildExternalUserInviteTemplate({ name: "Can", inviter: "Oguz" }, env);
  const checklist = buildProvisioningChecklist({
    userId: "can",
    connectionName: "can-test",
    phoneNumber: "+10000000000",
    consented: true,
  }, env);

  assert.equal(invite.channel, "whatsapp");
  assert.match(invite.message, /Hi Can, Oguz invited you to try Orkestr/);
  assert.match(invite.message, /https:\/\/orkestr\.example\/terms/);
  assert.match(invite.message, /I agree to use Orkestr beta with my own accounts/);
  assert.equal(checklist.connectionName, "can-test");
  assert.ok(checklist.steps.find((step) => step.id === "wa-group" && step.label.includes("can-test")));
  assert.ok(checklist.steps.find((step) => step.id === "smoke"));
});

test("waitlist submissions are normalized, idempotent, and admin-reviewable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-waitlist-core-"));
  const env = { ORKESTR_HOME: home };
  const first = await submitWaitlistEntry({
    displayName: "Can",
    phoneNumber: "+49 176 000000",
    email: "CAN@EXAMPLE.TEST",
    intendedUse: "Job applications",
    acceptedTerms: true,
    consentToContact: true,
    sourceIp: "198.51.100.10",
    userAgent: "test-agent",
  }, env);
  const duplicate = await submitWaitlistEntry({
    displayName: "Can Updated",
    phoneNumber: "+49176000000",
    email: "can@example.test",
    intendedUse: "Leads and job applications",
    acceptedTerms: true,
    consentToContact: true,
  }, env);
  const listed = await listWaitlistEntries({}, env);
  const reviewed = await updateWaitlistEntry(first.waitlist.id, {
    status: "contacted",
    adminNote: "Sent WA intro",
    reviewedBy: "admin",
  }, env);
  const createdGroups = [];
  const deliveries = [];
  const approved = await approveWaitlistEntry(first.waitlist.id, {
    connectionName: "Can-Orkestr",
    actorUserId: "admin",
    whatsappAccountId: "wa-router",
  }, env, {
    async createWhatsAppThreadGroup(thread, options, groupEnv) {
      createdGroups.push(options);
      const binding = {
        ...(thread.binding || {}),
        connector: "whatsapp",
        chatId: "wa-group-three@g.us",
        displayName: options.name,
        mirrorToWhatsApp: true,
        responderAccountId: options.responderAccountId,
        outboundAccountId: options.outboundAccountId,
        senderContactId: options.participantIds[0],
      };
      const updated = await updateThread(thread.id, { binding, bindingName: binding.displayName }, groupEnv);
      return { ok: true, created: true, reused: false, thread: updated, binding, chat: { id: binding.chatId, name: binding.displayName } };
    },
    async deliverWhatsAppReplies() {
      deliveries.push(true);
      return { delivered: [{ messageId: "first-prompt" }], skipped: [], failed: [] };
    },
  });
  const user = await getUser(approved.user.id, env);
  const identities = await readUserPrivateIdentities(approved.user.id, env);
  const threads = await listThreads(env);
  const messages = await listThreadMessages(approved.thread.id, env);
  const failedSubmit = await submitWaitlistEntry({
    displayName: "Bridge Later",
    phoneNumber: "+49176000002",
    acceptedTerms: true,
    consentToContact: true,
  }, env);
  const failedApproval = await approveWaitlistEntry(failedSubmit.waitlist.id, {
    connectionName: "Bridge-Later",
    actorUserId: "admin",
  }, env, {
    async createWhatsAppThreadGroup() {
      throw new Error("whatsapp_responder_account_not_ready");
    },
  });

  assert.equal(first.submitted, true);
  assert.equal(duplicate.waitlist.id, first.waitlist.id);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].displayName, "Can Updated");
  assert.equal(listed.entries[0].phoneNumber, "+49176000000");
  assert.equal(listed.entries[0].email, "can@example.test");
  assert.equal(reviewed.entry.status, "contacted");
  assert.equal(reviewed.entry.adminNote, "Sent WA intro");
  assert.equal(approved.entry.status, "approved");
  assert.equal(approved.user.limits.maxThreads, 1);
  assert.equal(user.phoneNumber, "+49176000000");
  assert.equal(approved.thread.ownerUserId, approved.user.id);
  assert.equal(approved.thread.runtimeKind, "api-agent");
  assert.equal(approved.whatsapp.pendingChatCreation, false);
  assert.equal(approved.whatsapp.groupCreated, true);
  assert.equal(approved.whatsapp.chatId, "wa-group-three@g.us");
  assert.equal(approved.whatsapp.firstPromptDelivery.delivered.length, 1);
  assert.deepEqual(createdGroups.map((group) => group.participantIds), [["+49176000000"]]);
  assert.deepEqual(deliveries, [true]);
  assert.ok(messages.some((message) =>
    message.role === "assistant" &&
    message.source === "orkestr_onboarding" &&
    message.connector === "whatsapp" &&
    message.chatId === "wa-group-three@g.us" &&
    message.text.includes("private Orkestr onboarding chat")
  ));
  assert.equal(failedApproval.whatsapp.pendingChatCreation, true);
  assert.match(failedApproval.whatsapp.groupError, /whatsapp_responder_account_not_ready/);
  assert.match(approved.firstPrompt, /private Orkestr onboarding chat/);
  assert.ok(identities.some((identity) => identity.provider === "whatsapp" && identity.externalId === "+49176000000"));
  assert.ok(threads.some((thread) => thread.id === approved.thread.id && thread.ownerUserId === approved.user.id));
});

test("waitlist submissions notify admins without blocking public submissions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-waitlist-notify-"));
  const env = { ORKESTR_HOME: home };
  const sent = [];
  const first = await submitWaitlistEntry({
    displayName: "Notify User",
    phoneNumber: "+49176001000",
    email: "notify@example.test",
    intendedUse: "Beta testing",
    acceptedTerms: true,
    consentToContact: true,
  }, env, {
    async sendWaitlistNotification(entry, notifyEnv) {
      sent.push({ entry, notifyEnv });
      return { ok: true, configured: true, recipients: ["admin@example.test"], messageId: "message-1" };
    },
  });
  const duplicate = await submitWaitlistEntry({
    displayName: "Notify User Updated",
    phoneNumber: "+49 176 001000",
    email: "notify@example.test",
    intendedUse: "Updated use case",
    acceptedTerms: true,
    consentToContact: true,
  }, env, {
    async sendWaitlistNotification() {
      throw new Error("duplicate_should_not_notify");
    },
  });
  const failed = await submitWaitlistEntry({
    displayName: "Failed Notify",
    phoneNumber: "+49176001001",
    email: "failed@example.test",
    acceptedTerms: true,
    consentToContact: true,
  }, env, {
    async sendWaitlistNotification() {
      throw new Error("smtp_offline");
    },
  });
  const skipped = await submitWaitlistEntry({
    displayName: "Skipped Notify",
    phoneNumber: "+49176001002",
    email: "skipped@example.test",
    acceptedTerms: true,
    consentToContact: true,
  }, env);
  const listed = await listWaitlistEntries({}, env);
  const firstEntry = listed.entries.find((entry) => entry.id === first.waitlist.id);
  const failedEntry = listed.entries.find((entry) => entry.id === failed.waitlist.id);
  const skippedEntry = listed.entries.find((entry) => entry.id === skipped.waitlist.id);

  assert.equal(first.submitted, true);
  assert.equal(duplicate.waitlist.id, first.waitlist.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].entry.phoneNumber, "+49176001000");
  assert.equal(sent[0].notifyEnv.ORKESTR_HOME, home);
  assert.equal(firstEntry.notification.state, "sent");
  assert.equal(firstEntry.notification.recipients[0], "admin@example.test");
  assert.equal(failedEntry.notification.state, "failed");
  assert.match(failedEntry.notification.error, /smtp_offline/);
  assert.equal(skippedEntry.notification.state, "skipped");
  assert.equal(skippedEntry.notification.skippedReason, "waitlist_email_not_configured");
});

test("support requests and offboarding are user scoped and conservative", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-external-onboarding-"));
  const env = { ORKESTR_HOME: home };
  await upsertUser({ id: "can", role: "user", displayName: "Can", phoneNumber: "+10000000000" }, env);
  await linkUserPrivateIdentity("can", {
    provider: "whatsapp",
    accountId: "wa-1",
    externalId: "+10000000000",
    chatId: "chat-can",
  }, { env, actorUserId: "admin" });
  await linkUserPrivateIdentity("can", {
    provider: "gmail",
    accountId: "can@example.test",
    externalId: "can@example.test",
  }, { env, actorUserId: "admin" });
  await createTimer({
    id: "can-daily",
    label: "Can daily",
    target: "thread-can",
    prompt: "Check in",
    ownerUserId: "can",
  }, env);
  const paths = userDataPaths("can", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({ access_token: "secret" }), "utf8");

  const support = await recordUserSupportRequest("can", { type: "pause", message: "Pause me" }, env);
  const onboarding = await setUserOnboardingState("can", { state: "active", invite: { consentedAt: "now" } }, env);
  const offboarded = await offboardUser("can", { action: "pause", revokeConnectors: true, stopTimers: true }, env);
  const afterUser = await getUser("can", env);
  const afterState = await readUserOnboardingState("can", env);
  const identities = await readUserPrivateIdentities("can", env);
  const timers = await listTimers(env);

  assert.equal(support.request.type, "pause");
  assert.match(support.reply, /pause request/);
  assert.equal(onboarding.onboarding.state, "active");
  assert.equal(offboarded.action, "pause");
  assert.equal(afterUser.status, "disabled");
  assert.equal(afterState.state, "paused");
  assert.equal(identities.length, 0);
  assert.deepEqual(timers.map((timer) => timer.id), []);
  await assert.rejects(() => fs.access(path.join(paths.secrets, "gmail-token.json")));
});

test("waitlist API accepts public submissions and keeps review admin-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-waitlist-api-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_CODEX_BIN",
    "WHATSAPP_BRIDGE_MODE",
    "ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED",
    "ORKESTR_PUBLIC_URL",
  ]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  delete process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.WHATSAPP_BRIDGE_MODE = "external";
  process.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED = "1";
  process.env.ORKESTR_PUBLIC_URL = "https://app.orkestr.example.test";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const submit = await json(await fetch(`${baseUrl}/api/public/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Can",
        phoneNumber: "+49176000000",
        email: "can@example.test",
        intendedUse: "I want Orkestr for job applications.",
        acceptedTerms: true,
        consentToContact: true,
      }),
    }));
    const blockedList = await fetch(`${baseUrl}/api/users/onboarding/waitlist`);
    const blockedThreads = await fetch(`${baseUrl}/api/threads`);
    const listed = await listWaitlistEntries({}, process.env);

    assert.equal(submit.ok, true);
    assert.equal(submit.submitted, true);
    assert.match(submit.message, /waitlist/);
    assert.equal(blockedList.status, 401);
    assert.equal(blockedThreads.status, 401);
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].phoneNumber, "+49176000000");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("admin onboarding endpoints expose invite, checklist, and offboarding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-external-onboarding-api-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_CODEX_BIN",
    "WHATSAPP_BRIDGE_MODE",
    "ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED",
    "ORKESTR_PUBLIC_SITE_URL",
    "ORKESTR_PUBLIC_APP_URL",
  ]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.WHATSAPP_BRIDGE_MODE = "external";
  process.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED = "1";
  process.env.ORKESTR_PUBLIC_SITE_URL = "https://orkestr.example";
  process.env.ORKESTR_PUBLIC_APP_URL = "https://app.orkestr.example";
  await upsertUser({ id: "can", role: "user", displayName: "Can", phoneNumber: "+10000000000" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const invite = await json(await fetch(`${baseUrl}/api/users/onboarding/invite-template?name=Can`));
    const checklist = await json(await fetch(`${baseUrl}/api/users/onboarding/provisioning-checklist?userId=can&connectionName=can-test`));
    const waitlist = await submitWaitlistEntry({
      displayName: "Beta User",
      phoneNumber: "+49176000001",
      email: "beta@example.test",
      intendedUse: "Inbox help",
      acceptedTerms: true,
      consentToContact: true,
    }, process.env);
    const approved = await json(await fetch(`${baseUrl}/api/users/onboarding/waitlist/${waitlist.waitlist.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionName: "Beta-Orkestr",
        whatsappAccountId: "wa-router",
        chatId: "wa-group-ninety-nine@g.us",
        createWhatsAppGroup: false,
        sendFirstPrompt: false,
      }),
    }));
    const paused = await json(await fetch(`${baseUrl}/api/users/can/offboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", revokeConnectors: false, stopTimers: false }),
    }));

    assert.match(invite.message, /Hi Can/);
    assert.equal(checklist.connectionName, "can-test");
    assert.equal(approved.user.phoneNumber, "+49176000001");
    assert.equal(approved.thread.bindingName, "Beta-Orkestr");
    assert.equal(approved.whatsapp.chatId, "wa-group-ninety-nine@g.us");
    assert.equal(approved.whatsapp.groupCreated, false);
    assert.equal(approved.whatsapp.firstPromptMessageId, "");
    assert.match(approved.firstPrompt, /connect Gmail, Outlook, Jira, Shopify/);
    assert.equal(paused.user.status, "disabled");
    assert.equal(paused.onboarding.state, "paused");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
