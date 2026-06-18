import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWhatsAppBridgeBindingAcl,
  listWhatsAppBindingStatuses,
  listWhatsAppConnectorAccounts,
  listPersistentWhatsAppConnectorAccounts,
  retireWhatsAppThreadBinding,
  resolveWhatsAppBinding,
  updateWhatsAppThreadBinding,
  upsertWhatsAppBinding,
  upsertWhatsAppThreadBinding,
} from "../packages/connectors/src/whatsapp-account-bindings.js";
import { migrateWhatsAppBrokerConfig } from "../packages/connectors/src/whatsapp-broker-migration.js";
import {
  deleteWhatsAppConnectorAccountForPrincipal,
  listWhatsAppConnectorAccountsForPrincipal,
  deleteWhatsAppConnectorAccount,
  readWhatsAppConnectorAccounts,
  updateWhatsAppConnectorAccount,
  updateWhatsAppConnectorAccountForPrincipal,
  upsertWhatsAppConnectorAccount,
  upsertWhatsAppConnectorAccountForPrincipal,
} from "../packages/connectors/src/whatsapp-account-registry.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { readWhatsAppScopedTokenRecords } from "../packages/core/src/whatsapp-scoped-tokens.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { createThread, getThread, listThreadMessages, listThreads } from "../packages/core/src/threads.js";

test("WhatsApp connector accounts use phone identities while preserving legacy runtime aliases", () => {
  const accounts = listWhatsAppConnectorAccounts({
    env: {
      ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
      ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "responder",
      ORKESTR_ADMIN_USER_ID: "admin",
    },
    status: {
      mode: "local",
      state: "paired",
      accounts: [
        { accountId: "sender", label: "Old Sender", state: "pairing_code", ready: false, pairingCode: "123-45678", pairingCodeUpdatedAt: "2026-06-07T12:00:00.000Z", pairingPhoneNumber: "***0662", sessionRoot: "/private/session" },
        { accountId: "responder", label: "Old Responder", state: "ready", ready: true, authenticated: true, phoneNumber: "+155512345", contactId: "155512345@c.us", pushName: "Responder Phone" },
      ],
    },
  });

  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.kind), ["connector_account", "connector_account"]);
  assert.deepEqual(accounts.find((account) => account.accountId === "sender").legacyRoleAliases, ["sender"]);
  assert.equal(accounts.find((account) => account.accountId === "sender").autostart, false);
  assert.equal(accounts.find((account) => account.accountId === "sender").pairingCode, "123-45678");
  assert.equal(accounts.find((account) => account.accountId === "sender").pairingPhoneNumber, "***0662");
  assert.equal(accounts.find((account) => account.accountId === "sender").nextAction, "enter_pairing_code");
  const responder = accounts.find((account) => account.accountId === "155512345");
  assert.ok(responder);
  assert.equal(responder.runtimeAccountId, "responder");
  assert.deepEqual(responder.legacyRoleAliases, ["responder"]);
  assert.equal(responder.autostart, true);
  assert.equal(responder.sendReady, true);
  assert.equal(responder.phoneIdentity, "155512345");
  assert.equal(responder.phoneNumber, "+155512345");
  assert.equal(responder.contactId, "155512345@c.us");
  assert.equal(responder.pushName, "Responder Phone");
  assert.equal(Object.hasOwn(accounts[0], "sessionRoot"), false);
});

test("WhatsApp bindings resolve numeric identities and legacy runtime aliases", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-account-identity-binding-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
  };
  const status = {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "responder", state: "ready", ready: true, authenticated: true, phoneNumber: "+155512345", contactId: "155512345@c.us" },
    ],
  };
  await createThread({
    id: "thread-numbered-wa",
    name: "Numbered WA",
    binding: {
      connector: "whatsapp",
      chatId: "numbered@g.us",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "155512345@c.us",
    },
  }, env);

  const payload = await listWhatsAppBindingStatuses({ env, status });
  const binding = payload.bindings.find((item) => item.threadId === "thread-numbered-wa");
  assert.equal(binding.responderAccountId, "155512345");
  assert.equal(binding.replyAccountId, "155512345");
  assert.equal(binding.runtimeAccountId, "responder");
  assert.deepEqual(binding.authorizedContactIds, ["155512345@c.us"]);
  assert.ok(binding.accountIds.includes("155512345"));
  assert.ok(binding.accountIds.includes("responder"));

  const byRuntimeAlias = await resolveWhatsAppBinding({ chatId: "numbered@g.us", accountId: "responder" }, { env, status });
  assert.equal(byRuntimeAlias.ok, true);
  assert.equal(byRuntimeAlias.selected.responderAccountId, "155512345");

  const byNumber = await resolveWhatsAppBinding({ chatId: "numbered@g.us", accountId: "155512345" }, { env, status });
  assert.equal(byNumber.ok, true);
  assert.equal(byNumber.selected.runtimeAccountId, "responder");
});

