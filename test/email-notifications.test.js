import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail, waitlistNotificationConfig } from "../packages/core/src/email-notifications.js";

test("waitlist notifications can use Outlook SMTP environment aliases", () => {
  const config = waitlistNotificationConfig({
    ORKESTR_WAITLIST_NOTIFY_EMAIL: "admin@example.test",
    ORKESTR_OUTLOOK_SMTP_USER: "notifications@example.test",
    ORKESTR_OUTLOOK_SMTP_PASSWORD: "secret",
  });

  assert.equal(config.configured, true);
  assert.deepEqual(config.recipients, ["admin@example.test"]);
  assert.equal(config.from, "notifications@example.test");
});

test("waitlist notifications prefer generic SMTP settings over Outlook aliases", () => {
  const config = waitlistNotificationConfig({
    ORKESTR_WAITLIST_NOTIFY_EMAIL: "admin@example.test",
    ORKESTR_SMTP_HOST: "smtp.example.test",
    ORKESTR_SMTP_FROM: "generic@example.test",
    ORKESTR_OUTLOOK_SMTP_USER: "notifications@example.test",
  });

  assert.equal(config.configured, true);
  assert.equal(config.from, "generic@example.test");
});

test("waitlist notifications can use Microsoft Graph mail", () => {
  const config = waitlistNotificationConfig({
    ORKESTR_MAIL_PROVIDER: "graph",
    ORKESTR_WAITLIST_NOTIFY_EMAIL: "admin@example.test",
    ORKESTR_GRAPH_MAIL_FROM: "hello@example.test",
    ORKESTR_GRAPH_MAIL_TOKEN_COMMAND_JSON: "[\"/usr/bin/print-token\"]",
  });

  assert.equal(config.configured, true);
  assert.equal(config.provider, "graph");
  assert.deepEqual(config.recipients, ["admin@example.test"]);
  assert.equal(config.from, "hello@example.test");
});

test("Graph mail sender posts to Microsoft Graph sendMail", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("", {
      status: 202,
      headers: {
        "request-id": "graph-request-1",
      },
    });
  };
  try {
    const result = await sendEmail({
      to: "admin@example.test",
      subject: "Graph test",
      text: "hello",
    }, {
      ORKESTR_MAIL_PROVIDER: "graph",
      ORKESTR_GRAPH_MAIL_ACCESS_TOKEN: "token-value",
      ORKESTR_GRAPH_MAIL_FROM: "hello@example.test",
      ORKESTR_GRAPH_MAIL_SENDER: "sender@example.test",
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "graph");
    assert.equal(result.messageId, "graph-request-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://graph.microsoft.com/v1.0/me/sendMail");
    assert.equal(calls[0].options.headers.Authorization, "Bearer token-value");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.message.from.emailAddress.address, "hello@example.test");
    assert.equal(body.message.sender.emailAddress.address, "sender@example.test");
    assert.equal(body.message.toRecipients[0].emailAddress.address, "admin@example.test");
    assert.equal(body.message.body.content, "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
