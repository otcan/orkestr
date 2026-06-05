import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGmailNotification,
  createGmailNotificationForPrincipal,
  listGmailNotifications,
  runDueGmailNotifications,
  runGmailNotificationNow,
  updateGmailNotificationForPrincipal,
} from "../packages/core/src/gmail-notifications.js";
import { getConnectorPromptPush } from "../packages/core/src/connector-pushes.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
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

test("due Gmail notifications use the rule owner's scoped token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-notification-owner-scope-"));
  const script = path.join(home, "allow-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  console.log(JSON.stringify({ allow: true, reason: 'test-allow', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await createUser({ id: "alice", role: "user", displayName: "Alice" }, env);
  const principal = userPrincipal({ id: "alice", role: "user" });
  await createThread({
    id: "alice-gmail-notification-thread",
    ownerUserId: "alice",
    name: "Alice Gmail Notification Thread",
    binding: { connector: "whatsapp", chatId: "chat-alice", outboundAccountId: "wa-1" },
  }, env);
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "alice-gmail-notification-access",
      refresh_token: "alice-gmail-notification-refresh",
      expires_in: 3600,
    }), { principal });
  const notification = await createGmailNotificationForPrincipal({
    label: "Alice unread Gmail",
    threadId: "alice-gmail-notification-thread",
    query: "is:unread newer_than:1d",
    interval: "5m",
    enabled: true,
  }, principal, env, { thread: { id: "alice-gmail-notification-thread" } });

  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.authorization, "Bearer alice-gmail-notification-access");
    if (url.pathname.endsWith("/messages") && !url.pathname.match(/\/messages\/[^/]+$/)) {
      return jsonResponse({
        messages: [{ id: "alice-msg-1", threadId: "alice-thread-1" }],
        resultSizeEstimate: 1,
      });
    }
    if (url.pathname.endsWith("/messages/alice-msg-1")) {
      return jsonResponse(gmailMessage({
        id: "alice-msg-1",
        subject: "Alice alert",
        from: "alerts@example.com",
        snippet: "Scoped preview",
        text: "Scoped body",
      }));
    }
    throw new Error(`unexpected Gmail fetch ${url.href}`);
  };
  const due = await runDueGmailNotifications(env, new Date(Date.now() + 1000), fetchImpl);
  const messages = await listThreadMessages("alice-gmail-notification-thread", env);

  assert.equal(notification.ownerUserId, "alice");
  assert.equal(due.length, 1);
  assert.equal(due[0].run.delivered.length, 1);
  assert.equal(messages[0].ownerUserId, "alice");
  assert.match(messages[0].text, /Subject: Alice alert/);
});

test("gmail notification update resolves the current thread rule and can suppress visible push output", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-notification-update-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  };
  const thread = await createThread({
    id: "gmail-notification-update-thread",
    name: "Gmail Notification Update Thread",
    binding: { connector: "whatsapp", chatId: "chat-gmail-update", outboundAccountId: "wa-1" },
  }, env);
  const created = await createGmailNotification({
    label: "Unread alerts",
    threadId: thread.id,
    query: "is:unread newer_than:1d",
    interval: "5m",
    enabled: true,
  }, env);

  const updated = await updateGmailNotificationForPrincipal("", {
    threadId: thread.id,
    fromMe: true,
    fromAddress: "me@example.com",
    interval: "15m",
    noReply: true,
  }, adminPrincipal(), env, { thread });
  const stored = await getConnectorPromptPush(created.id, env);

  assert.equal(updated.id, created.id);
  assert.equal(updated.query, "from:me@example.com newer_than:1d");
  assert.equal(updated.every, "15m");
  assert.equal(stored.promptTemplate, "NO_REPLY");
  assert.equal(stored.safety.noReplyBehavior, "suppress");
});