test("WhatsApp account list deduplicates runtime aliases and numeric registry identities", () => {
  const accounts = listWhatsAppConnectorAccounts({
    env: {
      ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
      ORKESTR_ADMIN_USER_ID: "admin",
    },
    registryAccounts: [
      { accountId: "155512345", ownerUserId: "user-1", label: "Saved Number", runtimeAccountId: "responder" },
    ],
    status: {
      mode: "local",
      state: "paired",
      accounts: [
        { accountId: "responder", state: "ready", ready: true, authenticated: true, phoneNumber: "+155512345", contactId: "155512345@c.us" },
      ],
    },
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, "155512345");
  assert.equal(accounts[0].runtimeAccountId, "responder");
  assert.equal(accounts[0].ownerUserId, "user-1");
  assert.equal(accounts[0].ready, true);
  assert.equal(accounts[0].state, "ready");
});

test("WhatsApp connector accounts persist in the neutral account registry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-account-registry-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_WHATSAPP_ACCOUNT_IDS: "runtime-1" };

  const created = await upsertWhatsAppConnectorAccount({
    accountId: "user-wa",
    displayName: "User WA",
    ownerUserId: "alice",
  }, env);
  assert.equal(created.accountId, "user-wa");
  assert.equal(created.ownerUserId, "alice");

  const listed = await readWhatsAppConnectorAccounts(env);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].displayName, "User WA");

  const projected = await listPersistentWhatsAppConnectorAccounts({
    env,
    status: { mode: "local", accounts: [{ accountId: "runtime-1", ready: true, authenticated: true }] },
  });
  const userAccount = projected.find((account) => account.accountId === "user-wa");
  assert.equal(userAccount.ownerUserId, "alice");
  assert.equal(userAccount.runtimeConfigured, false);
  assert.equal(userAccount.nextAction, "configure_runtime_account");

  const updated = await updateWhatsAppConnectorAccount("user-wa", { displayName: "Renamed WA" }, env);
  assert.equal(updated.displayName, "Renamed WA");

  await assert.rejects(
    () => upsertWhatsAppConnectorAccount({ accountId: "../bad", ownerUserId: "alice" }, env),
    /wa_account_id_invalid/,
  );

  await deleteWhatsAppConnectorAccount("user-wa", env);
  assert.deepEqual(await readWhatsAppConnectorAccounts(env), []);
});

test("WhatsApp connector accounts enforce owner isolation for user onboarding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-account-owner-policy-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const admin = adminPrincipal("admin");
  const alice = userPrincipal({ id: "alice", role: "user" });
  const bob = userPrincipal({ id: "bob", role: "user" });

  await upsertWhatsAppConnectorAccount({ accountId: "alice-wa", ownerUserId: "alice", displayName: "Alice WA" }, env);
  await upsertWhatsAppConnectorAccount({ accountId: "bob-wa", ownerUserId: "bob", displayName: "Bob WA" }, env);

  const allAccounts = await readWhatsAppConnectorAccounts(env);
  assert.deepEqual(listWhatsAppConnectorAccountsForPrincipal(allAccounts, alice, env).map((account) => account.accountId), ["alice-wa"]);
  assert.deepEqual(listWhatsAppConnectorAccountsForPrincipal(allAccounts, bob, env).map((account) => account.accountId), ["bob-wa"]);
  assert.deepEqual(listWhatsAppConnectorAccountsForPrincipal(allAccounts, admin, env).map((account) => account.accountId).sort(), ["alice-wa", "bob-wa"]);

  await assert.rejects(
    () => upsertWhatsAppConnectorAccountForPrincipal({ accountId: "alice-wa", displayName: "Hijack" }, bob, env),
    /wa_account_update_forbidden/,
  );
  await assert.rejects(
    () => updateWhatsAppConnectorAccountForPrincipal("alice-wa", { displayName: "Bob Edit" }, bob, env),
    /wa_account_update_forbidden/,
  );
  await assert.rejects(
    () => deleteWhatsAppConnectorAccountForPrincipal("alice-wa", bob, env),
    /wa_account_delete_forbidden/,
  );
  await assert.rejects(
    () => upsertWhatsAppConnectorAccountForPrincipal({ accountId: "sender", displayName: "Legacy Sender" }, bob, env),
    /wa_account_legacy_role_id_reserved/,
  );

  const bobCreated = await upsertWhatsAppConnectorAccountForPrincipal({
    accountId: "bob-new",
    ownerUserId: "alice",
    displayName: "Bob New",
  }, bob, env);
  assert.equal(bobCreated.ownerUserId, "bob");

  const aliceUpdated = await updateWhatsAppConnectorAccountForPrincipal("alice-wa", {
    displayName: "Alice Renamed",
    ownerUserId: "bob",
  }, alice, env);
  assert.equal(aliceUpdated.displayName, "Alice Renamed");
  assert.equal(aliceUpdated.ownerUserId, "alice");

  const deleted = await deleteWhatsAppConnectorAccountForPrincipal("bob-wa", admin, env);
  assert.equal(deleted.deletedAt.length > 0, true);
});

