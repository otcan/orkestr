import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { buildNativeLaunch, parseEnvironmentFile } from "../apps/cli/src/v2-native-launch.js";
import { acquireHold, readHold, releaseHold, renewHold, HOLD_FORMAT, TTL_MS } from "../apps/cli/src/v2-native-hold.js";

const threadId = "3f1c2a7e-0000-4000-8000-000000000001";
const routeId = "8d2b5c11-0000-4000-8000-000000000002";
const conversationId = "c0ffee00-0000-4000-8000-000000000003";
const nativeId = "bbbbbbbb-0000-4000-8000-000000000020";
const origin = "https://orkestr.example.test";
const conv = `/api/v2/conversations/${conversationId}`;
const native = { sessionId: "aaaaaaaa-0000-4000-8000-000000000010", provider: "claude", nativeSessionId: nativeId, generation: 17, state: "ready", latestRun: null, activeRuns: [] };
const plan = {
  executor_uid: 986,
  executor_gid: 980,
  workspace: "/fixture/workspace",
  native: "/fixture/native-assets/native",
  output: "/fixture/release",
  managed_host: { environment: { CODEX_HOME: "/fixture/codex-home", HOME: "/fixture/exec-home", PATH: "/usr/bin" }, environment_files: [] },
  conversation_workspaces: { [conversationId]: { path: "/fixture/chat-workspace" } },
  claude: {
    executable: "/fixture/claude", account: "/fixture/account", home: "/fixture/home", temporary: "/fixture/tmp", workspace: "/fixture/claude-workspace",
    managed_host: { environment: { HOME: "/fixture/home", TMPDIR: "/fixture/tmp", PATH: "/usr/bin", LANG: "C.UTF-8" } },
  },
};

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function v1Fetch() {
  return async (url) => {
    const key = new URL(url).pathname;
    if (key === `/api/threads/${threadId}`) {
      return jsonResponse({ thread: { id: threadId, name: "Chat", binding: { connector: "whatsapp", remoteBackend: "rust-v2", remoteThreadId: routeId } } });
    }
    return jsonResponse({ error: "thread_not_found" }, 404);
  };
}

function v2Server(calls, extra = {}) {
  const routes = {
    "POST /api/v2/browser/session": { json: { csrf_token: "csrf-1" }, headers: { "set-cookie": ["orkestr_v2=s1; Path=/api/v2"] } },
    "DELETE /api/v2/browser/session": { status: 204 },
    [`GET ${conv}/settings`]: { json: { conversation_id: conversationId, provider: "claude", model: "opus", reasoning_effort: "high" } },
    [`GET ${conv}/execution`]: { json: { conversation_id: conversationId, phase: "idle" } },
    "GET /api/v2/health": { json: { features: ["native_attach_hold_v1"], build: { source_commit: "0123456789abcdef" } } },
    ...extra,
  };
  return async ({ method, url, body }) => {
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    calls.push({ key, body: body ? JSON.parse(body.toString("utf8")) : null });
    const route = routes[key];
    if (!route) return { status: 404, headers: {}, text: "{}" };
    const result = typeof route === "function" ? route() : route;
    return { status: result.status || 200, headers: result.headers || {}, text: result.json === undefined ? "" : JSON.stringify(result.json) };
  };
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-native-attach-"));
  const bindings = path.join(dir, "bindings");
  await fs.mkdir(bindings);
  await fs.writeFile(path.join(dir, "service.json"), JSON.stringify({ origin, loopback_url: "http://127.0.0.1:19822", bindings_dir: bindings }));
  await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ username: "owner", password: "fixture-password" }));
  await fs.writeFile(path.join(bindings, `${routeId}.json`), JSON.stringify({ public_thread_id: threadId, remote_thread_id: routeId, conversation_id: conversationId }));
  const holdDir = path.join(dir, "holds");
  await fs.writeFile(path.join(dir, "native.json"), JSON.stringify({ core_db: "/fixture/core.sqlite3", plan: path.join(dir, "plan-{source12}.json"), hold_dir: holdDir, audit_log: path.join(dir, "audit.jsonl") }));
  return {
    dir,
    holdDir,
    env: {
      ORKESTR_V2_ADAPTER_CONFIG: path.join(dir, "service.json"),
      ORKESTR_V2_OWNER_CREDENTIALS: path.join(dir, "owner.json"),
      ORKESTR_V2_NATIVE_ATTACH_CONFIG: path.join(dir, "native.json"),
      ORKESTR_ATTACH_CLAUDE_CONFIG_DIRS: path.join(dir, "no-claude"),
      ORKESTR_DISABLE_CLI_AUTH: "1",
      TERM: "xterm-256color",
    },
  };
}

