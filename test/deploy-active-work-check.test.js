import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deployDrainActiveSync, deployDrainPath } from "../packages/core/src/deploy-drain.js";
import {
  checkActiveWork,
  formatActiveThreads,
  summarizeActiveThreads,
  summarizeActiveThreadsWithOptions,
  threadRestartSafe,
} from "../scripts/deploy-active-work-check.mjs";

test("deploy active-work checker treats live and queued thread work as active", () => {
  const active = summarizeActiveThreads({
    threads: [
      { id: "idle", name: "Idle", state: "ready", pendingCount: 0 },
      { id: "working", name: "Working", state: "working", runtimeKind: "codex-app-server", codexAppServerTransport: "proxy" },
      { id: "queued", name: "Queued", state: "ready", pendingCount: 1 },
      { id: "typing", name: "Typing", typingActive: true },
      { id: "answered", name: "Answered", state: "answer", runningCount: 0 },
    ],
  });

  assert.deepEqual(active.map((thread) => thread.id), ["working", "queued", "typing"]);
  assert.equal(active[0].runtimeKind, "codex-app-server");
  assert.equal(active[0].codexAppServerTransport, "proxy");
  assert.match(formatActiveThreads({ active }), /Working state=working/);
  assert.match(formatActiveThreads({ active }), /runtime=codex-app-server/);
  assert.match(formatActiveThreads({ active }), /appServer=proxy/);
  assert.match(formatActiveThreads({ active }), /Queued state=ready pending=1/);
});

test("deploy active-work checker can ignore the invoking tmux pane only", () => {
  const active = summarizeActiveThreadsWithOptions({
    threads: [
      {
        id: "release-train",
        name: "Release train",
        state: "working",
        runtimeKind: "raw-terminal",
        sessionName: "orkestr-thread-release",
        paneId: "%7",
      },
      {
        id: "other-work",
        name: "Other work",
        state: "working",
        runtimeKind: "raw-terminal",
        sessionName: "orkestr-thread-other",
        paneId: "%8",
      },
    ],
  }, {
    env: { ORKESTR_DEPLOY_IGNORE_PANE_IDS: "%7" },
  });

  assert.deepEqual(active.map((thread) => thread.id), ["other-work"]);
  assert.match(formatActiveThreads({ active }), /Other work state=working runtime=raw-terminal session=orkestr-thread-other pane=%8/);
});

test("deploy active-work checker authenticates with stored CLI token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deploy-active-auth-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(
    path.join(home, "secrets", "cli-auth.json"),
    JSON.stringify({ token: "deploy-check-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    "utf8",
  );

  let authorization = "";
  const server = http.createServer((request, response) => {
    authorization = String(request.headers.authorization || "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ threads: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const report = await checkActiveWork(`http://127.0.0.1:${port}/api/threads?scope=all`, {
      env: { ORKESTR_HOME: home },
    });
    assert.equal(report.ok, true);
    assert.equal(authorization, "Bearer deploy-check-token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("deploy drain marker expires instead of permanently pausing delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deploy-drain-"));
  const env = { ORKESTR_HOME: home };
  assert.equal(deployDrainPath(env), path.join(home, "deploy-drain.json"));
  await fs.writeFile(deployDrainPath(env), JSON.stringify({ state: "draining", expiresAt: new Date(Date.now() + 60_000).toISOString() }), "utf8");
  assert.equal(deployDrainActiveSync(env), true);
  await fs.writeFile(deployDrainPath(env), JSON.stringify({ state: "draining", expiresAt: new Date(Date.now() - 60_000).toISOString() }), "utf8");
  assert.equal(deployDrainActiveSync(env), false);
});

test("detached Claude Code turns are restart-safe while piped Claude turns are not", () => {
  const detached = { id: "c1", state: "working", activeTurnId: "t1", runtimeKind: "claude-code", runtime: { runtimeKind: "claude-code", claudeTransport: "detached" } };
  const piped = { id: "c2", state: "working", activeTurnId: "t2", runtimeKind: "claude-code", runtime: { runtimeKind: "claude-code", claudeTransport: "pipe" } };
  const legacy = { id: "c3", state: "working", activeTurnId: "t3", runtimeKind: "claude-code" };
  const codex = { id: "x1", state: "working", activeTurnId: "t4", runtimeKind: "codex-app-server", appServerTransport: "websocket" };
  assert.equal(threadRestartSafe(detached), true);
  assert.equal(threadRestartSafe(piped), false);
  assert.equal(threadRestartSafe(legacy), false);
  assert.equal(threadRestartSafe(codex), true);
  const active = summarizeActiveThreads({ threads: [detached, piped, legacy, codex] });
  assert.deepEqual(active.map((thread) => [thread.id, thread.restartSafe]), [["c1", true], ["c2", false], ["c3", false], ["x1", true]]);
  assert.equal(active[0].claudeTransport, "detached");
  assert.match(formatActiveThreads({ active }), /c1 .*claude=detached restart-safe/);
});

test("the deployer's unsafe count honours restartSafe from the active work report", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = await fs.readFile(path.join(process.cwd(), "scripts/deploy-git-release.sh"), "utf8");
  const body = script.slice(script.indexOf("active_thread_unsafe_count() {"), script.indexOf("active_report_unavailable() {"));
  const report = JSON.stringify({ active: [
    { id: "c1", runtimeKind: "claude-code", restartSafe: true },
    { id: "c2", runtimeKind: "claude-code", restartSafe: false },
    { id: "x1", runtimeKind: "codex-app-server", codexAppServerTransport: "proxy" },
  ] });
  const count = execFileSync("bash", ["-c", `${body}\nactive_thread_unsafe_count "$1"`, "bash", report], { encoding: "utf8" });
  assert.equal(count, "1");
});
