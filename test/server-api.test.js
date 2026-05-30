import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverAfterStartup, runtimeMonitorIntervalMs, startServer, startupRecoveryDelayMs } from "../apps/server/src/server.js";

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  assert.ok(response.ok, `${route} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function createFakeCodexAppServer(home) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  const codexPath = path.join(bin, "codex");
  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli fake");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using API key");
  process.exit(0);
}
if (args[0] === "app-server" && args.includes("--help")) {
  console.log("Usage: codex app-server [OPTIONS]");
  process.exit(0);
}
if (args[0] !== "app-server") {
  console.log("codex fake");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
let nextThread = 1;
let nextTurn = 1;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  const method = message.method;
  const params = message.params || {};
  if (method === "initialize") return send({ id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
  if (method === "initialized") return;
  if (method === "thread/start") {
    const thread = { id: "codex-fake-" + nextThread++, sessionId: "codex-session-1", name: "", status: { type: "idle" }, cwd: params.cwd || "" };
    send({ id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (method === "thread/name/set") return send({ id, result: {} });
  if (method === "thread/resume") return send({ id, result: { thread: { id: params.threadId, sessionId: params.threadId, status: { type: "idle" } } } });
  if (method === "thread/unsubscribe") return send({ id, result: { status: "unsubscribed" } });
  if (method === "thread/archive") return send({ id, result: {} });
  if (method === "thread/compact/start") return send({ id, result: {} });
  if (method === "thread/rollback") return send({ id, result: { thread: { id: params.threadId, turns: [] } } });
  if (method === "thread/list") return send({ id, result: { data: [], nextCursor: null } });
  if (method === "thread/read") return send({ id, result: { thread: { id: params.threadId, sessionId: params.threadId, name: "Imported", turns: [] } } });
  if (method === "turn/start") {
    const turn = { id: "turn-" + nextTurn++, threadId: params.threadId, status: "inProgress", items: [], error: null };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "agent-" + turn.id, text: "Fake Codex reply", phase: "final_answer" } } });
    send({ method: "turn/completed", params: { turn: { ...turn, status: "completed" } } });
    return;
  }
  if (method === "turn/interrupt") return send({ id, result: {} });
  send({ id, result: {} });
});
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);
  return bin;
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

test("startup recovery delay is enabled by default and bounded", () => {
  const priorDelay = process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS;
  try {
    delete process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS;
    assert.equal(startupRecoveryDelayMs(), 1000);

    process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS = "-5";
    assert.equal(startupRecoveryDelayMs(), 0);

    process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS = "2500";
    assert.equal(startupRecoveryDelayMs(), 2500);
  } finally {
    if (priorDelay === undefined) delete process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS;
    else process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS = priorDelay;
  }
});

test("startup recovery defers while a no-interrupt deploy drain is active", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-startup-drain-"));
  await fs.writeFile(path.join(home, "deploy-drain.json"), JSON.stringify({
    state: "draining",
    reason: "deploy",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));

  const result = await recoverAfterStartup({ ...process.env, ORKESTR_HOME: home });
  assert.deepEqual(result, { deferred: true, reason: "deploy_draining" });
});

test("server exposes health, readiness, version, and agent message APIs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-"));
  const workspaceRoot = path.join(home, "workspace-root");
  await fs.mkdir(path.join(workspaceRoot, "alpha"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "beta"), { recursive: true });
  const priorHome = process.env.ORKESTR_HOME;
  const priorWorkspaceRoot = process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
  const priorCodexBin = process.env.ORKESTR_CODEX_BIN;
  const priorRuntimeCodexCommand = process.env.ORKESTR_RUNTIME_CODEX_COMMAND;
  const priorPath = process.env.PATH;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = workspaceRoot;
  const fakeCodexBin = await createFakeCodexAppServer(home);
  process.env.ORKESTR_CODEX_BIN = path.join(fakeCodexBin, "codex");
  delete process.env.ORKESTR_RUNTIME_CODEX_COMMAND;
  process.env.PATH = `${fakeCodexBin}${path.delimiter}${priorPath || ""}`;
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
    const createdThreadDetail = await request(baseUrl, `/api/threads/${createdThread.thread.id}`);
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
    assert.ok(createdThread.thread.executor.codexThreadId);
    assert.equal(createdThreadDetail.thread.executor.codexThreadId, createdThread.thread.executor.codexThreadId);
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
    if (priorCodexBin === undefined) delete process.env.ORKESTR_CODEX_BIN;
    else process.env.ORKESTR_CODEX_BIN = priorCodexBin;
    if (priorRuntimeCodexCommand === undefined) delete process.env.ORKESTR_RUNTIME_CODEX_COMMAND;
    else process.env.ORKESTR_RUNTIME_CODEX_COMMAND = priorRuntimeCodexCommand;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
});