// A provider process stand-in; like a real child it keeps the event loop alive until it exits.
function child(onKill) {
  const emitter = new EventEmitter();
  const alive = setInterval(() => {}, 1000);
  emitter.once("exit", () => clearInterval(alive));
  emitter.kill = (signal) => {
    onKill?.(signal);
    setImmediate(() => emitter.emit("exit", null, signal));
  };
  return emitter;
}

function baseContext(f, overrides = {}) {
  return {
    env: f.env,
    uid: 0,
    stdin: { isTTY: true },
    stdout: capture(),
    stderr: capture(),
    fetchImpl: v1Fetch(),
    sleepImpl: () => new Promise((resolve) => setImmediate(resolve)),
    readNativeSessionImpl: () => native,
    readSelectedPlanImpl: () => plan,
    servicePidImpl: () => 4242,
    processesNamingImpl: () => [],
    ...overrides,
  };
}

test("the Claude launch enters V2's mount namespace as the executor and resumes the native session", () => {
  const launch = buildNativeLaunch({ plan, native, conversationId, settings: { model: "opus", reasoning_effort: "high" }, namespacePid: 4242, env: { TERM: "xterm" } });
  assert.equal(launch.command, "nsenter");
  assert.deepEqual(launch.args.slice(0, 12), ["--target", "4242", "--mount", "--wd=/fixture/claude-workspace", "--", "setpriv", "--reuid=986", "--regid=980", "--init-groups", "--no-new-privs", "--", "env"]);
  assert.equal(launch.args[12], "-i");
  assert.deepEqual(launch.args.slice(-4), ["/fixture/claude", "--resume", nativeId, "--dangerously-skip-permissions"]);
  for (const pair of ["CLAUDE_CONFIG_DIR=/fixture/account", "HOME=/fixture/home", "TMPDIR=/fixture/tmp", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1", "ANTHROPIC_MODEL=opus", "CLAUDE_CODE_EFFORT_LEVEL=high", "TERM=xterm"]) {
    assert.ok(launch.args.includes(pair), pair);
  }
});

test("the Codex launch uses V2's CODEX_HOME, the chat's workspace and the environment files", () => {
  const files = { "/fixture/business.env": "# comment\nexport GOG_ACCOUNT=acct\nQUOTED=\"a b\"\n" };
  const codexPlan = { ...plan, managed_host: { ...plan.managed_host, environment_files: ["/fixture/business.env"] } };
  const launch = buildNativeLaunch({ plan: codexPlan, native: { ...native, provider: "codex" }, conversationId, namespacePid: 4242, env: {}, readFile: (file) => files[file] });
  assert.ok(launch.args.includes("--wd=/fixture/chat-workspace"));
  assert.ok(launch.args.includes("CODEX_HOME=/fixture/codex-home"));
  assert.ok(launch.args.includes("GOG_ACCOUNT=acct"));
  assert.deepEqual(launch.args.slice(-4), ["/fixture/release/package/native", "--dangerously-bypass-approvals-and-sandbox", "resume", nativeId]);
  assert.deepEqual(parseEnvironmentFile(files["/fixture/business.env"]), { GOG_ACCOUNT: "acct", QUOTED: "a b" });
  assert.throws(() => buildNativeLaunch({ plan, native, conversationId, namespacePid: 0 }), /V2 service is not running/);
});

test("a hold is created, renewed, refused to a second terminal, expires, and is released with an ended record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-hold-"));
  let clock = 1_000_000;
  const now = () => clock;
  const alive = new Set([111, 222]);
  const kill = (pid, signal) => {
    if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (signal === "SIGTERM") alive.delete(pid);
  };
  const isAttach = (pid) => alive.has(pid);
  const first = await acquireHold({ dir, native, conversationId, now, kill, isAttach, selfPid: 111, sleep: async () => {} });
  assert.equal(first.format, HOLD_FORMAT);
  assert.equal(first.expires_at_ms, clock + TTL_MS);
  assert.equal(readHold(dir, conversationId, { now: clock }).live, true);
  await assert.rejects(acquireHold({ dir, native, conversationId, now, kill, isAttach, selfPid: 222, sleep: async () => {} }), /v2_native_attached_elsewhere: .*pid 111/);
  clock += 30_000;
  assert.equal(renewHold(dir, first, { now }), true);
  assert.equal(readHold(dir, conversationId, { now: clock }).expires_at_ms, clock + TTL_MS);
  // A dead terminal stops renewing: the server sees the hold end within the TTL.
  clock += TTL_MS + 1;
  assert.equal(readHold(dir, conversationId, { now: clock }).live, false);
  const second = await acquireHold({ dir, native, conversationId, now, kill, isAttach, selfPid: 222, sleep: async () => {} });
  assert.equal(renewHold(dir, first, { now }), false, "the old terminal lost the hold");
  // Takeover: the current holder is asked to hand back first.
  const third = await acquireHold({ dir, native, conversationId, now, kill, isAttach, selfPid: 333, sleep: async () => {}, takeover: true });
  assert.ok(!alive.has(222));
  releaseHold(dir, second, { now, auditLog: path.join(dir, "audit.jsonl") });
  assert.equal(readHold(dir, conversationId, { now: clock }).holder_pid, 333, "releasing a lost hold leaves the new holder's record");
  const ended = releaseHold(dir, third, { now, auditLog: path.join(dir, "audit.jsonl"), reason: "exited" });
  assert.equal(readHold(dir, conversationId, { now: clock }), null);
  assert.equal(JSON.parse(fsSync.readFileSync(path.join(dir, `${conversationId}.ended.json`), "utf8")).native_session_id, nativeId);
  assert.equal(ended.started_at_ms, third.acquired_at_ms);
  assert.equal(fsSync.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.equal(fsSync.statSync(path.join(dir, `${conversationId}.ended.json`)).mode & 0o777, 0o400);
});