test("WhatsApp legacy role account ids are migration-only compatibility aliases", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-account-legacy-alias-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const admin = adminPrincipal("admin");

  await assert.rejects(
    () => upsertWhatsAppConnectorAccountForPrincipal({ accountId: "responder", displayName: "New Responder" }, admin, env),
    /wa_account_legacy_role_id_reserved/,
  );

  const migrated = await upsertWhatsAppConnectorAccount({ accountId: "responder", displayName: "Migrated Responder" }, env);
  assert.equal(migrated.legacyCompatibilityAlias, true);

  const updated = await upsertWhatsAppConnectorAccountForPrincipal({ accountId: "responder", displayName: "Renamed Legacy" }, admin, env);
  assert.equal(updated.displayName, "Renamed Legacy");
  assert.equal(updated.legacyCompatibilityAlias, true);
});

test("WhatsApp binding status explains responder readiness and ACL", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bindings-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1",
  };
  await createThread({
    id: "thread-wa",
    name: "WA Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-1@g.us",
      displayName: "WA Chat",
      responderAccountId: "neutral-1",
      outboundAccountId: "neutral-1",
      allowOtherPeople: true,
      mirrorToWhatsApp: true,
    },
    bindingName: "WA Chat",
  }, env);
  await createThread({
    id: "thread-browser",
    name: "Browser Thread",
    binding: {
      connector: "browser",
      desktopSlug: "desktop",
    },
    bindingName: "Browser",
  }, env);

  const payload = await listWhatsAppBindingStatuses({
    env,
    status: {
      mode: "local",
      state: "paired",
      accounts: [{ accountId: "neutral-1", state: "ready", ready: true, authenticated: true }],
    },
  });

  assert.equal(payload.bindings.length, 1);
  assert.equal(payload.bindings[0].state, "ready");
  assert.equal(payload.bindings[0].responderAccountId, "neutral-1");
  assert.equal(payload.bindings[0].acl.send.mode, "all-users");
  assert.deepEqual(payload.precedence, ["chat", "thread", "instance", "user", "account-default"]);
});

test("WhatsApp binding ACL gates scoped bridge send, read, and manage actions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-acl-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1",
  };
  await createThread({
    id: "thread-acl",
    name: "ACL WA",
    ownerUserId: "owner-1",
    binding: {
      connector: "whatsapp",
      chatId: "chat-acl@g.us",
      responderAccountId: "neutral-1",
      outboundAccountId: "neutral-1",
      acl: {
        send: { mode: "users", users: ["remote-send"] },
        read: { mode: "owner-only" },
        receive: { mode: "thread" },
        manage: { mode: "users", users: ["remote-admin"] },
      },
    },
    bindingName: "ACL WA",
  }, env);

  await assertWhatsAppBridgeBindingAcl("send", { chatId: "chat-acl@g.us", accountId: "neutral-1" }, {
    principalId: "remote-send",
    accountId: "neutral-1",
    chatId: "chat-acl@g.us",
  }, env);
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("read", { chatId: "chat-acl@g.us", accountId: "neutral-1" }, {
      principalId: "remote-send",
      accountId: "neutral-1",
      chatId: "chat-acl@g.us",
    }, env),
    /wa_acl_denied/,
  );
  await assertWhatsAppBridgeBindingAcl("read", { chatId: "chat-acl@g.us", accountId: "neutral-1" }, {
    principalId: "owner-1",
    ownerUserId: "owner-1",
    accountId: "neutral-1",
    chatId: "chat-acl@g.us",
  }, env);
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("manage", { chatId: "chat-acl@g.us", accountId: "neutral-1" }, {
      principalId: "owner-1",
      ownerUserId: "owner-1",
      accountId: "neutral-1",
      chatId: "chat-acl@g.us",
    }, env),
    /wa_acl_denied/,
  );
  await assertWhatsAppBridgeBindingAcl("manage", { chatId: "chat-acl@g.us", accountId: "neutral-1" }, {
    principalId: "remote-admin",
    accountId: "neutral-1",
    chatId: "chat-acl@g.us",
  }, env);
});

