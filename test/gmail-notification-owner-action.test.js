import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGmailNotification, listGmailNotifications, runDueGmailNotifications } from "../packages/core/src/gmail-notifications.js";
import { gmailNotificationOwnerAction } from "../packages/core/src/gmail-notification-owner-action.js";
import { createThread } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";

const minute = 60_000;

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-owner-action-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: String(5 * minute),
    ORKESTR_GMAIL_NOTIFICATION_BLOCKED_RECHECK_MS: String(30 * minute),
  };
  await createThread({
    id: "gmail-owner-action-thread",
    name: "Gmail Owner Action Thread",
    binding: { connector: "whatsapp", chatId: "chat-gmail-owner-action", outboundAccountId: "wa-1" },
  }, env);
  const notification = await createGmailNotification({
    threadId: "gmail-owner-action-thread",
    query: "is:unread newer_than:1d",
    interval: "5m",
    enabled: true,
  }, env);
  return { env, notification };
}

const noFetch = async () => {
  throw new Error("unconfigured Gmail must not reach the network");
};

test("owner-fixable Gmail failures are reported once and re-checked slowly", async (t) => {
  const { env, notification } = await fixture(t);
  const start = Date.now() + 1000;
  // Runs every 5 minutes for an hour: only the first and the 30-minute re-check are due.
  let attempts = 0;
  for (let step = 0; step <= 12; step += 1) {
    const results = await runDueGmailNotifications(env, new Date(start + step * 5 * minute), noFetch);
    attempts += results.length;
    for (const result of results) assert.equal(result.ok, false);
  }
  const events = await listEvents(env, 200);
  const [current] = await listGmailNotifications(env);

  assert.equal(attempts, 3);
  assert.equal(events.filter((event) => event.type === "gmail_notification_blocked").length, 1);
  assert.equal(events.filter((event) => event.type === "gmail_notification_run_failed").length, 0);
  const blocked = events.find((event) => event.type === "gmail_notification_blocked");
  assert.equal(blocked.notificationId, notification.id);
  assert.equal(blocked.error, "gmail_oauth_config_required");
  assert.equal(blocked.action, "configure");
  assert.equal(current.status, "needs_owner_action");
  assert.equal(current.blockedReason, "gmail_oauth_config_required");
  assert.match(current.ownerAction, /Setup > Connectors/);
  assert.equal(current.failureCount, 3);
});

test("Gmail owner actions classify revoked tokens and ignore transient failures", () => {
  assert.equal(gmailNotificationOwnerAction(Object.assign(new Error("reconnect_required"), { code: "reconnect_required" })).action, "reconnect");
  assert.equal(gmailNotificationOwnerAction(Object.assign(new Error("Token has been expired or revoked."), { providerStatus: 400, providerCode: "invalid_grant" })).code, "gmail_reauthorization_required");
  assert.equal(gmailNotificationOwnerAction(new Error("connector_selection_required")).action, "choose_account");
  assert.equal(gmailNotificationOwnerAction(Object.assign(new Error("gmail_http_503"), { providerStatus: 503 })), null);
  assert.equal(gmailNotificationOwnerAction(new Error("fetch failed")), null);
});
