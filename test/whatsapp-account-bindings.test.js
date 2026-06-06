import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listWhatsAppBindingStatuses,
  listWhatsAppConnectorAccounts,
  resolveWhatsAppBinding,
} from "../packages/connectors/src/whatsapp-account-bindings.js";
import { createThread } from "../packages/core/src/threads.js";

test("WhatsApp connector accounts are projected as neutral accounts with legacy aliases", () => {
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
        { accountId: "sender", label: "Old Sender", state: "idle", ready: false, sessionRoot: "/private/session" },
        { accountId: "responder", label: "Old Responder", state: "ready", ready: true, authenticated: true },
      ],
    },
  });

  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.kind), ["connector_account", "connector_account"]);
  assert.deepEqual(accounts.find((account) => account.accountId === "sender").legacyRoleAliases, ["sender"]);
  assert.deepEqual(accounts.find((account) => account.accountId === "responder").legacyRoleAliases, ["responder"]);
  assert.equal(accounts.find((account) => account.accountId === "responder").sendReady, true);
  assert.equal(Object.hasOwn(accounts[0], "sessionRoot"), false);
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
