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
  assert.ok(!sources.includes("What should the agent do?"));
  assert.ok(!sources.includes("How should it run?"));
  assert.ok(!wizardSources.includes("this.api.sendThreadInput"));
});