test("WhatsApp binding ACL rejects scoped token selector mismatches before permissive ACLs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-selector-scope-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1 neutral-2",
  };
  await createThread({
    id: "thread-selector-scope",
    name: "Selector Scope WA",
    ownerUserId: "owner-1",
    binding: {
      connector: "whatsapp",
      chatId: "chat-selector@g.us",
      responderAccountId: "neutral-1",
      outboundAccountId: "neutral-1",
      acl: {
        send: { mode: "all-users" },
        read: { mode: "all-users" },
      },
    },
    bindingName: "Selector Scope WA",
  }, env);

  await assertWhatsAppBridgeBindingAcl("send", { chatId: "chat-selector@g.us", accountId: "neutral-1" }, {
    principalId: "remote-send",
    accountId: "neutral-1",
    chatId: "chat-selector@g.us",
  }, env);
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("send", { chatId: "chat-selector@g.us", accountId: "neutral-1" }, {
      principalId: "remote-send",
      accountId: "neutral-2",
      chatId: "chat-selector@g.us",
    }, env),
    /wa_acl_denied/,
  );
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("read", { chatId: "chat-selector@g.us", accountId: "neutral-1" }, {
      principalId: "remote-read",
      accountId: "neutral-1",
      chatId: "other-chat@g.us",
    }, env),
    /wa_acl_denied/,
  );
});

test("WhatsApp bridge ACL allows scoped demo recipient sends before a binding exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-demo-recipient-scope-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
  };

  await assertWhatsAppBridgeBindingAcl("send", { chatId: "49176123456@c.us", accountId: "responder" }, {
    principalId: "demo-vm-1",
    accountId: "responder",
    allowedPhoneNumbers: ["+49 176 123456"],
  }, env);
  await assertWhatsAppBridgeBindingAcl("send", { chatId: "49176999999@c.us", accountId: "responder" }, {
    principalId: "demo-vm-1",
    accountId: "responder",
    allowedChatIds: ["49176999999@c.us"],
  }, env);
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("send", { chatId: "49176000000@c.us", accountId: "responder" }, {
      principalId: "demo-vm-1",
      accountId: "responder",
      allowedPhoneNumbers: ["+49 176 123456"],
    }, env),
    /wa_acl_denied/,
  );
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("send", { chatId: "49176123456@c.us", accountId: "other" }, {
      principalId: "demo-vm-1",
      accountId: "responder",
      allowedPhoneNumbers: ["+49 176 123456"],
    }, env),
    /wa_acl_denied/,
  );
  await assert.rejects(
    () => assertWhatsAppBridgeBindingAcl("read", { chatId: "49176123456@c.us", accountId: "responder" }, {
      principalId: "demo-vm-1",
      accountId: "responder",
      allowedPhoneNumbers: ["+49 176 123456"],
    }, env),
    /wa_acl_denied/,
  );
});

test("WhatsApp binding resolution fails closed when the responder account is inactive", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bindings-inactive-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1",
  };
  await createThread({
    id: "thread-inactive",
    name: "Inactive WA",
    binding: {
      connector: "whatsapp",
      chatId: "chat-inactive@g.us",
      responderAccountId: "neutral-1",
      outboundAccountId: "neutral-1",
    },
    bindingName: "Inactive WA",
  }, env);

  const resolution = await resolveWhatsAppBinding({ thread: "thread-inactive" }, {
    env,
    status: {
      mode: "local",
      state: "unpaired",
      accounts: [{ accountId: "neutral-1", state: "idle", ready: false }],
    },
  });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.error, "responder_account_inactive");
  assert.equal(resolution.selected.nextAction, "start_or_pair_account");
});

