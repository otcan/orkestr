import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function read(paths) {
  return (await Promise.all(paths.map((file) => fs.readFile(file, "utf8")))).join("\n");
}

test("main UI exposes a guided first thread generation flow", async () => {
  const wizardSources = await read([
    "apps/web/src/app/first-thread-wizard.component.ts",
    "apps/web/src/app/first-thread-wizard.component.html",
  ]);
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
    "apps/web/src/app/pairing-required-page.component.ts",
    "apps/web/src/app/pairing-required-page.component.html",
    "apps/web/src/app/first-thread-wizard.component.ts",
    "apps/web/src/app/first-thread-wizard.component.html",
    "apps/server/src/modules/threads/threads.controller.ts",
    "apps/server/src/modules/connectors/connectors.controller.ts",
  ]);

  assert.ok(sources.includes("New Coding Agent"));
  assert.ok(sources.includes("Create first coding agent"));
  assert.ok(sources.includes('placeholder="agent, project, thread"'));
  assert.ok(sources.includes("sidebar-new-thread"));
  assert.ok(sources.includes("(click)=\"openSetup()\""));
  assert.ok(sources.includes("[setupSection]=\"setupSection\""));
  assert.ok(sources.includes("handleSetupSectionChange"));
  assert.ok(sources.includes("Name the coding agent"));
  assert.ok(sources.includes("Use a repo or start locally"));
  assert.ok(sources.includes("Leave blank to start with a new local git repository."));
  assert.ok(sources.includes("No folder selection is needed."));
  assert.ok(sources.includes("generatedWorkspaceName"));
  assert.ok(sources.includes("autoWorkspace"));
  assert.ok(sources.includes("initGit"));
  assert.ok(sources.includes("Create Agent"));
  assert.ok(sources.includes('type WizardStepId = "name" | "repository" | "review"'));
  assert.ok(sources.includes("repoRemoteUrl"));
  assert.ok(sources.includes("cloneRepo"));
  assert.ok(sources.includes("Codex runtime required."));
  assert.ok(sources.includes("Open Codex setup"));
  assert.ok(sources.includes("setupRequested"));
  assert.ok(sources.includes("[setupStatus]=\"setupStatus\""));
  assert.ok(sources.includes("this.api.createThread"));
  assert.ok(sources.includes("wake: true"));
  assert.ok(sources.includes("requestThreadWake(thread.id"));
  assert.ok(sources.includes('Post("codex/api-key")'));
  assert.ok(sources.includes("git\", [\"clone\""));
  assert.ok(sources.includes("git\", [\"init\""));
  assert.ok(sources.includes("clone_target_not_empty"));
  assert.ok(!wizardSources.includes("Existing codebase"));
  assert.ok(!wizardSources.includes("Start inside subfolder"));
  assert.ok(!wizardSources.includes("Browse"));
  assert.ok(sources.includes("<ork-first-thread-wizard"));
  assert.ok(sources.includes("@if (pairingRequired)"));
  assert.ok(sources.includes("<ork-pairing-required-page"));
  assert.ok(sources.includes("Pairing Required"));
  assert.ok(sources.includes("ssh root@"));
  assert.ok(sources.includes("orkestr security approve"));
  assert.ok(sources.includes("browser_pairing_required"));
  assert.ok(sources.includes("enterPairingRequired"));
  assert.ok(sources.includes("(paired)=\"handleBrowserPaired()\""));
  assert.ok(sources.includes("Connect sender"));
  assert.ok(sources.includes("Connect Orkestr account"));
  assert.ok(sources.includes("connectedWhatsAppAccounts()"));
  assert.ok(sources.includes("redirectThreadSettingsToWhatsAppSetupIfNeeded"));
  assert.ok(sources.includes('this.openSetup("whatsapp", true)'));
  assert.ok(sources.includes("Connect WhatsApp in setup"));
  assert.ok(sources.includes("Create and connect chat"));
  assert.ok(sources.includes("Existing chats are not selected here."));
  assert.ok(sources.includes("Linked sender account"));
  assert.ok(sources.includes("Additional participants are off."));
  assert.ok(sources.includes("Allow messages from additional chat participants"));
  assert.ok(sources.includes("Allowed participants"));
  assert.ok(sources.includes("No extra participants are available."));
  assert.ok(!sources.includes("Allowed sender"));
  assert.ok(sources.includes("Detach chat"));
  assert.ok(sources.includes("Delete thread"));
  assert.ok(sources.includes("this.api.deleteThread"));
  assert.ok(!sources.includes("What should the agent do?"));
  assert.ok(!sources.includes("How should it run?"));
  assert.ok(!sources.includes(`(click)="openPanel('attach')">Attach</button>`));
  assert.ok(!sources.includes(`(click)="openPanel('runtime')">Runtime</button>`));
  assert.ok(!sources.includes(`<button class="secondary" type="button" [class.active]="activePanel === 'raw'" (click)="openPanel('raw')">Raw</button>`));
  assert.ok(!wizardSources.includes("this.api.sendThreadInput"));
  assert.ok(!wizardSources.includes("this.api.wakeThread"));
});

test("web thread input allows Orkestr control commands", async () => {
  const apiSource = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const sendThreadInput = apiSource.slice(apiSource.indexOf("sendThreadInput("), apiSource.indexOf("wakeThread("));

  assert.ok(sendThreadInput.includes("parseCommands: true"));
  assert.ok(sendThreadInput.includes("controlAllowed: true"));
});

test("chat messages show delivery failure reasons", async () => {
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
    "apps/web/src/styles.css",
  ]);

  assert.ok(sources.includes("messageFailureDetail(message)"));
  assert.ok(sources.includes("Not delivered"));
  assert.ok(sources.includes("Delivery failed"));
  assert.ok(sources.includes(".message-failure"));
});

test("sidebar marks latest delivery failures as errors", async () => {
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
    "apps/web/src/styles.css",
    "apps/server/src/thread-summary.ts",
  ]);

  assert.ok(sources.includes("lastMessageDeliveryState"));
  assert.ok(sources.includes("lastMessageError"));
  assert.ok(sources.includes("isThreadLatestMessageFailed(thread, true)"));
  assert.ok(sources.includes("ERROR"));
  assert.ok(sources.includes(".error-badge"));
  assert.ok(sources.includes(".thread-item.error"));
});

test("git direct sync badge runs sync directly when safe", async () => {
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
  ]);

  assert.ok(sources.includes("handleGitBadgeAction(thread"));
  assert.ok(sources.includes("handleGitBadgeAction(worker"));
  assert.ok(sources.includes("this.canDirectSyncThread(thread)"));
  assert.ok(sources.includes("void this.directSyncThread(thread)"));
  assert.ok(sources.includes("this.openGitDetails(thread)"));
});
