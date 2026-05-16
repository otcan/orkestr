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
