import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { approvePairingChallenge, createPairingChallenge, getPairingChallenge, pairBrowser } from "../packages/core/src/security.js";

function capture() {
  let text = "";
  return {
    write(value) {
      text += String(value);
    },
    text() {
      return text;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(routes, seen = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const method = String(options.method || "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    seen.push({ key, search: parsed.search, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[key];
    if (!route) return jsonResponse({ error: `missing route: ${key}` }, 404);
    return jsonResponse(typeof route === "function" ? route(seen.at(-1)) : route);
  };
}

test("CLI lists threads from the public API", async () => {
  const stdout = capture();
  const code = await runCli(["--api", "http://orkestr.test", "list"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": {
        threads: [{ id: "thread-1", name: "Demo", state: "ready", runtime: { sessionName: "orkestr-demo" } }],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Demo/);
  assert.match(stdout.text(), /ready/);
  assert.match(stdout.text(), /thread-1/);
});

test("CLI whereiam sends the current directory to the public API", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["whereiam", "--cwd", cwd], {
    cwd,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        workspace: { cwd, runtimeWorkspace: "/workspace/demo", repoPath: "/repo/demo" },
        runtime: { sessionName: "orkestr-demo", paneId: "%42" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].search, `?cwd=${encodeURIComponent(cwd)}`);
  assert.match(stdout.text(), /Thread: Demo \(thread-1\)/);
  assert.match(stdout.text(), /Repo: \/repo\/demo/);
});

test("CLI version prints the active build identity", async () => {
  const stdout = capture();
  const code = await runCli(["version"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/version": {
        name: "orkestr-oss",
        version: "0.1.0-alpha.12",
        commit: "6fc115b123456789",
        branch: "main",
        describe: "main-6fc115b",
        channel: "main",
        releaseId: "main-6fc115b",
        dirty: false,
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /orkestr-oss 0\.1\.0-alpha\.12/);
  assert.match(stdout.text(), /Release: main-6fc115b/);
  assert.match(stdout.text(), /Commit: 6fc115b12345/);
});

test("CLI API failures are reported without an uncaught stack", async () => {
  const stderr = capture();
  const code = await runCli(["version"], {
    stdout: capture(),
    stderr,
    fetchImpl: async () => {
      throw new Error("api down");
    },
  });

  assert.equal(code, 1);
  assert.equal(stderr.text(), "api down\n");
});

test("CLI status summarizes version, setup, security, connectors, and doctor", async () => {
  const stdout = capture();
  const code = await runCli(["--api", "http://orkestr.test", "status"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/version": {
        name: "orkestr-oss",
        version: "0.1.0-alpha.12",
        commit: "6fc115b123456789",
        channel: "main",
        releaseId: "main-6fc115b",
        dirty: false,
      },
      "GET /api/setup/status": {
        setupState: "partial",
        security: { paired: true, remoteReady: true, pendingChallengeCount: 0 },
        connectors: [
          { id: "codex", state: "connected" },
          { id: "whatsapp", state: "partial" },
        ],
      },
      "GET /api/system/doctor": {
        ok: true,
        status: "ok",
        summary: "All system checks passed.",
        counts: { ok: 3, warnings: 0, errors: 0 },
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Orkestr: ok/);
  assert.match(stdout.text(), /URL: http:\/\/orkestr\.test/);
  assert.match(stdout.text(), /Setup: partial/);
  assert.match(stdout.text(), /Security: paired=yes remote=ready pending=0/);
  assert.match(stdout.text(), /codex:connected whatsapp:partial/);
});

test("CLI prints non-secret runtime settings from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-settings-"));
  const stdout = capture();
  const env = { ORKESTR_HOME: home };
  await writeRuntimeSettings({ desktops: { gmailAuth: "gmail" } }, env);

  const code = await runCli(["settings", "--json"], {
    env,
    stdout,
    stderr: capture(),
  });
  const payload = JSON.parse(stdout.text());

  assert.equal(code, 0);
  assert.equal(payload.settings.profile, undefined);
  assert.equal(payload.settings.desktops.gmailAuth, "gmail");
  assert.equal(payload.settings.codex.permissionPrompts.alwaysApprove.requiresExplicitScope, true);
});

test("CLI lists timers from the public API", async () => {
  const stdout = capture();
  const code = await runCli(["timers"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers": {
        timers: [{ id: "timer-1", label: "Daily", target: "thread-1", cadence: "daily", nextRunAt: "2026-05-15T09:00:00.000Z" }],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Daily/);
  assert.match(stdout.text(), /thread-1/);
});

test("CLI doctors timers through the public API", async () => {
  const stdout = capture();
  const code = await runCli(["doctor", "timers"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers/doctor": {
        ok: true,
        status: "ok",
        summary: "1 timer checked.",
        storeExists: true,
        counts: { total: 1, enabled: 1, disabled: 0, due: 0, errors: 0, warnings: 0 },
        issues: [],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Timers: ok/);
  assert.match(stdout.text(), /1 timer checked/);
});

test("CLI doctors the host system by default", async () => {
  const stdout = capture();
  const code = await runCli(["doctor"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/system/doctor": {
        ok: true,
        status: "ok",
        summary: "All system checks passed.",
        counts: { total: 2, ok: 2, warnings: 0, errors: 0 },
        issues: [],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /System: ok/);
  assert.match(stdout.text(), /All system checks passed/);
});

test("CLI repairs runtime resources through the public API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["doctor", "resources", "--repair"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/system/resources/repair": {
        ok: true,
        status: "ok",
        summary: "Repaired 1 runtime resource issue(s).",
        counts: { activeLeases: 0, tmuxSessions: 1, orphanSessions: 1, tempCodexProcesses: 0, issues: 0, repaired: 1 },
        issues: [],
        actions: [{ action: "killed_tmux_session", sessionName: "orkestr-mode-test" }],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/system/resources/repair");
  assert.match(stdout.text(), /Runtime resources: ok/);
  assert.match(stdout.text(), /killed_tmux_session/);
});

test("CLI timer doctor exits nonzero for broken timers", async () => {
  const stdout = capture();
  const code = await runCli(["timers", "doctor"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers/doctor": {
        ok: false,
        status: "broken",
        summary: "1 timer problem needs attention.",
        storeExists: true,
        counts: { total: 1, enabled: 1, disabled: 0, due: 1, errors: 1, warnings: 0 },
        issues: [{ severity: "error", code: "missing_thread_target", timerLabel: "Broken", message: "Timer targets a thread that does not exist." }],
      },
    }),
  });

  assert.equal(code, 1);
  assert.match(stdout.text(), /Timers: broken/);
  assert.match(stdout.text(), /missing_thread_target/);
});

test("CLI lists and approves browser pairing challenges from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-security-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env });
  const listOut = capture();
  const approveOut = capture();

  const listCode = await runCli(["security", "challenges", "--json"], {
    env,
    stdout: listOut,
    stderr: capture(),
  });
  assert.equal(listCode, 0);
  assert.match(listOut.text(), new RegExp(challenge.challengeId));
  assert.match(listOut.text(), /pending/);

  const approveCode = await runCli(["security", "approve", challenge.challengeId], {
    env,
    stdout: approveOut,
    stderr: capture(),
  });
  assert.equal(approveCode, 0);
  assert.match(approveOut.text(), /Approved pairing challenge/);
  assert.equal((await getPairingChallenge(challenge.challengeId, { env })).status, "approved");
});

test("CLI lists and revokes browser pairing sessions from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-security-sessions-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env });
  await approvePairingChallenge(challenge.challengeId, { env });
  const paired = await pairBrowser({ challengeId: challenge.challengeId, userAgent: "node:test", env });

  const listOut = capture();
  const listCode = await runCli(["security", "sessions", "--json"], {
    env,
    stdout: listOut,
    stderr: capture(),
  });
  const sessionsPayload = JSON.parse(listOut.text());
  assert.equal(listCode, 0);
  assert.equal(sessionsPayload.sessions[0].id, paired.session.id);
  assert.equal(sessionsPayload.sessions[0].tokenHash, undefined);

  const revokeOut = capture();
  const revokeCode = await runCli(["security", "revoke", paired.session.id], {
    env,
    stdout: revokeOut,
    stderr: capture(),
  });
  assert.equal(revokeCode, 0);
  assert.match(revokeOut.text(), /Revoked 1 browser session/);

  const emptyOut = capture();
  await runCli(["security", "sessions", "--json"], {
    env,
    stdout: emptyOut,
    stderr: capture(),
  });
  assert.deepEqual(JSON.parse(emptyOut.text()).sessions, []);
});

