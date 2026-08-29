import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { listEvents } from "../packages/storage/src/store.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { listProjectInquiries, submitProjectInquiry } from "../packages/core/src/project-inquiries.js";

function validProject(overrides = {}) {
  return {
    contactName: "Alex Example",
    workEmail: "alex@example.test",
    company: "Example Industries",
    role: "Managing Director",
    projectType: "find",
    projectName: "Public opportunity intelligence",
    desiredOutcome: "Find and structure relevant public tenders every morning, explain why each result matches, and prepare a review queue for the bid team.",
    currentSituation: "Two employees repeatedly search many public procurement websites and copy possible matches into a spreadsheet.",
    usersAndVolume: "Six bid-team users, roughly 40 approved sources, and an expected daily review queue.",
    systemsOrSources: "Public procurement portals, company criteria, a new private database, and email notifications.",
    decisionOwner: "Commercial Director",
    constraints: "Use only public or explicitly authorized sources, retain provenance, and require a human decision before tracking a tender.",
    successCriteria: "Reduce daily manual searching while keeping source coverage, false positives, and missed relevant notices measurable.",
    timeframe: "1-3-months",
    consentToContact: true,
    formStartedAt: Date.now() - 5_000,
    ...overrides,
  };
}

function validQuickProject(overrides = {}) {
  return {
    intakeMode: "quick",
    contactName: "Sam Example",
    workEmail: "sam@example.test",
    projectType: "replace",
    desiredOutcome: "Replace our old internal ordering tool with a reliable system that staff can use without spreadsheets or duplicate entry.",
    consentToContact: true,
    formStartedAt: Date.now() - 5_000,
    ...overrides,
  };
}

test("project inquiries are validated, assessed, notified, and stored separately", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-project-inquiries-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL: "https://calendar.example.test/discovery" };
  const notifications = [];
  const first = await submitProjectInquiry(validProject(), env, {
    async sendProjectInquiryNotification(inquiry) {
      notifications.push(inquiry);
      return { ok: true, configured: true, recipients: ["projects@example.test"], messageId: "msg-1" };
    },
  });
  const duplicate = await submitProjectInquiry(validProject({ formStartedAt: Date.now() - 5_000 }), env, {
    async sendProjectInquiryNotification() { throw new Error("duplicate_should_not_notify"); },
  });
  const exploring = await submitProjectInquiry(validProject({
    workEmail: "exploring@example.test",
    projectType: "not-sure",
    projectName: "Early project idea",
    desiredOutcome: "We want to understand whether a small digital system could improve how customers request information.",
    currentSituation: "The team is still exploring and has not documented the process.",
    successCriteria: "Agree a credible problem and next step.",
    timeframe: "exploring",
  }), env, { async sendProjectInquiryNotification() { return { ok: false, configured: false, skippedReason: "test" }; } });
  const stored = await listProjectInquiries(env);
  const waitlistExists = await fs.stat(dataPaths(env).waitlist).then(() => true, () => false);
  const workflowExists = await fs.stat(dataPaths(env).workflowLeads).then(() => true, () => false);

  assert.equal(first.submitted, true);
  assert.equal(first.inquiry.readyForDiscovery, true);
  assert.equal(first.inquiry.schedulingUrl, "https://calendar.example.test/discovery");
  assert.equal(duplicate.submitted, false);
  assert.equal(duplicate.inquiry.id, first.inquiry.id);
  assert.equal(exploring.inquiry.readyForDiscovery, false);
  assert.equal(exploring.inquiry.schedulingUrl, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(stored.inquiries.length, 2);
  assert.equal(stored.inquiries[0].notification.state, "sent");
  assert.equal(waitlistExists, false);
  assert.equal(workflowExists, false);
});

test("project inquiry validation rejects spam, missing consent, invalid categories, and fast submissions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-project-validation-"));
  const env = { ORKESTR_HOME: home };
  await assert.rejects(() => submitProjectInquiry(validProject({ companyWebsite: "https://spam.example" }), env), /project_submit_rejected/);
  await assert.rejects(() => submitProjectInquiry(validProject({ consentToContact: false }), env), /project_contact_consent_required/);
  await assert.rejects(() => submitProjectInquiry(validProject({ projectType: "anything" }), env), /project_type_invalid/);
  await assert.rejects(() => submitProjectInquiry(validProject({ timeframe: "tomorrow" }), env), /project_timeframe_invalid/);
  await assert.rejects(() => submitProjectInquiry(validProject({ formStartedAt: Date.now() }), env), /project_submit_too_fast/);
});

test("quick project briefs require only four answers and receive the configured booking handoff", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-quick-project-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL: "https://calendar.example.test/discovery" };
  const submitted = await submitProjectInquiry(validQuickProject(), env, {
    async sendProjectInquiryNotification() { return { ok: false, configured: false, skippedReason: "test" }; },
  });
  const stored = await listProjectInquiries(env);

  assert.equal(submitted.submitted, true);
  assert.equal(submitted.inquiry.readyForDiscovery, false);
  assert.equal(submitted.inquiry.schedulingUrl, "https://calendar.example.test/discovery");
  assert.match(submitted.message, /reply using your work email/i);
  assert.equal(stored.inquiries[0].intakeMode, "quick");
  assert.equal(stored.inquiries[0].company, "");
  assert.equal(stored.inquiries[0].role, "");
  assert.equal(stored.inquiries[0].timeframe, "exploring");
  assert.match(stored.inquiries[0].projectName, /^replace · Replace our old/);
});

test("public Project Discovery and analytics endpoints stay anonymous and analytics remain metadata-only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-project-api-"));
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL", "ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAILS", "ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAIL"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  delete process.env.ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL;
  delete process.env.ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAILS;
  delete process.env.ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAIL;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const submitted = await fetch(`http://127.0.0.1:${port}/api/public/project-inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validProject()),
    });
    const payload = await submitted.json();
    const tracked = await fetch(`http://127.0.0.1:${port}/api/public/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "book_project_hero", path: "/", desiredOutcome: "must not be stored" }),
    });
    const ignored = await fetch(`http://127.0.0.1:${port}/api/public/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "arbitrary_sensitive_event", path: "/project" }),
    });
    const events = await listEvents(process.env, 20);
    const analytics = events.filter((event) => event.type === "public_site_analytics");

    assert.equal(submitted.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.inquiry.readyForDiscovery, true);
    assert.equal(payload.schedulingUrl, undefined);
    assert.equal(tracked.status, 202);
    assert.equal(ignored.status, 202);
    assert.deepEqual(analytics.map(({ event, path: eventPath }) => ({ event, path: eventPath })), [{ event: "book_project_hero", path: "/" }]);
    assert.equal(JSON.stringify(analytics).includes("must not be stored"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
