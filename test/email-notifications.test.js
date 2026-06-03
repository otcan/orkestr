import assert from "node:assert/strict";
import test from "node:test";
import { waitlistNotificationConfig } from "../packages/core/src/email-notifications.js";

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