test("CLI sends input with Orkestr command parsing enabled", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["send", "Demo", "/now", "ship", "it"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/input": { ok: true, queued: true, orkestrThreadId: "thread-1" },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].body.text, "/now ship it");
  assert.equal(seen[0].body.parseCommands, true);
  assert.equal(seen[0].body.controlAllowed, true);
  assert.match(stdout.text(), /Queued thread-1/);
});

test("CLI creates threads through the public API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["thread", "create", "Demo Thread", "--id", "demo-thread", "--cwd", "/repo", "--command", "codex", "--executor", "codex"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads": { thread: { id: "demo-thread", name: "Demo Thread" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, {
    name: "Demo Thread",
    id: "demo-thread",
    cwd: "/repo",
    command: "codex",
    executorId: "codex",
  });
  assert.match(stdout.text(), /Created Demo Thread/);
});

test("CLI creates worker threads with task metadata", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["worker", "create", "Parent", "--task", "Build this", "--label", "Worker A", "--repo", "/repo", "--branch", "orkestr/parent/worker-a"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Parent/workers": { worker: { id: "worker-1", bindingName: "Parent-Worker-A" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, {
    task: "Build this",
    label: "Worker A",
    repoPath: "/repo",
    branchName: "orkestr/parent/worker-a",
  });
  assert.match(stdout.text(), /Created Parent-Worker-A/);
});