test("attach holds the chat, waits for V2 to finish, opens the native session and hands back", async () => {
  const f = await fixture();
  const calls = [];
  const activity = [
    { held: false, busy: true, phase: "running", windowState: "active", runId: "r1", execution: {} },
    { held: true, busy: true, phase: "running", windowState: "active", runId: "r1", execution: {} },
    { held: true, busy: false, phase: "idle", windowState: "closed", runId: null, execution: {} },
  ];
  const spawned = [];
  const ctx = baseContext(f, {
    v2RequestImpl: v2Server(calls),
    v2ActivityImpl: async () => activity.shift() || { held: true, busy: false },
    spawnImpl: (command, args) => {
      spawned.push([command, ...args]);
      const hold = readHold(f.holdDir, conversationId);
      assert.equal(hold.live, true, "the hold is live while the session is open");
      assert.equal(hold.native_session_id, nativeId);
      const c = child();
      setImmediate(() => c.emit("exit", 0, null));
      return c;
    },
  });
  const code = await runCli(["attach", threadId], ctx);
  assert.equal(code, 0, ctx.stderr.text());
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], "nsenter");
  assert.match(ctx.stderr.text(), /still working on this chat \(running, window active\)/);
  assert.match(ctx.stderr.text(), /as V2's executor in V2's file namespace, without the orkestr_managed tools/);
  assert.match(ctx.stderr.text(), /Handed back to V2/);
  assert.equal(readHold(f.holdDir, conversationId), null, "released");
  const ended = JSON.parse(fsSync.readFileSync(path.join(f.holdDir, `${conversationId}.ended.json`), "utf8"));
  assert.equal(ended.reason, "exited");
  const audit = JSON.parse(fsSync.readFileSync(path.join(f.dir, "audit.jsonl"), "utf8").trim());
  assert.equal(audit.thread_id, threadId);
  assert.equal(audit.exit_code, 0);
  assert.equal(calls.at(-1).key, "DELETE /api/v2/browser/session");
});

