import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { otherAttachments } from "../apps/cli/src/claude-job-attach.js";
import { matchThreadTarget } from "../apps/cli/src/thread-target.js";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes, seen = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`;
    seen.push({ key, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[key];
    if (!route) return jsonResponse({ ok: false, error: "thread_not_found" }, 404);
    return jsonResponse(typeof route === "function" ? route() : route);
  };
}

const threads = [
  { id: "c43c015612de635a", name: "otcanClaw" },
  { id: "2842b609-7ed9-497c-b54b-dc69dab95f52", name: "Orkestr Crawler Engine", bindingName: "Orkestr Crawler Engine" },
  { id: "88087678-16b4-4cd6-988a-8589e4f81e96", name: "Orkestr Rust", bindingName: "Orkestr Rust" },
];

test("thread targets: list numbers, exact names, unique id and name prefixes", () => {
  assert.equal(matchThreadTarget(threads, "2").id, threads[1].id);
  assert.equal(matchThreadTarget(threads, "2").how, "number");
  assert.equal(matchThreadTarget(threads, "Orkestr Rust").how, "exact");
  assert.equal(matchThreadTarget(threads, "2842b609").id, threads[1].id);
  assert.equal(matchThreadTarget(threads, "orkestr cr").id, threads[1].id);
  assert.equal(matchThreadTarget(threads, "4"), null, "out of range numbers are passed on");
  assert.equal(matchThreadTarget(threads, "284"), null, "id prefixes need 4 characters");
  assert.throws(() => matchThreadTarget(threads, "Orkestr"), /thread_target_ambiguous: "Orkestr" matches 2 threads/);
  assert.throws(() => matchThreadTarget([...threads, { id: "t-9", name: "1" }], "1"), /list number #1 .* also the name of/);
});

test("send 2 resolves the picker number to the thread id and says so", async () => {
  const seen = [];
  const stderr = capture();
  const code = await runCli(["send", "2", "hello"], {
    stdout: capture(), stderr,
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": { threads },
      [`POST /api/threads/${threads[1].id}/input`]: { queued: true, orkestrThreadId: threads[1].id },
      [`GET /api/threads/${threads[1].id}`]: { thread: threads[1] },
    }, seen),
  });
  assert.equal(code, 0);
  assert.match(stderr.text(), /^orkestr: 2 = #2 "Orkestr Crawler Engine" \(2842b609-7ed9-497c-b54b-dc69dab95f52\)/);
  const post = seen.find((entry) => entry.key.startsWith("POST "));
  assert.equal(post.key, `POST /api/threads/${threads[1].id}/input`);
  assert.equal(post.body.text, "hello");
});

test("an exact thread name never reads the thread list; a prefix is resolved after not found", async () => {
  const exact = [];
  await runCli(["wake", "Orkestr Rust"], {
    stdout: capture(), stderr: capture(),
    fetchImpl: fakeFetch({ "POST /api/threads/Orkestr%20Rust/wake": { ok: true } }, exact),
  });
  assert.deepEqual(exact.map((entry) => entry.key), ["POST /api/threads/Orkestr%20Rust/wake"]);
  const prefix = [];
  const code = await runCli(["wake", "2842b609"], {
    stdout: capture(), stderr: capture(),
    fetchImpl: fakeFetch({ "GET /api/threads/summary": { threads }, [`POST /api/threads/${threads[1].id}/wake`]: { ok: true } }, prefix),
  });
  assert.equal(code, 0);
  assert.deepEqual(prefix.map((entry) => entry.key), [
    "POST /api/threads/2842b609/wake", "GET /api/threads/summary", `POST /api/threads/${threads[1].id}/wake`,
  ]);
});

test("watch, switch and thread mission take list numbers too", async () => {
  for (const [argv, key] of [
    [["watch", "read", "2", "--json"], `GET /api/threads/${threads[1].id}/watch-message`],
    [["switch", "2", "--json"], `GET /api/threads/${threads[1].id}/executor`],
    [["thread", "mission", "get", "2", "--json"], `GET /api/threads/${threads[1].id}/mission`],
  ]) {
    const seen = [];
    await runCli(argv, { stdout: capture(), stderr: capture(), fetchImpl: fakeFetch({ "GET /api/threads/summary": { threads }, [key]: { ok: true } }, seen) });
    assert.ok(seen.some((entry) => entry.key === key), `${argv.join(" ")} -> ${seen.map((e) => e.key).join(", ")}`);
  }
});

async function claudeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-claude-attach-"));
  const config = path.join(dir, ".claude");
  await fs.mkdir(path.join(config, "jobs"), { recursive: true });
  const uid = (await fs.stat(config)).uid;
  return { config, uid, env: { ORKESTR_ATTACH_CLAUDE_CONFIG_DIRS: config, ORKESTR_ATTACH_CLAUDE_BIN: "/fixture/claude", ORKESTR_DISABLE_CLI_AUTH: "1" } };
}

const jobs = [
  { id: "da075c03", sessionId: "da075c03-e0ec-47c1-b0e8-bfaf35459060", pid: 11, status: "idle", state: "done", name: "old" },
  { id: "6042d96c", sessionId: "6042d96c-0a3f-43fb-8eeb-e4c14552803f", pid: 12, status: "busy", state: "working", name: "coordinator" },
];

function claudeRoutes() {
  return {
    "GET /api/threads/Orkestr%20Rust": { thread: threads[2] },
    [`GET /api/session-bindings/${jobs[0].sessionId}`]: { binding: { threadId: threads[2].id, lastSeenAt: "2026-10-22T05:40:47.757Z" } },
    [`GET /api/session-bindings/${jobs[1].sessionId}`]: { binding: { threadId: threads[2].id, lastSeenAt: "2026-11-13T14:29:13.416Z" } },
  };
}

function agentsSpawn(calls) {
  return (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify(jobs), stderr: "" };
  };
}

test("attach --print on a thread bound to a Claude Code background session names that session", async () => {
  const { env, uid, config } = await claudeFixture();
  const listed = [];
  const stdout = capture();
  const code = await runCli(["attach", "Orkestr Rust", "--print"], {
    env, uid, stdout, stderr: capture(),
    fetchImpl: fakeFetch(claudeRoutes()),
    spawnSyncImpl: agentsSpawn(listed),
    otherAttachmentsImpl: () => [],
    spawnImpl: () => { throw new Error("--print must not attach"); },
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /^claude-job id=6042d96c session=6042d96c-0a3f-43fb-8eeb-e4c14552803f status=busy state=working user=\S+ attached_elsewhere=none command="env HOME=\S+ CLAUDE_CONFIG_DIR=\S+ \/fixture\/claude attach 6042d96c"\n$/);
  assert.deepEqual(listed[0].slice(-3), ["/fixture/claude", "agents", "--json"]);
  assert.ok(listed[0].includes(`CLAUDE_CONFIG_DIR=${config}`));
});

test("attach to a Claude Code session open in another terminal refuses, and --takeover detaches it first", async () => {
  const { env, uid } = await claudeFixture();
  const stderr = capture();
  const refused = await runCli(["attach", "Orkestr Rust"], {
    env, uid, stdout: capture(), stderr, stdin: { isTTY: true },
    fetchImpl: fakeFetch(claudeRoutes()),
    spawnSyncImpl: agentsSpawn([]),
    otherAttachmentsImpl: () => [{ pid: 999, command: "claude attach 6042d96c" }],
    spawnImpl: () => { throw new Error("must not attach"); },
  });
  assert.equal(refused, 1);
  assert.match(stderr.text(), /^claude_session_attached_elsewhere: session 6042d96c is already open in another terminal \(pid 999\); rerun with --takeover/);
  const killed = [];
  const spawned = [];
  const code = await runCli(["attach", "Orkestr Rust", "--takeover"], {
    env, uid, stdout: capture(), stderr: capture(), stdin: { isTTY: true },
    fetchImpl: fakeFetch(claudeRoutes()),
    spawnSyncImpl: agentsSpawn([]),
    otherAttachmentsImpl: () => [{ pid: 999, command: "claude attach 6042d96c" }],
    killImpl: (pid, signal) => killed.push([pid, signal]),
    spawnImpl: (command, args) => {
      spawned.push([command, ...args]);
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(killed, [[999, "SIGTERM"]]);
  assert.deepEqual(spawned[0].slice(-3), ["/fixture/claude", "attach", "6042d96c"]);
});

test("other terminals on a Claude session are found by attach id or resumed session id", async () => {
  const proc = new Map([
    ["101", ["/home/u/.local/bin/claude", "attach", "6042d96c"]],
    ["102", ["claude", "--resume", "6042d96c-0a3f-43fb-8eeb-e4c14552803f"]],
    ["103", ["claude", "bg-spare", "--bg-spare", "/tmp/x"]],
    ["104", ["claude", "attach", "da075c03"]],
    ["105", ["node", "attach", "6042d96c"]],
  ]);
  const fsImpl = {
    readdirSync: () => [...proc.keys(), "self"],
    readFileSync: (file) => {
      const pid = file.split("/")[2];
      if (!proc.has(pid)) throw new Error("gone");
      return `${proc.get(pid).join("\0")}\0`;
    },
  };
  const found = otherAttachments({ session: jobs[1] }, { fsImpl, selfPid: 1 });
  assert.deepEqual(found.map((entry) => entry.pid), [101, 102]);
});
