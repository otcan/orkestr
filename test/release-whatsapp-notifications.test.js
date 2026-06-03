import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEvents, readJson } from "../packages/storage/src/store.js";
import { linkUserPrivateIdentity, upsertUser } from "../packages/core/src/users.js";
import {
  listReleaseWhatsAppNotificationTargets,
  releaseWhatsAppNotificationLedgerPath,
  sendReleaseWhatsAppNotifications,
} from "../packages/connectors/src/release-whatsapp-notifications.js";

async function setupUsers(env) {
  await linkUserPrivateIdentity("admin", {
    provider: "whatsapp",
    externalId: "admin-phone",
    chatId: "admin-chat@g.us",
  }, { env, actorUserId: "test" });
  await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env);
  await linkUserPrivateIdentity("alice", {
    provider: "whatsapp",
    accountId: "wa-main",
    externalId: "alice-phone",
    chatId: "alice-chat@g.us",
  }, { env, actorUserId: "test" });
  await upsertUser({ id: "disabled-user", role: "user", status: "disabled" }, env);
  await linkUserPrivateIdentity("disabled-user", {
    provider: "whatsapp",
    externalId: "disabled-phone",
    chatId: "disabled-chat@g.us",
  }, { env, actorUserId: "test" });
}

test("release WhatsApp notifications target external chats and dedupe delivered releases", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-wa-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_RELEASE_WA_NOTIFY_EXCLUDE_CHAT_IDS: "excluded-chat@g.us",
  };
  await setupUsers(env);
  await upsertUser({ id: "excluded", role: "user" }, env);
  await linkUserPrivateIdentity("excluded", {
    provider: "whatsapp",
    externalId: "excluded-phone",
    chatId: "excluded-chat@g.us",
  }, { env, actorUserId: "test" });

  const targets = await listReleaseWhatsAppNotificationTargets(env);
  assert.deepEqual(targets.map((target) => target.chatId), ["alice-chat@g.us"]);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, sent: [{ id: "msg-1" }] };
      },
    };
  };

  const first = await sendReleaseWhatsAppNotifications({
    releaseId: "production-abc123",
    channel: "production",
    commit: "abc123def456",
    deployedAt: "2026-06-03T18:50:55Z",
    apiBase: "http://127.0.0.1:18912",
    token: "cli-token",
  }, env, fetchImpl);

  assert.equal(first.targetCount, 1);
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).chatId, "alice-chat@g.us");
  assert.equal(JSON.parse(calls[0].options.body).accountId, "wa-main");
  assert.equal(calls[0].options.headers.authorization, "Bearer cli-token");

  const second = await sendReleaseWhatsAppNotifications({
    releaseId: "production-abc123",
    channel: "production",
    commit: "abc123def456",
    apiBase: "http://127.0.0.1:18912",
    token: "cli-token",
  }, env, fetchImpl);
  assert.equal(second.skippedDelivered, 1);
  assert.equal(calls.length, 1);

  const ledger = await readJson(releaseWhatsAppNotificationLedgerPath(env), {});
  const delivered = Object.values(ledger.notifications).find((entry) => entry.chatId === "alice-chat@g.us");
  assert.equal(delivered.status, "delivered");
  assert.deepEqual(delivered.messageIds, ["msg-1"]);
  const events = await listEvents(env, 20);
  assert.equal(events.some((event) => event.type === "release_whatsapp_notification_delivered"), true);
  assert.equal(events.some((event) => event.type === "release_whatsapp_notifications_completed"), true);
});

test("release WhatsApp notification failures remain retryable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-wa-fail-"));
  const env = { ORKESTR_HOME: home };
  await setupUsers(env);
  let fail = true;
  const fetchImpl = async () => ({
    ok: !fail,
    status: fail ? 502 : 200,
    async json() {
      return fail ? { error: "bridge_down" } : { ok: true };
    },
  });

  const failed = await sendReleaseWhatsAppNotifications({
    releaseId: "production-retry",
    apiBase: "http://127.0.0.1:18912",
    token: "cli-token",
  }, env, fetchImpl);
  assert.equal(failed.failed, 1);

  fail = false;
  const retried = await sendReleaseWhatsAppNotifications({
    releaseId: "production-retry",
    apiBase: "http://127.0.0.1:18912",
    token: "cli-token",
  }, env, fetchImpl);
  assert.equal(retried.sent, 1);
  const ledger = await readJson(releaseWhatsAppNotificationLedgerPath(env), {});
  assert.equal(Object.values(ledger.notifications)[0].attempts, 2);
  assert.equal(Object.values(ledger.notifications)[0].status, "delivered");
});