test("attach --interrupt stops the running V2 turn with the guarded owner Stop", async () => {
  const f = await fixture();
  const calls = [];
  const activity = [
    { held: true, busy: true, phase: "running", windowState: "active", runId: "r1", execution: { run_id: "r1", revision: 7, control_revision: 2 } },
    { held: true, busy: false, phase: "idle", windowState: "closed", runId: null, execution: {} },
  ];
  const ctx = baseContext(f, {
    v2RequestImpl: v2Server(calls, { [`POST ${conv}/stop`]: { status: 202, json: {} } }),
    v2ActivityImpl: async () => activity.shift(),
    spawnImpl: () => {
      const c = child();
      setImmediate(() => c.emit("exit", 0, null));
      return c;
    },
  });
  assert.equal(await runCli(["attach", threadId, "--interrupt"], ctx), 0, ctx.stderr.text());
  const stop = calls.find((call) => call.key === `POST ${conv}/stop`);
  assert.deepEqual({ run: stop.body.run_id, rev: stop.body.expected_revision, control: stop.body.expected_control_revision }, { run: "r1", rev: 7, control: 2 });
  assert.match(stop.body.request_key, /^cli-attach-interrupt-/);
});

test("attach refuses while the session is open in another process, and never leaves a hold behind", async () => {
  const f = await fixture();
  const ctx = baseContext(f, {
    v2RequestImpl: v2Server([]),
    v2ActivityImpl: async () => ({ held: true, busy: false }),
    processesNamingImpl: () => [{ pid: 5151, command: "claude" }],
    spawnImpl: () => { throw new Error("must not open"); },
  });
  assert.equal(await runCli(["attach", threadId], ctx), 1);
  assert.match(ctx.stderr.text(), /v2_native_open_elsewhere: the claude session \S+ is open in another process \(pid 5151 claude\); rerun with --takeover/);
  assert.equal(readHold(f.holdDir, conversationId), null);
  assert.equal(fsSync.existsSync(path.join(f.holdDir, `${conversationId}.ended.json`)), false, "nothing was opened, so V2 gets no terminal note");
  assert.equal(JSON.parse(fsSync.readFileSync(path.join(f.dir, "audit.jsonl"), "utf8")).opened, false);
});

test("a lost hold closes the terminal session so V2 stays the only writer", async () => {
  const f = await fixture();
  let killedWith = null;
  const ctx = baseContext(f, {
    renewMs: 5,
    serverHoldViewImpl: async () => "held",
    v2RequestImpl: v2Server([]),
    v2ActivityImpl: async () => ({ held: true, busy: false }),
    spawnImpl: () => {
      const c = child((signal) => {
        killedWith = signal;
      });
      // Another terminal takes the hold over while this session is open.
      setTimeout(() => fsSync.rmSync(path.join(f.holdDir, `${conversationId}.json`)), 20);
      return c;
    },
  });
  assert.equal(await runCli(["attach", threadId], ctx), 0);
  assert.equal(killedWith, "SIGTERM");
  assert.match(ctx.stderr.text(), /The hold was taken over or removed; closing this terminal session/);
});

