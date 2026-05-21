import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeMonitorIntervalMs, startServer } from "../apps/server/src/server.js";

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

test("runtime monitor default keeps Codex reply import responsive", () => {
  const priorInterval = process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS;
  try {
    delete process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS;
    assert.equal(runtimeMonitorIntervalMs(), 5000);

    process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS = "1";
    assert.equal(runtimeMonitorIntervalMs(), 5000);

    process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS = "12000";
    assert.equal(runtimeMonitorIntervalMs(), 12000);
  } finally {
    if (priorInterval === undefined) delete process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS;
    else process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS = priorInterval;
  }
});

test("server exposes health, readiness, version, and agent message APIs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-"));
  const workspaceRoot = path.join(home, "workspace-root");
  await fs.mkdir(path.join(workspaceRoot, "alpha"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "beta"), { recursive: true });
  const priorHome = process.env.ORKESTR_HOME;
  const priorWorkspaceRoot = process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = workspaceRoot;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    const ready = await request(baseUrl, "/api/ready");
    const version = await request(baseUrl, "/api/version");
    const queued = await request(baseUrl, "/api/agents/coding-agent/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    const execution = await request(baseUrl, "/api/agents/coding-agent/run-next", {
      method: "POST",
      body: JSON.stringify({ executorId: "noop" }),
    });
    const listed = await request(baseUrl, "/api/agents/coding-agent/messages");
    const system = await request(baseUrl, "/api/system/summary");
    const doctor = await request(baseUrl, "/api/system/doctor");
    const resources = await request(baseUrl, "/api/system/resources");
    const processes = await request(baseUrl, "/api/system/processes?sort=cpu");
    const folders = await request(baseUrl, `/api/system/workspace-folders?path=${encodeURIComponent(workspaceRoot)}`);
    const browsers = await request(baseUrl, "/api/browsers");
    const browserSessions = await request(baseUrl, "/api/browser-sessions");
    const preparedBrowser = await request(baseUrl, "/api/browser-sessions/linkedin/prepare", { method: "POST" });
    const createdThread = await request(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ name: "mode-test", codexModel: "gpt-test" }),
    });
    const relativeWorkspaceThread = await request(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ name: "relative-workspace", workspace: "relative-repo", workFolder: "apps/web" }),
    });
    const mode = await request(baseUrl, `/api/threads/${createdThread.thread.id}/codex-mode`, {
      method: "POST",
      body: JSON.stringify({ mode: "plan" }),
    });
    const form = new FormData();
    form.append("files", new Blob(["hello attachment"], { type: "text/plain" }), "hello.txt");
    const uploadResponse = await fetch(`${baseUrl}/api/threads/${createdThread.thread.id}/uploads`, {
      method: "POST",
      body: form,
    });
    assert.ok(uploadResponse.ok, `/uploads returned ${uploadResponse.status}`);
    const upload = await uploadResponse.json();

    assert.equal(health.ok, true);
    assert.equal(ready.ok, true);
    assert.equal(version.name, "orkestr-oss");
    assert.equal(queued.message.state, "queued");
    assert.equal(execution.execution.state, "completed");
    assert.equal(listed.messages.length, 2);
    assert.equal(listed.messages[0].state, "completed");
    assert.equal(listed.messages[1].role, "assistant");
    assert.ok(system.cpu.count >= 1);
    assert.ok(["ok", "warning", "broken"].includes(doctor.status));
    assert.ok(doctor.checks.some((check) => check.id === "data_home"));
    assert.ok(doctor.checks.some((check) => check.id === "codex"));
    assert.ok(["ok", "warning", "broken"].includes(resources.status));
    assert.equal(typeof resources.counts.activeLeases, "number");
    assert.ok(Array.isArray(processes.processes));
    assert.equal(folders.path, workspaceRoot);
    assert.ok(folders.roots.some((root) => root.path === workspaceRoot));
    assert.deepEqual(folders.entries.map((entry) => entry.name).sort(), ["alpha", "beta"]);
    assert.ok(browsers.browsers.some((browser) => browser.slug === "linkedin"));
    assert.ok(browserSessions.sessions.length >= 3);
    assert.ok(browserSessions.sessions.some((session) => session.slug === "linkedin"));
    assert.equal(preparedBrowser.browser.slug, "linkedin");
    assert.equal(createdThread.thread.workspaceGenerated, true);
    assert.equal(createdThread.thread.workspaceSource, "local");
    assert.equal(createdThread.thread.localGitInitialized, true);
    assert.ok(String(createdThread.thread.cwd || "").startsWith(workspaceRoot));
    assert.ok(await fs.stat(path.join(createdThread.thread.repoPath, ".git")));
    assert.equal(relativeWorkspaceThread.thread.workspace, path.join(workspaceRoot, "relative-repo"));
    assert.equal(relativeWorkspaceThread.thread.repoPath, path.join(workspaceRoot, "relative-repo"));
    assert.equal(relativeWorkspaceThread.thread.cwd, path.join(workspaceRoot, "relative-repo", "apps/web"));
    assert.equal(mode.mode, "plan");
    assert.equal(typeof mode.applied, "boolean");
    assert.equal(typeof mode.queued, "boolean");
    assert.equal(mode.runtimeMode.mode, "plan");
    assert.equal(mode.thread.desiredCodexMode, null);
    assert.equal(mode.thread.codexModel, "gpt-test");
    assert.equal(upload.attachments[0].filename, "hello.txt");
    assert.equal(upload.attachments[0].mimetype, "text/plain");
    assert.ok(String(upload.attachments[0].saved_path || "").endsWith("hello.txt"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorWorkspaceRoot === undefined) delete process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
    else process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = priorWorkspaceRoot;
  }
});
