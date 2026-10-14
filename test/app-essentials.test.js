import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { listThreads } from "../packages/core/src/threads.js";
import { recordWatcherAlert } from "../packages/core/src/watcher-alerts.js";
import { fileBrowserRootsForPrincipal } from "../packages/core/src/workspace-files.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

async function tempHome(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("the thread API refuses the no-op and simulated executors outside the test runner", async () => {
  const keys = ["ORKESTR_HOME", "ORKESTR_ALLOW_TEST_EXECUTORS", "ORKESTR_RECOVER_RUNNING_ON_START"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = await tempHome("orkestr-no-fake-executor-");
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  delete process.env.ORKESTR_ALLOW_TEST_EXECUTORS;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const executorId of ["noop", "simulated"]) {
      const response = await fetch(`${base}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `fake-${executorId}`, executorId }) });
      assert.equal(response.status, 400, executorId);
      assert.equal((await response.json()).error, "executor_not_available");
    }
    assert.deepEqual((await listThreads(process.env)).map((thread) => thread.name), [], "no fake conversation was created");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("alerts do not create a watcher conversation unless asked to", async () => {
  const env = { ORKESTR_HOME: await tempHome("orkestr-watcher-optin-") };
  const recorded = await recordWatcherAlert({ source: "test", code: "synthetic_one", message: "synthetic alert" }, env);
  assert.equal(recorded.alert.watcherThreadId, null);
  assert.deepEqual(await listThreads(env), []);
  const optedIn = { ...env, ORKESTR_WATCHER_AUTO_CREATE: "1" };
  const second = await recordWatcherAlert({ source: "test", code: "synthetic_two", message: "synthetic alert two" }, optedIn);
  assert.ok(second.alert.watcherThreadId, "an operator can still opt in");
});

test("Files offers Shared files and Agent workspaces, and opens on the workspaces", async () => {
  const env = { ORKESTR_HOME: await tempHome("orkestr-files-roots-") };
  const roots = await fileBrowserRootsForPrincipal(adminPrincipal(), env);
  assert.deepEqual(roots.map((root) => root.name), ["Shared files", "Agent workspaces"]);
  for (const root of roots) assert.ok((await fs.stat(root.path)).isDirectory());
  const page = await fs.readFile("apps/web/src/app/files-page.component.ts", "utf8");
  assert.match(page, /openDefaultMount/);
  const template = await fs.readFile("apps/web/src/app/files-page.component.html", "utf8");
  assert.doesNotMatch(template, /instance scoped|No files here\./);
});

test("shell: agent gate, login-aware Log out, Vault sign-in notice, no Copy link or Connections", async () => {
  const [html, ts, vaultHtml, vaultTs] = await Promise.all([
    fs.readFile("apps/web/src/app/app.component.html", "utf8"),
    fs.readFile("apps/web/src/app/app.component.ts", "utf8"),
    fs.readFile("apps/web/src/app/vault-page.component.html", "utf8"),
    fs.readFile("apps/web/src/app/vault-page.component.ts", "utf8"),
  ]);
  assert.match(html, /\} @else if \(runtimeGateActive\(\)\) \{[\s\S]*\[canCancel\]="false"[\s\S]*No coding agent connected yet[\s\S]*\} @else if \(appReady\) \{/);
  assert.match(ts, /return this\.codexAgentReady\(\) \|\| this\.claudeRuntimeReady;/);
  assert.match(ts, /return this\.setupStatus\?\.security\?\.authEnabled === true;/);
  assert.match(html, /@if \(loginEnabled\(\)\) \{[\s\S]*Log out[\s\S]*No sign-in on this install/);
  assert.doesNotMatch(html, /Copy link|>Connections<\/button>/);
  assert.match(vaultTs, /vault_owner_session_required"\) \{\s*this\.ownerSessionMissing = true;/);
  assert.match(vaultHtml, /The vault needs sign-in\./);
});

test("orkestr demo is gone", () => {
  const result = spawnSync(process.execPath, ["apps/cli/bin/orkestr-oss.js", "demo", "--yes"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Unknown command: demo/);
});