test("WhatsApp binding resolution honors chat thread instance user and account-default precedence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-precedence-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-default neutral-user neutral-instance neutral-thread neutral-chat",
  };
  const status = {
    mode: "local",
    state: "paired",
    accounts: [
      "neutral-default",
      "neutral-user",
      "neutral-instance",
      "neutral-thread",
      "neutral-chat",
    ].map((accountId) => ({ accountId, state: "ready", ready: true, authenticated: true })),
  };
  await createThread({
    id: "thread-prec",
    name: "Precedence Thread",
    ownerUserId: "owner-1",
    binding: {
      connector: "whatsapp",
      level: "thread",
      chatId: "thread-chat@g.us",
      responderAccountId: "neutral-thread",
      outboundAccountId: "neutral-thread",
    },
  }, env);
  await upsertWhatsAppBinding({
    level: "account-default",
    targetAccountId: "neutral-default",
    responderConnectorAccountId: "neutral-default",
  }, env);
  await upsertWhatsAppBinding({
    level: "user",
    ownerUserId: "owner-1",
    responderConnectorAccountId: "neutral-user",
  }, env);
  await upsertWhatsAppBinding({
    level: "instance",
    instanceId: "instance-1",
    responderConnectorAccountId: "neutral-instance",
  }, env);
  await upsertWhatsAppBinding({
    level: "chat",
    chatId: "thread-chat@g.us",
    responderConnectorAccountId: "neutral-chat",
  }, env);

  const payload = await listWhatsAppBindingStatuses({ env, status });
  assert.deepEqual(payload.implementedLevels, ["chat", "thread", "instance", "user", "account-default"]);
  assert.equal(payload.bindings.filter((binding) => binding.responderAccountId === "neutral-default").length, 1);
  assert.equal(payload.bindings.find((binding) => binding.level === "chat").responderAccountId, "neutral-chat");

  const chat = await resolveWhatsAppBinding({ chatId: "thread-chat@g.us" }, { env, status });
  assert.equal(chat.ok, true);
  assert.equal(chat.selected.level, "chat");
  assert.equal(chat.selected.responderAccountId, "neutral-chat");

  const thread = await resolveWhatsAppBinding({ thread: "thread-prec", chatId: "thread-chat@g.us" }, { env, status });
  assert.equal(thread.ok, true);
  assert.equal(thread.selected.level, "chat");
  assert.equal(thread.selected.responderAccountId, "neutral-chat");

  const instance = await resolveWhatsAppBinding({ instanceId: "instance-1" }, { env, status });
  assert.equal(instance.ok, true);
  assert.equal(instance.selected.level, "instance");
  assert.equal(instance.selected.responderAccountId, "neutral-instance");

  const user = await resolveWhatsAppBinding({ ownerUserId: "owner-1" }, { env, status });
  assert.equal(user.ok, true);
  assert.equal(user.selected.level, "user");
  assert.equal(user.selected.responderAccountId, "neutral-user");

  const accountDefault = await resolveWhatsAppBinding({ accountId: "neutral-default" }, { env, status });
  assert.equal(accountDefault.ok, true);
  assert.equal(accountDefault.selected.level, "account-default");
  assert.equal(accountDefault.selected.responderAccountId, "neutral-default");
});

test("WhatsApp binding resolution fails closed for duplicate same-level matches and missing bindings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-ambiguous-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1 neutral-2",
  };
  const status = {
    mode: "local",
    state: "paired",
    accounts: [
      { accountId: "neutral-1", state: "ready", ready: true, authenticated: true },
      { accountId: "neutral-2", state: "ready", ready: true, authenticated: true },
    ],
  };
  await upsertWhatsAppBinding({
    id: "user:first:whatsapp",
    level: "user",
    ownerUserId: "owner-1",
    responderConnectorAccountId: "neutral-1",
  }, env);
  await upsertWhatsAppBinding({
    id: "user:second:whatsapp",
    level: "user",
    ownerUserId: "owner-1",
    responderConnectorAccountId: "neutral-2",
  }, env);

  const ambiguous = await resolveWhatsAppBinding({ ownerUserId: "owner-1" }, { env, status });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "wa_binding_ambiguous");
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.candidates.length, 2);

  const missing = await resolveWhatsAppBinding({ chatId: "missing-chat@g.us" }, { env, status });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "wa_binding_missing");
  assert.deepEqual(missing.candidates, []);
});

