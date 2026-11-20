import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { sendOwnerMessage } from "../apps/cli/src/v2-attach.js";
import { v2AttachConfig } from "../apps/cli/src/v2-owner-session.js";

const threadId = "3f1c2a7e-0000-4000-8000-000000000001";
const routeId = "8d2b5c11-0000-4000-8000-000000000002";
const conversationId = "c0ffee00-0000-4000-8000-000000000003";
const windowId = "5ca1ab1e-0000-4000-8000-000000000004";
const origin = "https://orkestr.example.test";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function v1Fetch(routes, seen = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`;
    seen.push(key);
    const route = routes[key];
    if (!route) return jsonResponse({ error: `missing route: ${key}` }, 404);
    return jsonResponse(typeof route === "function" ? route() : route);
  };
}

// A fake loopback V2 server: routes are "METHOD /path?query".
function v2Server(routes, calls = []) {
  return async ({ method, url, headers, body }) => {
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const call = { key, headers, body: body ? JSON.parse(body.toString("utf8")) : null };
    calls.push(call);
    const route = routes[key];
    if (!route) return { status: 404, headers: {}, text: JSON.stringify({ code: "not_found", message: key }) };
    const result = typeof route === "function" ? route(call) : route;
    const status = result.status || 200;
    return { status, headers: result.headers || {}, text: result.json === undefined ? "" : JSON.stringify(result.json) };
  };
}

function delegatedThread(overrides = {}) {
  return {
    id: threadId,
    name: "Crawler Engine",
    bindingName: "Crawler Engine",
    executor: { type: "codex", sessionName: `orkestr-thread-${threadId}` },
    binding: { connector: "whatsapp", remoteBackend: "rust-v2", remoteThreadId: routeId, remoteRuntimeEnabled: true },
    ...overrides,
  };
}

async function fixture({ binding = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-v2-attach-"));
  const bindings = path.join(dir, "bindings");
  await fs.mkdir(bindings);
  await fs.writeFile(path.join(dir, "service.json"), JSON.stringify({ origin, loopback_url: "http://127.0.0.1:19822", bindings_dir: bindings }));
  await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ username: "owner", password: "fixture-password" }));
  await fs.writeFile(path.join(bindings, `${routeId}.json`), JSON.stringify({
    public_thread_id: threadId, remote_thread_id: routeId, conversation_id: conversationId, enabled: true, revoked: false, ...binding,
  }));
  return {
    dir,
    env: {
      ORKESTR_V2_ADAPTER_CONFIG: path.join(dir, "service.json"),
      ORKESTR_V2_OWNER_CREDENTIALS: path.join(dir, "owner.json"),
      ORKESTR_V2_NATIVE_ATTACH_CONFIG: path.join(dir, "native.json"),
      ORKESTR_ATTACH_CLAUDE_CONFIG_DIRS: path.join(dir, "no-claude"),
      ORKESTR_DISABLE_CLI_AUTH: "1",
    },
  };
}

const conv = `/api/v2/conversations/${conversationId}`;

function baseV2Routes(extra = {}) {
  return {
    "POST /api/v2/browser/session": { json: { csrf_token: "csrf-1" }, headers: { "set-cookie": ["orkestr_v2=session-1; Path=/api/v2; HttpOnly"] } },
    "DELETE /api/v2/browser/session": { status: 204 },
    [`GET ${conv}/settings`]: { json: { conversation_id: conversationId, provider: "claude", model: "opus", reasoning_effort: "high" } },
    [`GET ${conv}/execution`]: { json: { conversation_id: conversationId, phase: "running" } },
    ...extra,
  };
}

test("attach --print on a V2-served chat names its V2 agent and native session and never asks V1 to attach", async () => {
  const { env, dir } = await fixture();
  await fs.writeFile(path.join(dir, "native.json"), JSON.stringify({ core_db: "/fixture/core.sqlite3", plan: path.join(dir, "plan-{source12}.json") }));
  await fs.writeFile(path.join(dir, "plan-0123456789ab.json"), JSON.stringify({
    executor_uid: 0,
    claude: { executable: "/fixture/claude", account: "/fixture/account", home: "/fixture/home", temporary: "/fixture/tmp", workspace: "/fixture/workspace" },
  }));
  const seen = [];
  const calls = [];
  const stdout = capture();
  const code = await runCli(["attach", "Crawler Engine", "--print"], {
    env, stdout, stderr: capture(),
    fetchImpl: v1Fetch({ "GET /api/threads/Crawler%20Engine": { thread: delegatedThread() } }, seen),
    v2RequestImpl: v2Server(baseV2Routes({ "GET /api/v2/health": { json: { build: { source_commit: "0123456789abcdef" } } } }), calls),
    readNativeSessionImpl: (db, conversation) => {
      assert.equal(db, "/fixture/core.sqlite3");
      assert.equal(conversation, conversationId);
      return { sessionId: "aaaaaaaa-0000-4000-8000-000000000010", provider: "claude", nativeSessionId: "bbbbbbbb-0000-4000-8000-000000000020", generation: 17, state: "busy",
        latestRun: { id: "cccccccc-0000-4000-8000-000000000030", state: "running", generation: 17 }, activeRuns: [{ id: "cccccccc-0000-4000-8000-000000000030", state: "running", role: "deep" }] };
    },
    processesNamingImpl: () => [{ pid: 4242, command: "claude" }],
  });
  assert.equal(code, 0);
  const [chat, native] = stdout.text().trimEnd().split("\n");
  assert.equal(chat, `v2-chat conversation=${conversationId} thread=${threadId} provider=claude model=opus effort=high name="Crawler Engine" web=${origin}/#conversation/${conversationId}`);
  assert.equal(native, 'v2-native provider=claude session=bbbbbbbb-0000-4000-8000-000000000020 binding=aaaaaaaa-0000-4000-8000-000000000010/g17 state=busy latest_run=cccccccc-0000-4000-8000-000000000030(running) in_use="v2-run cccccccc-0000-4000-8000-000000000030 (running); pid 4242 (claude)" user=root cwd=/fixture/workspace command="/fixture/claude --resume bbbbbbbb-0000-4000-8000-000000000020"');
  assert.deepEqual(seen, ["GET /api/threads/Crawler%20Engine"]);
  assert.deepEqual(calls.map((call) => call.key), [
    "POST /api/v2/browser/session", `GET ${conv}/settings`, `GET ${conv}/execution`, "GET /api/v2/health", "DELETE /api/v2/browser/session",
  ]);
  assert.equal(calls[0].headers.origin, origin);
  assert.equal(calls[0].headers.host, "orkestr.example.test");
  assert.equal(calls[1].headers.cookie, "orkestr_v2=session-1");
  assert.equal(calls[1].headers["x-orkestr-csrf"], undefined);
  assert.equal(calls[4].headers["x-orkestr-csrf"], "csrf-1");
});

