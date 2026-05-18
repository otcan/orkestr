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
    "apps/web/src/app/first-thread-wizard.component.ts",
    "apps/web/src/app/first-thread-wizard.component.html",
    "apps/server/src/modules/threads/threads.controller.ts",
  ]);

  assert.ok(sources.includes("New Coding Agent"));
  assert.ok(sources.includes("Create first coding agent"));
  assert.ok(sources.includes('placeholder="agent, project, thread"'));
  assert.ok(sources.includes("sidebar-new-thread"));
  assert.ok(sources.includes("(click)=\"openSetup()\""));
  assert.ok(sources.includes("[setupSection]=\"setupSection\""));
  assert.ok(sources.includes("handleSetupSectionChange"));
  assert.ok(sources.includes("Name the coding agent"));
  assert.ok(sources.includes("Select a workspace or clone a repo"));
  assert.ok(sources.includes("Use workspace"));
  assert.ok(sources.includes("Clone repo"));
  assert.ok(sources.includes("Create Agent"));
  assert.ok(sources.includes('type WizardStepId = "name" | "workspace" | "review"'));
  assert.ok(sources.includes("repoRemoteUrl"));
  assert.ok(sources.includes("cloneRepo"));
  assert.ok(sources.includes("this.api.createThread"));
  assert.ok(sources.includes("this.api.wakeThread"));
  assert.ok(sources.includes("git\", [\"clone\""));
  assert.ok(sources.includes("clone_target_not_empty"));
  assert.ok(sources.includes("<ork-first-thread-wizard"));
  assert.ok(sources.includes("Connect sender"));
  assert.ok(sources.includes("Connect Orkestr account"));
  assert.ok(sources.includes("Create and connect chat"));
  assert.ok(sources.includes("Existing chats are not selected here."));
  assert.ok(sources.includes("Detach chat"));
  assert.ok(sources.includes("Delete thread"));
  assert.ok(sources.includes("this.api.deleteThread"));
  assert.ok(!sources.includes("What should the agent do?"));
  assert.ok(!sources.includes("How should it run?"));
  assert.ok(!sources.includes(`(click)="openPanel('attach')">Attach</button>`));
  assert.ok(!sources.includes(`(click)="openPanel('runtime')">Runtime</button>`));
  assert.ok(!sources.includes(`<button class="secondary" type="button" [class.active]="activePanel === 'raw'" (click)="openPanel('raw')">Raw</button>`));
  assert.ok(!wizardSources.includes("this.api.sendThreadInput"));
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
