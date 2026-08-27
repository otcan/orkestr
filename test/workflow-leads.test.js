import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { listEvents } from "../packages/storage/src/store.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { listWorkflowLeads, submitWorkflowLead } from "../packages/core/src/workflow-leads.js";

function validLead(overrides = {}) {
  return {
    contactName: "Alex Example",
    workEmail: "alex@example.test",
    company: "Example Manufacturing",
    role: "Operations Director",
    workflowName: "Invoice exception handling",
    workflowDescription: "Receive an invoice, compare the purchase order, stop on a mismatch, and route the decision.",
    frequency: "daily",
    monthlyVolume: 250,
    systems: "Shared mailbox, document store, ERP",
    workflowOwner: "Finance Operations Manager",
    approvals: "Finance approves amount and vendor exceptions before posting.",
    costOrDelay: "Twelve manual hours per week and a three-day exception delay.",
    successCriteria: "Reduce median exception time below one business day without increasing posting errors.",
    consentToContact: true,
    formStartedAt: Date.now() - 5_000,
    ...overrides,
  };
}

test("workflow leads are validated, qualified, notified, and stored separately from beta waitlist", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-workflow-leads-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL: "https://calendar.example.test/orkestr-pilot",
  };
  const notifications = [];
  const first = await submitWorkflowLead(validLead(), env, {
    async sendWorkflowLeadNotification(lead) {
      notifications.push(lead);
      return { ok: true, configured: true, recipients: ["pilot@example.test"], messageId: "msg-1" };
    },
  });
  const duplicate = await submitWorkflowLead(validLead({ formStartedAt: Date.now() - 5_000 }), env, {
    async sendWorkflowLeadNotification() { throw new Error("duplicate_should_not_notify"); },
  });
  const unqualified = await submitWorkflowLead(validLead({
    workEmail: "case-two@example.test",
    workflowName: "One-time migration",
    frequency: "one-time",
    monthlyVolume: 1,
    systems: "Spreadsheet",
  }), env, { async sendWorkflowLeadNotification() { return { ok: false, configured: false, skippedReason: "test" }; } });
  const stored = await listWorkflowLeads(env);
  const waitlistExists = await fs.stat(dataPaths(env).waitlist).then(() => true, () => false);

  assert.equal(first.submitted, true);
  assert.equal(first.lead.qualified, true);
  assert.equal(first.lead.schedulingUrl, "https://calendar.example.test/orkestr-pilot");
  assert.equal(duplicate.submitted, false);
  assert.equal(duplicate.lead.id, first.lead.id);
  assert.equal(unqualified.lead.qualified, false);
  assert.equal(unqualified.lead.schedulingUrl, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(stored.leads.length, 2);
  assert.equal(stored.leads[0].notification.state, "sent");
  assert.equal(waitlistExists, false);
});

test("workflow lead validation rejects spam, missing consent, invalid volume, and over-fast submissions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-workflow-validation-"));
  const env = { ORKESTR_HOME: home };
  await assert.rejects(() => submitWorkflowLead(validLead({ companyWebsite: "https://spam.example" }), env), /workflow_submit_rejected/);
  await assert.rejects(() => submitWorkflowLead(validLead({ consentToContact: false }), env), /workflow_contact_consent_required/);
  await assert.rejects(() => submitWorkflowLead(validLead({ monthlyVolume: 0 }), env), /workflow_monthly_volume_invalid/);
  await assert.rejects(() => submitWorkflowLead(validLead({ formStartedAt: Date.now() }), env), /workflow_submit_too_fast/);
});

test("public workflow and analytics endpoints remain anonymous while storing only allowlisted analytics fields", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-workflow-api-"));
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL", "ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAILS", "ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  delete process.env.ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL;
  delete process.env.ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAILS;
  delete process.env.ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const submitted = await fetch(`http://127.0.0.1:${port}/api/public/workflow-leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validLead()),
    });
    const payload = await submitted.json();
    const tracked = await fetch(`http://127.0.0.1:${port}/api/public/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "book_call_hero", path: "/", workflowDescription: "must not be stored" }),
    });
    const ignored = await fetch(`http://127.0.0.1:${port}/api/public/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "arbitrary_sensitive_event", path: "/" }),
    });
    const events = await listEvents(process.env, 20);
    const analytics = events.filter((event) => event.type === "public_site_analytics");

    assert.equal(submitted.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.lead.qualified, true);
    assert.equal(payload.schedulingUrl, undefined);
    assert.equal(tracked.status, 202);
    assert.equal(ignored.status, 202);
    assert.equal(analytics.length, 1);
    assert.deepEqual(analytics.map(({ event, path }) => ({ event, path })), [{ event: "book_call_hero", path: "/" }]);
    assert.equal(JSON.stringify(analytics).includes("must not be stored"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
