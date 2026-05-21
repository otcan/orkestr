import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { createPairingChallenge, getPairingChallenge } from "../packages/core/src/security.js";

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
