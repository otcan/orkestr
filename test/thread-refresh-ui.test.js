import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { claudeCodeStatusPayload } from "../packages/core/src/claude-code-status.js";

// Exercise the real status methods: message transport must not impersonate agent work.
async function harness() {
  const source = await fs.readFile(new URL("../apps/web/src/app/app.component.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AppComponent");
  const names = ["threadLoading", "isThreadProcessing", "threadProcessingLabel", "threadProgressStateHint", "threadProgressSummary", "statusLabel"];
  const methods = declaration.members.filter(node => names.includes(node.name?.getText(file))).map(node => node.getText(file)).join("\n");
  const compiled = ts.transpileModule(`export class Harness { ${methods} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const { Harness } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
  return Object.assign(new Harness(), {
    loadingThreadIds: () => ({ example: true }),
    messageCache: () => ({}),
    threadState: thread => thread.state || "",
    objectValue: (value, key) => value?.[key],
    isThreadLatestMessageFailed: thread => thread.latestMessageFailed === true,
  });
}

test("polling preserves ready, working, approval and error status", async () => {
  const app = await harness();
  const thread = { id: "example", state: "ready" };
  assert.equal(app.statusLabel(thread), "Ready");
  assert.equal(app.isThreadProcessing(thread), false);
  assert.equal(app.statusLabel({ ...thread, working: true }), "Working");
  assert.equal(app.statusLabel({ ...thread, turnLifecycle: { sidebarWorking: true, awaitingApproval: true } }), "Waiting for approval");
  assert.equal(app.statusLabel({ ...thread, latestMessageFailed: true }), "Error");
  assert.equal(app.statusLabel({ ...thread, progressStateHint: "error" }), "Error");
});

test("only the first fetch displays loading, even when the loaded chat is empty", async () => {
  const app = await harness();
  const thread = { id: "example" };
  assert.equal(app.threadLoading(thread), true);
  app.messageCache = () => ({ example: [] });
  assert.equal(app.threadLoading(thread), false);
  app.messageCache = () => ({ example: [{ id: "message" }] });
  assert.equal(app.threadLoading(thread), false);
  assert.equal(app.threadLoading(null), false);
});

test("Claude's idle status does not become a Working badge from an orphaned delivery row", async () => {
  const app = await harness();
  const idle = claudeCodeStatusPayload({ thread: { state: "ready" }, profileState: "ready", counts: { runningCount: 1 } });
  assert.equal(app.statusLabel({ id: "example", ...idle }), "Ready");
  assert.equal(app.isThreadProcessing(idle), false);
  const queued = claudeCodeStatusPayload({ thread: { state: "ready" }, counts: { pendingCount: 1, runningCount: 1 } });
  assert.equal(app.statusLabel({ id: "example", ...queued }), "Queued");
  const starting = claudeCodeStatusPayload({ thread: { state: "working" }, starting: true, counts: { runningCount: 1 } });
  assert.equal(app.statusLabel({ id: "example", ...starting }), "Working");
});