test("CLI creates blank workers and can disable wake", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["worker", "create", "Parent", "--blank", "--no-wake", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Parent/workers": { worker: { id: "worker-blank", bindingName: "Parent-Worker-Blank" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, { autoRun: false, wake: false });
  assert.match(stdout.text(), /"id": "worker-blank"/);
});

test("CLI reports inputs waiting for runtime acknowledgement", async () => {
  const stdout = capture();
  const code = await runCli(["send", "Demo", "ship", "it"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/input": { ok: true, queued: true, deliveryState: "awaiting_ack", orkestrThreadId: "thread-1" },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Awaiting ack thread-1/);
});

test("CLI resets and hard-resets threads through the public API", async () => {
  const resetOut = capture();
  const hardResetOut = capture();
  const seen = [];
  const routes = {
    "POST /api/threads/Demo/reset": { ok: true, reset: true },
    "POST /api/threads/Demo/hard-reset": { ok: true, reset: true, hardReset: true },
  };

  const resetCode = await runCli(["--api", "http://orkestr.test", "reset", "Demo"], {
    stdout: resetOut,
    stderr: capture(),
    fetchImpl: fakeFetch(routes, seen),
  });
  const hardResetCode = await runCli(["--api", "http://orkestr.test", "hard-reset", "Demo"], {
    stdout: hardResetOut,
    stderr: capture(),
    fetchImpl: fakeFetch(routes, seen),
  });

  assert.equal(resetCode, 0);
  assert.equal(hardResetCode, 0);
  assert.deepEqual(seen.map((entry) => entry.key), [
    "POST /api/threads/Demo/reset",
    "POST /api/threads/Demo/hard-reset",
  ]);
  assert.match(resetOut.text(), /Reset Demo/);
  assert.match(hardResetOut.text(), /Hard reset Demo/);
});

test("CLI update can run the versioned release deployer", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["update", "--release", "--ref", "v0.1.0-alpha.10", "--channel", "stage", "--no-smoke"], {
    env: {},
    stdout,
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["install", "--ref", "v0.1.0-alpha.10", "--channel", "stage", "--no-smoke"]);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "1");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_REF, "v0.1.0-alpha.10");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_CHANNEL, "stage");
  assert.match(stdout.text(), /versioned release update for v0\.1\.0-alpha\.10/);
});

test("CLI update can track main as versioned releases", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["update", "--track-main", "--no-smoke"], {
    env: {},
    stdout,
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["install", "--ref", "main", "--channel", "main", "--allow-untagged", "--no-smoke"]);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "1");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_REF, "main");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_CHANNEL, "main");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_TAGS_ONLY, "0");
  assert.match(stdout.text(), /versioned release update for main/);
});

