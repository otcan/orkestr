import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAutomationForPrincipal,
  listAutomationsForPrincipal,
  setAutomationEnabledForPrincipal,
} from "../packages/core/src/automations.js";
import { doctorAutomationsForPrincipal } from "../packages/core/src/automation-doctor.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";

test("automation doctor covers timers, watches, desktops, connector status, and paused state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-automations-doctor-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
  };
  const principal = adminPrincipal();
  await createThread({ id: "automation-doctor-thread", name: "Automation Doctor Thread" }, env);
  await createTimer({
    label: "LinkedIn check",
    targetType: "thread",
    target: "automation-doctor-thread",
    prompt: "Check LinkedIn",
    cadence: "interval",
    every: "1h",
    requiredDesktop: "linkedin",
  }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2026-05-15T09:00:00.000Z";
  timers[0].lastError = "desktop_not_provisioned";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);
  const gmail = await createAutomationForPrincipal({
    type: "gmail_notification",
    label: "Gmail watch",
    targetType: "thread",
    target: "automation-doctor-thread",
    query: "is:unread newer_than:1d",
    interval: "5m",
    maxItemsPerRun: 1,
    enabled: true,
  }, principal, env, { thread: { id: "automation-doctor-thread" } });
  await setAutomationEnabledForPrincipal({ automationId: gmail.automation.automationId }, false, principal, env);
  await createAutomationForPrincipal({
    type: "gmail_notification",
    label: "Active Gmail watch",
    targetType: "thread",
    target: "automation-doctor-thread",
    query: "from:alerts@example.com newer_than:1d",
    interval: "5m",
    maxItemsPerRun: 1,
    enabled: true,
  }, principal, env, { thread: { id: "automation-doctor-thread" } });

  const result = await doctorAutomationsForPrincipal(principal, env, new Date("2026-05-15T10:00:00.000Z"), {
    connectorStatusProvider: async () => ({ ok: true, state: "parent_config_missing", connected: false }),
    browserSessionsProvider: async () => ({
      ok: true,
      sessions: [{ slug: "linkedin", state: "not_prepared", configured: false }],
    }),
  });
  const codes = result.issues.map((issue) => issue.code).sort();

  assert.equal(result.status, "broken");
  assert.equal(result.ok, false);
  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.enabled, 2);
  assert.equal(result.counts.paused, 1);
  assert.equal(result.counts.byType.timer, 1);
  assert.equal(result.counts.byType.gmail_notification, 2);
  assert.equal(codes.includes("automation_overdue"), true);
  assert.equal(codes.includes("connector_not_connected"), true);
  assert.equal(codes.includes("desktop_not_provisioned"), true);
  assert.equal(codes.includes("last_automation_error"), true);
});

test("automation list and pause helpers keep unified ids across timer and Gmail watch records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-automations-list-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
  };
  const principal = adminPrincipal();
  await createThread({ id: "automation-list-thread", name: "Automation List Thread" }, env);
  const timer = await createAutomationForPrincipal({
    type: "timer",
    label: "Daily check",
    targetType: "thread",
    target: "automation-list-thread",
    cadence: "daily",
    prompt: "Run daily check",
    enabled: true,
  }, principal, env, { thread: { id: "automation-list-thread" } });
  const gmail = await createAutomationForPrincipal({
    type: "gmail_notification",
    label: "Unread Gmail",
    targetType: "thread",
    target: "automation-list-thread",
    query: "is:unread newer_than:1d",
    interval: "5m",
    maxItemsPerRun: 1,
    enabled: true,
  }, principal, env, { thread: { id: "automation-list-thread" } });

  await setAutomationEnabledForPrincipal({ automationId: timer.automation.automationId }, false, principal, env);
  await setAutomationEnabledForPrincipal({ automationId: gmail.automation.automationId }, false, principal, env);
  const listed = await listAutomationsForPrincipal(principal, env);

  assert.deepEqual(listed.map((automation) => automation.enabled), [false, false]);
  assert.equal(listed.some((automation) => automation.automationId.startsWith("timer:")), true);
  assert.equal(listed.some((automation) => automation.automationId.startsWith("gmail_notification:")), true);
});