test("attach to a V2 chat needs root and a terminal", async () => {
  const f = await fixture();
  const notRoot = baseContext(f, { uid: 995, v2RequestImpl: v2Server([]), spawnImpl: () => { throw new Error("no"); } });
  assert.equal(await runCli(["attach", threadId], notRoot), 1);
  assert.match(notRoot.stderr.text(), /v2_attach_root_required/);
  const noTty = baseContext(f, { stdin: { isTTY: false }, v2RequestImpl: () => { throw new Error("no V2 call"); } });
  assert.equal(await runCli(["attach", threadId], noTty), 1);
  assert.match(noTty.stderr.text(), /v2_attach_tty_required: opening the native session/);
});

test("a briefly unwritable hold directory keeps the session until the hold would lapse", async () => {
  const f = await fixture();
  let clock = 1_000_000;
  let failing = false;
  const fsImpl = { ...fsSync, writeFileSync: (...args) => {
    if (failing) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return fsSync.writeFileSync(...args);
  } };
  let killedAt = null;
  const ctx = baseContext(f, {
    renewMs: 5,
    serverHoldViewImpl: async () => "held",
    fsImpl,
    nowImpl: () => clock,
    v2RequestImpl: v2Server([]),
    v2ActivityImpl: async () => ({ held: true, busy: false }),
    spawnImpl: () => {
      const c = child(() => {
        killedAt = clock;
      });
      failing = true;
      // Storage stays unwritable while the clock runs past the hold's TTL.
      const tick = setInterval(() => {
        clock += 1_000;
      }, 2);
      c.once("exit", () => clearInterval(tick));
      return c;
    },
  });
  assert.equal(await runCli(["attach", threadId], ctx), 0);
  assert.ok(killedAt !== null, "closed before the hold lapsed");
  assert.ok(killedAt - 1_000_000 > 60_000, `kept the session through transient failures (closed after ${killedAt - 1_000_000} ms)`);
  assert.ok(killedAt - 1_000_000 <= 60_000 + 20_000, "gives up at about 60 s, well before the hold's expiry");
  assert.ok(killedAt - 1_000_000 < TTL_MS);
});

test("the drain waits for the server's native_idle, not only for the run to end", async () => {
  const f = await fixture();
  const reads = [
    { held: true, native_idle: false },
    { held: true, native_idle: true },
  ];
  let spawnedAfter = null;
  const ctx = baseContext(f, {
    v2RequestImpl: v2Server([], {
      [`GET ${conv}/native-attach`]: () => ({ json: { conversation_id: conversationId, ...(reads.shift() || { held: true, native_idle: true }) } }),
      [`GET ${conv}/window`]: { json: { window_id: "w", conversation_id: conversationId, state: "closed" } },
    }),
    spawnImpl: () => {
      spawnedAfter = reads.length;
      const c = child();
      setImmediate(() => c.emit("exit", 0, null));
      return c;
    },
  });
  assert.equal(await runCli(["attach", threadId], ctx), 0, ctx.stderr.text());
  assert.equal(spawnedAfter, 0, "opened only after native_idle");
  assert.match(ctx.stderr.text(), /still working on this chat/);
});

test("the session closes (SIGTERM, then SIGKILL) as soon as the server stops reporting the hold", async () => {
  const f = await fixture();
  const signals = [];
  let view = "held";
  const ctx = baseContext(f, {
    renewMs: 5,
    killGraceMs: 20,
    serverHoldViewImpl: async () => view,
    v2RequestImpl: v2Server([]),
    v2ActivityImpl: async () => ({ held: true, busy: false }),
    spawnImpl: () => {
      // A provider that ignores SIGTERM: only SIGKILL ends it.
      const emitter = new EventEmitter();
      const alive = setInterval(() => {}, 1000);
      emitter.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") setImmediate(() => { clearInterval(alive); emitter.emit("exit", null, signal); });
      };
      setTimeout(() => { view = "not_held"; }, 30);
      return emitter;
    },
  });
  assert.equal(await runCli(["attach", threadId], ctx), 0);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.match(ctx.stderr.text(), /does not report the hold any more/);
});

