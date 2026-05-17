import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function read(paths) {
  return (await Promise.all(paths.map((file) => fs.readFile(file, "utf8")))).join("\n");
}

test("main UI exposes a guided first thread generation flow", async () => {
  const sources = await read([
    "apps/web/src/app/app.component.ts",
    "apps/web/src/app/app.component.html",
    "apps/web/src/app/first-thread-wizard.component.ts",
    "apps/web/src/app/first-thread-wizard.component.html",
  ]);

  assert.ok(sources.includes("New Coding Agent"));
  assert.ok(sources.includes("Create first coding agent"));
  assert.ok(sources.includes("Create and Start"));
  assert.ok(sources.includes('type WizardStepId = "task" | "workspace" | "runtime" | "review"'));
  assert.ok(sources.includes("Review this repo"));
  assert.ok(sources.includes("Fix a failing test"));
  assert.ok(sources.includes("Improve README"));
  assert.ok(sources.includes("Build a small feature"));
  assert.ok(sources.includes('workspace = "/workspace"'));
  assert.ok(sources.includes("this.api.createThread"));
  assert.ok(sources.includes("this.api.sendThreadInput"));
  assert.ok(sources.includes("this.api.wakeThread"));
  assert.ok(sources.includes("<ork-first-thread-wizard"));
});
