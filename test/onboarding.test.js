import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const onboardingSources = [
  "apps/web/src/app/app.component.ts",
  "apps/web/src/app/onboarding-page.component.ts",
  "apps/web/src/app/onboarding-page.component.html",
];

async function readSources(paths) {
  return (await Promise.all(paths.map((sourcePath) => fs.readFile(sourcePath, "utf8")))).join("\n");
}

test("onboarding focuses the starter setup on virtual desktop and WhatsApp", async () => {
  const onboarding = await readSources(onboardingSources);
  const browsers = await fs.readFile("packages/browsers/src/browsers.js", "utf8");

  assert.ok(!onboarding.includes("Job Search Assistant"));
  assert.ok(!onboarding.includes("job-search"));
  assert.ok(!onboarding.includes("codex login"));
  assert.ok(!onboarding.includes("CODEX_HOME="));
  assert.ok(!onboarding.includes("Open anyway"));
  assert.ok(!onboarding.includes("Browser pairing code"));
  assert.ok(!onboarding.includes("Choose your first workflow"));
  assert.ok(!onboarding.includes("Pick the first workflow"));
  assert.ok(!onboarding.includes("System check"));
  assert.ok(!onboarding.includes("Choose what to add first"));
  assert.ok(onboarding.includes("Self-hosted agent cockpit"));
  assert.ok(onboarding.includes("Set up Orkestr"));
  assert.ok(onboarding.includes("Start with one capability"));
  assert.ok(onboarding.includes("Connect only what you need now"));
  assert.ok(onboarding.includes("persistent Codex threads"));
  assert.ok(onboarding.includes("buildStamp()"));
  assert.ok(onboarding.includes("Connections"));
  assert.ok(onboarding.includes("Review runtime items that need attention"));
  assert.ok(onboarding.includes("Operational auth surfaces have their own setup sections"));
  assert.ok(onboarding.includes("Codex Agent"));
  assert.ok(onboarding.includes("Required runtime"));
  assert.ok(onboarding.includes("OpenAI API"));
  assert.ok(onboarding.includes("Optional API"));
  assert.ok(onboarding.includes("agentRuntimeStateLabel()"));
  assert.ok(onboarding.includes("canOpenApp()"));
  assert.ok(onboarding.includes("openAppBlockReason()"));
  assert.ok(onboarding.includes("Connect Codex Agent before opening Orkestr."));
  assert.ok(onboarding.includes("runtime-blocker"));
  assert.ok(onboarding.includes("[disabled]=\"busy || !canOpenApp()\""));
  assert.ok(onboarding.includes("requiredConnectorSteps()"));
  assert.ok(onboarding.includes("Agents should acquire Orkestr desktop leases"));
  assert.ok(onboarding.includes("Codex from WhatsApp"));
  assert.ok(onboarding.includes("Managed browser desktop"));
  assert.ok(onboarding.includes("Mail summaries"));
  assert.ok(onboarding.includes("Open Codex sign-in"));
  assert.ok(onboarding.includes("Connect Codex with API key"));
  assert.ok(onboarding.includes("loginCodexWithApiKey"));
  assert.ok(onboarding.includes("codexAuthPoller"));
  assert.ok(onboarding.includes("startCodexAuthPolling"));
  assert.ok(onboarding.includes("pollCodexAuth"));
  assert.ok(onboarding.includes("Codex connected. You can open Orkestr when ready."));
  assert.ok(onboarding.includes("Codex sign-in expired. Start again."));
  assert.ok(!onboarding.includes("globalThis.setTimeout(() => this.openApp(), 250)"));
  assert.ok(onboarding.includes("agentRuntimeReady()"));
  assert.ok(onboarding.includes("codexCommandAvailable()"));
  assert.ok(onboarding.includes("codexCommandUnavailableHint()"));
  assert.ok(onboarding.includes("Host Codex is disabled for this macOS local install."));
  assert.ok(onboarding.includes("[disabled]=\"busy || !codexCommandAvailable()\""));
  assert.ok(onboarding.includes("[disabled]=\"busy || !codexApiKey.trim() || !codexCommandAvailable()\""));
  assert.ok(onboarding.includes('id: "virtual-desktop"'));
  assert.ok(onboarding.includes("Create first thread"));
  assert.ok(onboarding.includes("Bind WhatsApp chat"));
  assert.ok(onboarding.includes("Send test message"));
  assert.ok(onboarding.includes('type SetupPageMode = "setup" | "onboarding"'));
  assert.ok(onboarding.includes("after the installer has prepared the local Orkestr runtime"));
  assert.ok(onboarding.includes('replaceState({}, "", "/setup")'));
  assert.ok(onboarding.includes("@if (isOnboardingMode())"));
  assert.ok(onboarding.includes("setupSections()"));
  assert.ok(onboarding.includes('private readonly leanSetupConnectorIds: ConnectorStep[] = ["codex", "whatsapp", "browsers"];'));
  assert.ok(onboarding.includes('retiredSetupSections = new Set(["google-marketing", "openai", "gmail", "linkedin", "mail", "outlook"])'));
  assert.ok(onboarding.includes('return ["system", "security", "codex", "whatsapp", "browsers"].includes(section)'));
  assert.ok(!onboarding.includes('{ id: "google-marketing", label: "Google Marketing", eyebrow: "SEO data" }'));
  assert.ok(onboarding.includes('type MarketingStep = "google-marketing"'));
  assert.ok(onboarding.includes("Google Marketing"));
  assert.ok(onboarding.includes("Search Console + GA Admin"));
  assert.ok(onboarding.includes("startGoogleMarketingAuth()"));
  assert.ok(onboarding.includes('globalThis.location.href = "/google-marketing/oauth/start"'));
  assert.ok(onboarding.includes("systemDoctor()"));
  assert.ok(onboarding.includes("doctorStatusClass"));
  assert.ok(onboarding.includes("Mail Auth"));
  assert.ok(onboarding.includes("Connect Gmail"));
  assert.ok(onboarding.includes("/oauth/gmail/start"));
  assert.ok(onboarding.includes("Connect ${label}"));
  assert.ok(onboarding.includes("Add another ${label} login"));
  assert.ok(onboarding.includes("already connected in this runtime"));
  assert.ok(onboarding.includes("Choose which provider to configure next"));
  assert.ok(onboarding.includes("App credentials identify your Google Cloud OAuth client"));
  assert.ok(onboarding.includes("The mailbox field is optional"));
  assert.ok(onboarding.includes("mailProviderSummary(mailProvider)"));
  assert.ok(onboarding.includes("mailProviderCredentialState"));
  assert.ok(onboarding.includes("Create a Microsoft app registration"));
  assert.ok(onboarding.includes("Connected mailboxes"));
  assert.ok(onboarding.includes("mailAccountRows()"));
  assert.ok(!onboarding.includes("Gmail Probe"));
  assert.ok(!onboarding.includes("Search query"));
  assert.ok(onboarding.includes("setupSectionChange"));
  assert.ok(onboarding.includes("@Output() paired"));
  assert.ok(onboarding.includes("this.paired.emit()"));
  assert.ok(onboarding.includes("Browser approvals"));
  assert.ok(onboarding.includes("Approve pending pairing challenges"));
  assert.ok(onboarding.includes('label: "Desktops"'));
  assert.ok(onboarding.includes("WhatsApp sender"));
  assert.ok(onboarding.includes("WhatsApp receiver"));
  assert.ok(onboarding.includes("whatsappAccountPurpose"));
  assert.ok(browsers.includes('slug: "desktop"'));
});
