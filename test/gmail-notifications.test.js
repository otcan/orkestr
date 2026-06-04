import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGmailNotification,
  listGmailNotifications,
  runDueGmailNotifications,
  runGmailNotificationNow,
} from "../packages/core/src/gmail-notifications.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { exchangeGmailCode } from "../packages/connectors/src/gmail.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function gmailMessage({ id, subject, from, snippet, text }) {
  return {
    id,
    threadId: `thread-${id}`,
    snippet,
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
        { name: "To", value: "me@example.com" },
        { name: "Date", value: "Wed, 03 Jun 2026 10:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(text, "utf8").toString("base64url") },
    },
  };
}

test("gmail notifications schedule safe previews and dedupe Gmail message ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-notifications-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  };
  await createThread({
    id: "gmail-notification-thread",
    name: "Gmail Notification Thread",
    binding: { connector: "whatsapp", chatId: "chat-gmail-notifications", outboundAccountId: "wa-1" },
  }, env);
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "gmail-notification-access",
      refresh_token: "gmail-notification-refresh",
      expires_in: 3600,
    }),
  );

  const notification = await createGmailNotification({
    label: "Unread alerts",
    threadId: "gmail-notification-thread",
    query: "from:alerts@example.com newer_than:1d",
    interval: "1m",
    enabled: true,
  }, env);

  assert.equal(notification.query, "from:alerts@example.com newer_than:1d");
  assert.equal(notification.intervalMs, 300000);
  assert.equal(notification.every, "5m");
  assert.equal(notification.sourceConfig.maxResults, 1);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, "Bearer gmail-notification-access");
    if (url.pathname.endsWith("/messages") && !url.pathname.match(/\/messages\/[^/]+$/)) {
      assert.equal(url.searchParams.get("q"), "from:alerts@example.com newer_than:1d");
      assert.equal(url.searchParams.get("maxResults"), "1");
      return jsonResponse({
        messages: [{ id: "gmail-msg-1", threadId: "gmail-thread-1" }],
        resultSizeEstimate: 1,
      });
    }
    if (url.pathname.endsWith("/messages/gmail-msg-1")) {
      return jsonResponse(gmailMessage({
        id: "gmail-msg-1",
        subject: "Alert one",
        from: "alerts@example.com",
        snippet: "Preview only",
        text: "Full body should not be included by the default notification template.",
      }));
    }
    throw new Error(`unexpected Gmail fetch ${url.href}`);
  };

  const due = await runDueGmailNotifications(env, new Date(Date.now() + 1000), fetchImpl);
  const duplicate = await runGmailNotificationNow(notification.id, env, fetchImpl);
  const messages = await listThreadMessages("gmail-notification-thread", env);
  const notifications = await listGmailNotifications(env);

  assert.equal(due.length, 1);
  assert.equal(due[0].run.delivered.length, 1);
  assert.equal(duplicate.run.delivered.length, 0);
  assert.equal(duplicate.run.skipped[0].reason, "duplicate");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "connector_prompt_push");
  assert.equal(messages[0].connector, "gmail");
  assert.equal(messages[0].chatId, "chat-gmail-notifications");
  assert.equal(messages[0].accountId, "wa-1");
  assert.equal(messages[0].externalId, "gmail-msg-1");
  assert.match(messages[0].text, /Subject: Alert one/);
  assert.match(messages[0].text, /From: alerts@example\.com/);
  assert.match(messages[0].text, /Snippet: Preview only/);
  assert.doesNotMatch(messages[0].text, /Full body should not be included/);
  assert.equal(notifications[0].deliveredCount, 1);
  assert.equal(notifications[0].processedSourceItemCount, 1);
  assert.ok(Date.parse(notifications[0].nextRunAt) > Date.now());
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/messages")).length, 2);
});