test("the server view: health feature and GET native-attach decide; unreachable is unknown", async () => {
  const { serverHoldView } = await import("../apps/cli/src/v2-native-attach.js");
  const target = { conversationId };
  const session = (health, hold) => ({ call: async (method, path) => (path === "/api/v2/health" ? health : hold) });
  const feature = { status: 200, json: { features: ["native_attach_hold_v1"] } };
  assert.equal(await serverHoldView(session(feature, { status: 200, json: { held: true } }), target), "held");
  assert.equal(await serverHoldView(session(feature, { status: 200, json: { held: false } }), target), "not_held");
  assert.equal(await serverHoldView(session(feature, { status: 404, json: { code: "native_attach_unconfigured" } }), target), "not_held");
  assert.equal(await serverHoldView(session({ status: 200, json: { features: [] } }, { status: 200, json: { held: true } }), target), "not_held");
  assert.equal(await serverHoldView(session({ status: 503 }, { status: 503 }), target), "unknown");
  assert.equal(await serverHoldView({ call: async () => { throw new Error("ECONNREFUSED"); } }, target), "unknown");
});

test("takeover only signals a real attach CLI; a recycled pid's hold is stale", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-hold-takeover-"));
  const now = () => 2_000_000;
  const signalled = [];
  const kill = (pid, signal) => { if (signal) signalled.push([pid, signal]); };
  await acquireHold({ dir, native, conversationId, now, kill, isAttach: () => true, selfPid: 700, sleep: async () => {} });
  // pid 700 is alive but is no attach CLI any more: the record is stale, nothing is signalled.
  const fresh = await acquireHold({ dir, native, conversationId, now, kill, isAttach: () => false, selfPid: 701, sleep: async () => {}, takeover: true });
  assert.equal(fresh.holder_pid, 701);
  assert.deepEqual(signalled, []);
  const { isAttachProcess } = await import("../apps/cli/src/v2-native-hold.js");
  const proc = (cmdline, uid) => ({ readFileSync: (file) => (file.endsWith("cmdline") ? cmdline.join("\0") : `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`) });
  assert.equal(isAttachProcess(9, proc(["node", "/opt/orkestr/current/apps/cli/bin/orkestr-oss.js", "attach", "132"], 0)), true);
  assert.equal(isAttachProcess(9, proc(["node", "/opt/orkestr/current/apps/cli/bin/orkestr-oss.js", "attach", "132"], 995)), false);
  assert.equal(isAttachProcess(9, proc(["sleep", "100"], 0)), false);
});

test("--interrupt sends the owner Stop only after the server reports the hold", async () => {
  const f = await fixture();
  const order = [];
  const activity = [
    { held: false, busy: true, phase: "running", windowState: "active", runId: "r1", execution: { run_id: "r1", revision: 3 } },
    { held: true, busy: true, phase: "running", windowState: "active", runId: "r1", execution: { run_id: "r1", revision: 3 } },
    { held: true, busy: false, phase: "idle", windowState: "closed", runId: null, execution: {} },
  ];
  const ctx = baseContext(f, {
    v2RequestImpl: v2Server([], { [`POST ${conv}/stop`]: () => { order.push("stop"); return { status: 202, json: {} }; } }),
    v2ActivityImpl: async () => { const next = activity.shift(); order.push(next.held ? "held" : "not-yet-held"); return next; },
    spawnImpl: () => { const c = child(); setImmediate(() => c.emit("exit", 0, null)); return c; },
  });
  assert.equal(await runCli(["attach", threadId, "--interrupt"], ctx), 0, ctx.stderr.text());
  assert.deepEqual(order, ["not-yet-held", "held", "stop", "held"]);
  assert.match(ctx.stderr.text(), /queued messages stay queued/);
});
