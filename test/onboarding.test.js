import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const onboardingSources = [
  "apps/web/src/app/onboarding-page.component.ts",
  "apps/web/src/app/onboarding-page.component.html",
];

async function readSources(paths) {
  return (await Promise.all(paths.map((sourcePath) => fs.readFile(sourcePath, "utf8")))).join("\n");
}

test("onboarding focuses the first loop on virtual desktop and WhatsApp", async () => {
  const onboarding = await readSources(onboardingSources);
  const browsers = await fs.readFile("packages/browsers/src/browsers.js", "utf8");

  assert.ok(!onboarding.includes("Job Search Assistant"));
  assert.ok(!onboarding.includes("job-search"));
  assert.ok(!onboarding.includes("codex login"));
  assert.ok(!onboarding.includes("CODEX_HOME="));
  assert.ok(!onboarding.includes("Open anyway"));
  assert.ok(!onboarding.includes("Browser pairing code"));
  assert.ok(onboarding.includes("Virtual Desktop Generation"));
  assert.ok(onboarding.includes("Open Codex sign-in"));
  assert.ok(onboarding.includes('id: "virtual-desktop"'));
  assert.ok(onboarding.includes("Create first thread"));
  assert.ok(onboarding.includes("Bind WhatsApp chat"));
  assert.ok(onboarding.includes("Send test message"));
  assert.ok(onboarding.includes('type SetupPageMode = "setup" | "onboarding"'));
  assert.ok(onboarding.includes("Setup stays available after onboarding"));
  assert.ok(onboarding.includes("@if (isOnboardingMode())"));
  assert.ok(onboarding.includes("setupSections()"));
  assert.ok(onboarding.includes("Mail Auth"));
  assert.ok(onboarding.includes("Connect Gmail"));
  assert.ok(onboarding.includes("Connect Outlook"));
  assert.ok(onboarding.includes("Create a Microsoft app registration"));
  assert.ok(onboarding.includes("Gmail Probe"));
  assert.ok(onboarding.includes("setupSectionChange"));
  assert.ok(onboarding.includes("@Output() paired"));
  assert.ok(onboarding.includes("this.paired.emit()"));
  assert.ok(onboarding.includes("Browser approvals"));
  assert.ok(onboarding.includes("Approve pending pairing challenges"));
  assert.ok(onboarding.includes('label: "Desktops"'));
  assert.ok(browsers.includes('slug: "desktop"'));
});