test("CLI update can run the in-place watcher", async () => {
  const spawned = [];
  const code = await runCli(["update", "--in-place", "--ref", "main"], {
    env: { ORKESTR_RELEASE_DEPLOY: "1" },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/update-watch\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), []);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "0");
  assert.equal(spawned[0].env.ORKESTR_UPDATE_REF, "main");
});

test("CLI update status and rollback forward to the release deployer", async () => {
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const statusCode = await runCli(["update", "status", "--json"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl,
  });
  const rollbackCode = await runCli(["update", "rollback", "--to", "v0.1.0-alpha.9"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl,
  });

  assert.equal(statusCode, 0);
  assert.equal(rollbackCode, 0);
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["status", "--json"]);
  assert.match(spawned[1].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[1].args.slice(1), ["rollback", "--to", "v0.1.0-alpha.9"]);
});

test("CLI rollback is a short alias for update rollback", async () => {
  const spawned = [];
  const code = await runCli(["rollback"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["rollback"]);
});

test("CLI logs tails the configured systemd service", async () => {
  const spawned = [];
  const code = await runCli(["logs", "--service", "orkestr-stage", "--lines", "50", "--no-follow"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "journalctl");
  assert.deepEqual(spawned[0].args, ["-u", "orkestr-stage.service", "-n", "50", "--no-pager"]);
});

test("CLI service controls default systemd services", async () => {
  const spawned = [];
  const code = await runCli(["service", "restart", "--service", "orkestr-stage"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "systemctl", args: ["restart", "orkestr-stage.service"] }]);
});

test("CLI service controls local systemd user services", async () => {
  const spawned = [];
  const code = await runCli(["service", "status"], {
    env: { ORKESTR_LOCAL_SERVICE_MANAGER: "systemd-user", ORKESTR_LOCAL_SERVICE_NAME: "orkestr-local" },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "systemctl", args: ["--user", "status", "orkestr-local.service"] }]);
});

test("CLI service controls macOS launchd services", async () => {
  const spawned = [];
  const code = await runCli(["service", "start"], {
    env: {
      HOME: "/Users/demo",
      ORKESTR_LOCAL_SERVICE_MANAGER: "launchd",
      ORKESTR_LOCAL_SERVICE_LABEL: "com.orkestr.oss",
      ORKESTR_LOCAL_SERVICE_FILE: "/Users/demo/Library/LaunchAgents/com.orkestr.oss.plist",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "sh");
  assert.match(spawned[0].args[1], /launchctl bootstrap/);
  assert.match(spawned[0].args[1], /launchctl kickstart -k/);
  assert.match(spawned[0].args[1], /com\.orkestr\.oss/);
});

test("CLI service logs tails local service files", async () => {
  const spawned = [];
  const code = await runCli(["service", "logs", "--lines", "25", "--no-follow"], {
    env: {
      ORKESTR_LOCAL_SERVICE_MANAGER: "launchd",
      ORKESTR_LOCAL_LOG_DIR: "/Users/demo/.orkestr/logs",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{
    command: "tail",
    args: ["-n", "25", "/Users/demo/.orkestr/logs/orkestr.out.log", "/Users/demo/.orkestr/logs/orkestr.err.log"],
  }]);
});

test("CLI attach can select a thread and print the tmux command", async () => {
  const stdout = capture();
  const selected = { id: "thread-1", name: "Demo", state: "ready" };
  const code = await runCli(["attach", "--print"], {
    stdout,
    stderr: capture(),
    pickThread: async () => selected,
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": { threads: [selected] },
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), "tmux attach-session -t 'orkestr-demo'\n");
});

test("CLI attach with an explicit thread does not fetch the thread list", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["attach", "Demo", "--print"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["POST /api/threads/Demo/attach"]);
  assert.match(stdout.text(), /orkestr-demo/);
});

test("CLI attach can execute tmux for an attachable thread", async () => {
  const spawned = [];
  const code = await runCli(["attach", "Demo"], {
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "tmux", args: ["attach-session", "-t", "orkestr-demo"] }]);
});
