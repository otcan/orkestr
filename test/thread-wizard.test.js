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
  assert.ok(sources.includes("Codex Agent required."));
  assert.ok(sources.includes("codex-required-shell"));
  assert.ok(sources.includes("Orkestr is locked until the Codex Agent runtime is connected."));
  assert.ok(sources.includes("Connect Codex Agent before creating, opening, or inspecting workspaces."));
  assert.ok(sources.includes("Connect Codex Agent"));
  assert.ok(sources.includes("setupRequested"));
  assert.ok(sources.includes("[setupStatus]=\"setupStatus\""));
  assert.ok(!sources.includes("Workspace browsing stays available"));
  assert.ok(!sources.includes("You can create and inspect the workspace now"));
  assert.ok(!sources.includes("Workspace created. Connect Codex Agent before sending tasks."));
  assert.ok(sources.includes("guardCodexRuntime"));
  assert.ok(sources.includes("this.api.createThread"));
  assert.ok(sources.includes("wake: shouldWake"));
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

test("web thread input renders optimistic user messages before server refresh", async () => {
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/api.service.ts",
    "apps/web/src/app/optimistic-thread-messages.ts",
  ]);
  const sendMessage = sources.slice(sources.indexOf("async sendMessage()"), sources.indexOf("async sendMessageNow()"));

  assert.ok(sources.includes("export interface ThreadInputResponse"));
  assert.ok(sources.includes("createOptimisticUserMessage"));
  assert.ok(sources.includes("replaceOptimisticThreadMessage"));
  assert.ok(sources.includes("failOptimisticThreadMessage"));
  assert.ok(sources.includes("mergeServerMessagesWithOptimistic"));
  assert.ok(sources.includes("clearSubmittedComposer(thread)"));
  assert.ok(sources.includes("const pendingFiles = [...this.pendingFiles]"));
  assert.ok(sendMessage.indexOf("appendOptimisticUserMessage") < sendMessage.indexOf("uploadPendingFiles"));
  assert.ok(sendMessage.indexOf("clearSubmittedComposer(thread)") < sendMessage.indexOf("uploadPendingFiles"));
  assert.ok(sendMessage.indexOf("appendOptimisticUserMessage") < sendMessage.indexOf("firstValueFrom(this.api.sendThreadInput"));
  assert.ok(sendMessage.includes("response.message"));
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

test("web UI exposes browser terminal attach for app-server threads", async () => {
  const webSources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
    "apps/web/src/app/api.service.ts",
    "apps/web/src/styles.css",
  ]);
  const serverSources = await read([
    "apps/server/src/modules/threads/threads.controller.ts",
    "apps/server/src/thread-stream.ts",
  ]);
  const sources = `${webSources}\n${serverSources}`;

  assert.ok(sources.includes("embeddedRawTerminalAvailable"));
  assert.ok(!webSources.includes("nativeTerminalAttachAvailable"));
  assert.ok(sources.includes("ensureAppServerAttachPane"));
  assert.ok(sources.includes("browserAttachSessionName"));
  assert.ok(sources.includes("codex-browser-attach"));
  assert.ok(serverSources.includes("RAW_ESCAPE_KEY_MAP"));
  assert.ok(serverSources.includes("\"\\x1b[A\": \"Up\""));
  assert.ok(serverSources.includes("\"\\x1b[B\": \"Down\""));
  assert.ok(serverSources.includes("readRawEscapeSequence"));
  assert.ok(serverSources.includes("rawEscapeSequenceKey(sequence)"));
  assert.ok(!webSources.includes("Open Browser Terminal"));
  assert.ok(!webSources.includes("raw-toolbar"));
  assert.ok(webSources.includes("raw-terminal-host"));
  assert.ok(!webSources.includes("openThreadTerminal"));
  assert.ok(!webSources.includes("openNativeTerminal"));
  assert.ok(!webSources.includes("attach/open-terminal"));
  assert.ok(!webSources.includes("Host Terminal"));
});

test("thread links do not persist the raw panel", async () => {
  const source = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const activateThread = source.slice(source.indexOf("async activateThread("), source.indexOf("private clearThreadPanelState("));
  const threadUrl = source.slice(source.indexOf("threadUrl("), source.indexOf("rawUrl("));

  assert.ok(activateThread.includes('const nextPanel = "chat"'));
  assert.ok(!activateThread.includes('this.activePanel === "raw" ? "raw" : "chat"'));
  assert.ok(threadUrl.includes('this.pathForPanel(this.threadSlug(thread), "chat")'));
  assert.ok(!threadUrl.includes('this.activePanel === "raw" ? "raw" : "chat"'));
});

test("thread management panel scaffold includes template and styles", async () => {
  const sources = await read([
    "apps/web/src/app/thread-management-panel.component.ts",
    "apps/web/src/app/thread-management-panel.component.html",
    "apps/web/src/app/thread-management-panel.component.css",
  ]);

  assert.ok(sources.includes('selector: "ork-thread-management-panel"'));
  assert.ok(sources.includes('templateUrl: "./thread-management-panel.component.html"'));
  assert.ok(sources.includes('styleUrls: ["./thread-management-panel.component.css"]'));
  assert.ok(sources.includes("New worker"));
  assert.ok(sources.includes("Manage timers"));
  assert.ok(sources.includes(".thread-management-panel"));
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