test("WhatsApp thread bindings can be written with neutral responder fields and retired", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-write-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "neutral-1 neutral-2",
  };
  await upsertWhatsAppConnectorAccount({ accountId: "neutral-1", displayName: "Neutral 1" }, env);
  await upsertWhatsAppConnectorAccount({ accountId: "neutral-2", displayName: "Neutral 2" }, env);
  await createThread({ id: "thread-write", name: "Write Binding" }, env);

  const created = await upsertWhatsAppThreadBinding({
    threadId: "thread-write",
    chatId: "chat-write@g.us",
    responderConnectorAccountId: "neutral-1",
    acl: { send: { mode: "all-users" } },
  }, env);
  assert.equal(created.thread.binding.responderConnectorAccountId, "neutral-1");
  assert.equal(created.thread.binding.responderAccountId, "neutral-1");
  assert.equal(created.thread.binding.outboundAccountId, "neutral-1");
  assert.equal(created.thread.binding.acl.send.mode, "all-users");

  const updated = await updateWhatsAppThreadBinding("thread-write", {
    responderConnectorAccountId: "neutral-2",
    acl: { send: { mode: "owner-only" } },
  }, env);
  assert.equal(updated.thread.binding.responderConnectorAccountId, "neutral-2");
  assert.equal(updated.thread.binding.outboundAccountId, "neutral-2");
  assert.equal(updated.thread.binding.acl.send.mode, "owner-only");

  const retired = await retireWhatsAppThreadBinding("thread-write", env);
  assert.equal(retired.thread.binding.retired, true);
  assert.equal(retired.thread.binding.enabled, false);
  assert.equal(retired.thread.binding.routeEligible, false);
});