test("attach without --chat on a V2 chat refuses to open the native session until V2 can hold it", async () => {
  const { env } = await fixture();
  const stderr = capture();
  const code = await runCli(["attach", threadId], {
    env, stdout: capture(), stderr, stdin: { isTTY: true },
    fetchImpl: v1Fetch({ [`GET /api/threads/${threadId}`]: { thread: delegatedThread() } }),
    v2RequestImpl: () => { throw new Error("V2 must not be called"); },
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /^v2_native_attach_unavailable: .*orkestr attach [0-9a-f-]+ --chat/);
});

test("attach --json on a V2-served chat reports the target", async () => {
  const { env } = await fixture();
  const stdout = capture();
  const code = await runCli(["attach", threadId, "--json"], {
    env, stdout, stderr: capture(),
    fetchImpl: v1Fetch({ [`GET /api/threads/${threadId}`]: { thread: delegatedThread() } }),
    v2RequestImpl: v2Server(baseV2Routes()),
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.attachKind, "v2-owner-chat");
  assert.equal(payload.conversationId, conversationId);
  assert.equal(payload.remoteThreadId, routeId);
  assert.equal(payload.provider, "claude");
  assert.equal(payload.phase, "running");
});

test("attach on a V1-only thread keeps the V1 terminal attach", async () => {
  const { env } = await fixture();
  const seen = [];
  const stdout = capture();
  const code = await runCli(["attach", "Demo", "--print"], {
    env, stdout, stderr: capture(),
    fetchImpl: v1Fetch({
      "GET /api/threads/Demo": { thread: { id: "t-1", name: "Demo", binding: { connector: "whatsapp", chatId: "group" } } },
      "POST /api/threads/Demo/attach": { ok: true, runtime: { sessionName: "orkestr-demo" } },
    }, seen),
    v2RequestImpl: () => { throw new Error("V2 must not be called"); },
  });
  assert.equal(code, 0);
  assert.equal(stdout.text(), "tmux attach-session -t 'orkestr-demo'\n");
  assert.deepEqual(seen, ["GET /api/threads/Demo", "POST /api/threads/Demo/attach"]);
});

test("attach refuses a V2 chat whose adapter binding names another thread", async () => {
  const { env } = await fixture({ binding: { public_thread_id: "someone-else" } });
  const seen = [];
  const stderr = capture();
  const code = await runCli(["attach", threadId, "--print"], {
    env, stdout: capture(), stderr,
    fetchImpl: v1Fetch({ [`GET /api/threads/${threadId}`]: { thread: delegatedThread() } }, seen),
    v2RequestImpl: () => { throw new Error("V2 must not be called"); },
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /v2_attach_binding_mismatch/);
  assert.deepEqual(seen, [`GET /api/threads/${threadId}`]);
});

test("attach never falls back to the V1 terminal when the thread read fails", async () => {
  const seen = [];
  const stderr = capture();
  const code = await runCli(["attach", "Demo"], {
    stdout: capture(), stderr,
    fetchImpl: async (url, options = {}) => {
      seen.push(`${options.method || "GET"} ${new URL(url).pathname}`);
      return jsonResponse({ error: "registry_unavailable" }, 503);
    },
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /registry_unavailable/);
  assert.deepEqual(seen, ["GET /api/threads/Demo"]);
});

test("attach --chat to a V2 chat without a terminal sends nothing", async () => {
  const { env } = await fixture();
  const stderr = capture();
  const code = await runCli(["attach", threadId, "--chat"], {
    env, stdout: capture(), stderr, stdin: { isTTY: false },
    fetchImpl: v1Fetch({ [`GET /api/threads/${threadId}`]: { thread: delegatedThread() } }),
    v2RequestImpl: () => { throw new Error("V2 must not be called"); },
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /v2_attach_tty_required/);
});

test("attach sends a typed line as an owner message and streams the answer back", async () => {
  const { env } = await fixture();
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = capture();
  const calls = [];
  let admitted = false;
  const routes = baseV2Routes({
    [`GET ${conv}/updates?before_sequence=${Number.MAX_SAFE_INTEGER}&limit=1`]: {
      json: { conversation_id: conversationId, updates: [{ run_id: "r0", payload_id: "p0", sequence: 10, observed_at_ms: 0, payload_removed: false, final_answer: true }], next_after_sequence: null },
    },
    [`GET ${conv}/payloads/p0`]: { json: { text: "earlier answer" } },
    [`POST ${conv}/messages`]: (call) => ({ status: 202, json: { message_id: "11111111-0000-4000-8000-000000000011", event_id: "22222222-0000-4000-8000-000000000022", sequence: 11, status: "accepted", echo: call.body } }),
    [`GET ${conv}/window`]: { json: { window_id: windowId, conversation_id: conversationId, generation: 4, state: "active" } },
    [`POST ${conv}/window`]: (call) => {
      admitted = true;
      return { status: 201, json: { status: { window_id: windowId, conversation_id: conversationId, generation: 4, state: "active" }, input_message_id: call.body.input_message_id, input_event_id: call.body.input_event_id, input_request_key: call.body.input_request_key, request_key: call.body.request_key, duplicate: false } };
    },
    [`GET ${conv}/updates?after_sequence=10&limit=100`]: () => ({
      json: { conversation_id: conversationId, updates: admitted ? [{ run_id: "r1", payload_id: "p1", sequence: 12, observed_at_ms: 0, payload_removed: false, final_answer: true }] : [], next_after_sequence: null },
    }),
    [`GET ${conv}/updates?after_sequence=12&limit=100`]: { json: { conversation_id: conversationId, updates: [], next_after_sequence: null } },
    [`GET ${conv}/payloads/p1`]: () => {
      setImmediate(() => stdin.end());
      return { json: { text: "the answer" } };
    },
  });
  stdin.write("hello agent\n");
  const code = await runCli(["attach", threadId, "--chat"], {
    env, stdin, stdout, stderr: capture(),
    sleepImpl: () => new Promise((resolve) => setImmediate(resolve)),
    fetchImpl: v1Fetch({ [`GET /api/threads/${threadId}`]: { thread: delegatedThread() } }),
    v2RequestImpl: v2Server(routes, calls),
  });
  assert.equal(code, 0);
  const message = calls.find((call) => call.key === `POST ${conv}/messages`);
  assert.equal(message.body.author, "owner");
  assert.equal(message.body.text, "hello agent");
  assert.match(message.body.client_message_id, /^cli-attach-[0-9a-f-]{36}$/);
  const admit = calls.find((call) => call.key === `POST ${conv}/window`);
  assert.equal(admit.body.window_id, windowId);
  assert.equal(admit.body.predecessor_window_id, null);
  assert.equal(admit.body.expected_generation, 4);
  assert.equal(admit.body.input_request_key, message.body.client_message_id);
  assert.equal(admit.headers["x-orkestr-csrf"], "csrf-1");
  assert.match(stdout.text(), /earlier answer/);
  assert.match(stdout.text(), /Sent\. Added to the running turn\./);
  assert.match(stdout.text(), /claude\/opus answer[^\n]*\nthe answer/);
  assert.equal(calls.at(-1).key, "DELETE /api/v2/browser/session");
});

test("owner message admission follows the web composer's window rules", async () => {
  const target = { conversationId, config: {} };
  const receipt = { message_id: "11111111-0000-4000-8000-000000000011", event_id: "22222222-0000-4000-8000-000000000022", sequence: 3 };
  const windows = [
    { status: 200, json: { window_id: windowId, conversation_id: conversationId, generation: 7, state: "retiring" } },
    { status: 200, json: { window_id: windowId, conversation_id: conversationId, generation: 7, state: "closed" } },
    { status: 200, json: { window_id: windowId, conversation_id: conversationId, generation: 8, state: "closed" } },
  ];
  const admits = [];
  const notices = [];
  const session = {
    async call(method, url, body) {
      if (url.endsWith("/messages")) return { status: 202, json: receipt };
      if (method === "GET" && url.endsWith("/window")) return windows.shift();
      admits.push(body);
      if (admits.length === 1) return { status: 409, json: { code: "window_conflict" } };
      return { status: 202, json: { conversation_id: conversationId, request_key: body.request_key, input_message_id: body.input_message_id, state: "queued", position: 2 } };
    },
  };
  const result = await sendOwnerMessage(session, target, "hi", { sleep: async () => {}, notify: (notice) => notices.push(notice) });
  assert.deepEqual(result, { ok: true, messageId: receipt.message_id, notice: "Sent. Queued (position 2)." });
  assert.deepEqual(notices, ["Saved. Waiting for the current work to settle..."]);
  assert.equal(admits.length, 2);
  assert.equal(admits[0].predecessor_window_id, windowId);
  assert.equal(admits[0].window_id, null);
  assert.equal(admits[0].expected_generation, 7);
  assert.equal(admits[1].expected_generation, 8);
  assert.notEqual(admits[0].request_key, admits[1].request_key);
  assert.equal(admits[0].input_request_key, admits[1].input_request_key);
});

test("attach --conversation goes straight to V2 and the owner login only ever goes to loopback", async () => {
  const { env, dir } = await fixture();
  const seen = [];
  const stdout = capture();
  const code = await runCli(["attach", "--conversation", conversationId, "--print"], {
    env, stdout, stderr: capture(),
    fetchImpl: v1Fetch({}, seen),
    v2RequestImpl: v2Server(baseV2Routes()),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, []);
  assert.match(stdout.text(), new RegExp(`^v2-chat conversation=${conversationId} provider=claude`));
  await fs.writeFile(path.join(dir, "service.json"), JSON.stringify({ origin, loopback_url: "http://10.0.0.5:19822", bindings_dir: dir }));
  assert.throws(() => v2AttachConfig(env), /loopback/);
});
