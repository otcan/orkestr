import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

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
    seen.push({ key, body: options.body ? JSON.parse(options.body) : null });
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