test("WhatsApp broker migration persists accounts and canonicalizes legacy thread bindings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-broker-migration-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID: "responder",
    ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON: JSON.stringify({
      "legacy-send": {
        token: "secret-token",
        scopes: ["whatsapp:bridge:send"],
        accountId: "responder",
        chatId: "legacy@g.us",
      },
    }),
    ORKESTR_WATCHER_THREAD_NAME: "test-wa-migration-watcher",
  };
  const status = {
    mode: "local",
    accounts: [
      { accountId: "sender", state: "idle", ready: false },
      { accountId: "responder", state: "ready", ready: true, authenticated: true },
    ],
  };
  await createThread({
    id: "thread-legacy",
    name: "Legacy WA",
    binding: {
      connector: "whatsapp",
      chatId: "legacy@g.us",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);
  await createThread({
    id: "thread-split",
    name: "Split WA",
    binding: {
      connector: "whatsapp",
      chatId: "split@g.us",
      senderAccountId: "sender",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);

  const dryRun = await migrateWhatsAppBrokerConfig({ dryRun: true, status }, env);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.counts.accountsCreated, 2);
  assert.equal(dryRun.counts.threadBindingsUpdated, 2);
  assert.ok(dryRun.counts.tokenPlansTotal > 0);
  assert.ok(dryRun.tokenPlans.some((plan) => plan.requiredScope === "whatsapp:bridge:send" && plan.tokenConfigured === true));
  assert.ok(dryRun.threadBindings.every((binding) => binding.action === "update" ? binding.acl?.send?.mode : true));
  assert.ok(dryRun.warnings.some((warning) => warning.code === "whatsapp_legacy_account_alias_in_use"));
  assert.ok(dryRun.rollback.instructions.some((line) => /Do not restore old role-naming code paths/.test(line)));
  assert.doesNotMatch(JSON.stringify(dryRun), /secret-token/);
  assert.match(JSON.stringify(dryRun.tokenPlans), /"token":"\[redacted\]"/);
  assert.deepEqual(await readWhatsAppConnectorAccounts(env), []);
  assert.equal((await getThread("thread-legacy", env)).binding.responderConnectorAccountId, undefined);

  const applied = await migrateWhatsAppBrokerConfig({ status }, env);
  assert.equal(applied.dryRun, false);
  assert.equal(applied.counts.accountsCreated, 2);
  assert.equal(applied.counts.threadBindingsUpdated, 2);
  assert.ok(applied.counts.scopedTokensCreated > 0);
  assert.equal(applied.counts.tokenPlansMissing, 0);
  assert.equal(applied.tokenPlans.every((plan) => plan.tokenConfigured === true), true);
  assert.doesNotMatch(JSON.stringify(applied), /secret-token/);
  const storedTokens = await readWhatsAppScopedTokenRecords(env);
  assert.equal(storedTokens.length, applied.counts.scopedTokensCreated);
  assert.equal(storedTokens.every((record) => record.token && record.token.startsWith("wa_")), true);
  const sendToken = storedTokens.find((record) => record.scopes.includes("whatsapp:bridge:send"));
  assert.ok(sendToken);
  const auth = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: `Bearer ${sendToken.token}` },
    socket: { remoteAddress: "127.0.0.1" },
  }, env);
  assert.equal(auth.ok, true);
  assert.equal(auth.machineAuth, "whatsapp_bridge");
  assert.equal(auth.machineAuthContext.chatId, sendToken.chatId);
  assert.equal(auth.machineAuthContext.accountId, sendToken.accountId);
  assert.equal(applied.watcherAlerts.length, 1);
  assert.equal(applied.watcherAlerts[0].ok, true);
  const accounts = await readWhatsAppConnectorAccounts(env);
  assert.equal(accounts.find((account) => account.accountId === "responder")?.autostart, true);
  assert.equal(accounts.find((account) => account.accountId === "sender")?.autostart, false);
  const watcherThread = (await listThreads(env)).find((thread) => thread.name === "test-wa-migration-watcher");
  assert.ok(watcherThread);
  const watcherMessages = await listThreadMessages(watcherThread.id, env);
  assert.match(watcherMessages[0].text, /\[watcher:warning\] server\.whatsappBrokerMigration/);
  assert.match(watcherMessages[0].text, /whatsapp_legacy_alias_in_use/);

  const migratedThread = await getThread("thread-legacy", env);
  assert.equal(migratedThread.binding.id, "thread:thread-legacy:whatsapp");
  assert.equal(migratedThread.binding.responderConnectorAccountId, "responder");
  assert.equal(migratedThread.binding.responderAccountId, "responder");
  assert.equal(migratedThread.binding.outboundAccountId, "responder");

  const payload = await listWhatsAppBindingStatuses({ env, status });
  const legacy = payload.bindings.find((binding) => binding.threadId === "thread-legacy");
  const split = payload.bindings.find((binding) => binding.threadId === "thread-split");
  assert.equal(legacy.compatibilityOnly, false);
  assert.deepEqual(legacy.accountIds, ["responder"]);
  assert.equal(split.compatibilityOnly, true);
  assert.deepEqual(split.accountIds, ["sender", "responder"]);

  const second = await migrateWhatsAppBrokerConfig({ status }, env);
  assert.equal(second.migrated, 0);
  assert.equal(second.counts.accountsUnchanged, 2);
  assert.equal(second.counts.threadBindingsUnchanged, 2);
  assert.equal(second.counts.scopedTokensCreated, 0);
  assert.equal(second.counts.tokenPlansMissing, 0);
});

test("WhatsApp broker migration honors strict configured account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-strict-migration-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID: "sender",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS: "1",
  };
  await upsertWhatsAppConnectorAccount({
    accountId: "responder",
    ownerUserId: "admin",
    displayName: "Old responder",
    autostart: true,
  }, env);
  await createThread({
    id: "strict-old-responder",
    name: "Strict Old Responder",
    binding: {
      connector: "whatsapp",
      chatId: "strict-old@g.us",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);

  const result = await migrateWhatsAppBrokerConfig({
    status: {
      mode: "local",
      accounts: [
        { accountId: "sender", state: "ready", ready: true },
        { accountId: "responder", state: "qr_required", ready: false, autostart: true },
      ],
    },
  }, env);
  const accounts = await readWhatsAppConnectorAccounts(env);

  assert.ok(result.accounts.some((account) => account.accountId === "sender"));
  assert.equal(result.accounts.some((account) => account.accountId === "responder"), false);
  assert.deepEqual(accounts.map((account) => account.accountId), ["responder", "sender"]);
  assert.equal(accounts.find((account) => account.accountId === "responder").autostart, true);
  const listed = listWhatsAppConnectorAccounts({
    env,
    registryAccounts: accounts,
    status: {
      mode: "local",
      accounts: [
        { accountId: "sender", state: "ready", ready: true },
        { accountId: "responder", state: "qr_required", ready: false, autostart: true },
      ],
    },
  });
  assert.deepEqual(listed.map((account) => account.accountId), ["sender"]);
});
