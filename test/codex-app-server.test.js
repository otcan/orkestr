import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  answerCodexAppServerPendingRequest,
  codexAppServerThreadStatus,
  deliverCodexAppServerPendingInputs,
  getCodexAppServerClient,
  hydrateCodexAppServerThreadMessages,
  importCodexAppServerThread,
  interruptCodexAppServerThread,
  listCodexAppServerThreads,
  recoverStaleCodexAppServerTurns,
  resumeCodexAppServerThread,
  startCodexAppServerThread,
  stopCodexAppServerClients,
  syncCodexAppServerThreadMessages,
} from "../packages/core/src/codex-app-server.js";
import { migrateCodexThreadsToAppServer } from "../packages/core/src/codex-app-server-migration.js";
import {
  consumeThreadConnectorDeliverySignalCount,
  resetThreadRuntime,
  safeResetThreadRuntime,
  setThreadConnectorDeliverySignalHandler,
  sleepThread,
} from "../packages/core/src/runtime-leases.js";
import { appServerStateFromStatus, containedCodexRuntimePaths, effortForThread, modelForThread, threadStartParams, turnStartParams } from "../packages/core/src/codex-app-server-common.js";
import { appendThreadMessage, createThread, enqueueThreadInput, getThread, listThreadMessages, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

async function createFakeCodex(home) {
  const bin = path.join(home, "bin");
  const stateFile = path.join(home, "codex-state.json");
  await fs.mkdir(bin, { recursive: true });
  const codexPath = path.join(bin, "codex");
  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CODEX_STATE;
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { threads: [], calls: [] }; }
}
function writeState(state) {
  const tmp = stateFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}
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
if (args[0] !== "app-server") process.exit(0);
const initialState = readState();
initialState.argv = args;
initialState.env = {
  HOME: process.env.HOME || "",
  CODEX_HOME: process.env.CODEX_HOME || "",
  ORKESTR_CODEX_APP_SERVER_MODE: process.env.ORKESTR_CODEX_APP_SERVER_MODE || "",
  ORKESTR_CODEX_APP_SERVER_SOCKET: process.env.ORKESTR_CODEX_APP_SERVER_SOCKET || "",
};
initialState.spawnCount = (initialState.spawnCount || 0) + 1;
writeState(initialState);

const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  const params = message.params || {};
  const state = readState();
  state.threads ||= [];
  state.calls ||= [];
  state.calls.push({ method: message.method || "", params });
  writeState(state);
  if (message.method === "initialize") return send({ id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const thread = { id: "thr_" + String(state.threads.length + 1).padStart(3, "0"), sessionId: "sess_001", name: "", preview: "", cwd: params.cwd || "", status: { type: "idle" }, loaded: true, turns: [] };
    state.threads.push(thread);
    writeState(state);
    send({ id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "thread/name/set") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (thread) thread.name = params.name;
    writeState(state);
    return send({ id, result: {} });
  }
  if (message.method === "thread/list") return send({ id, result: { data: state.threads.map(({ turns, loaded, ...thread }) => ({ ...thread, status: loaded ? (thread.status || { type: "idle" }) : { type: "notLoaded" } })), nextCursor: null } });
  if (message.method === "thread/read") return send({ id, result: { thread: state.threads.find((item) => item.id === params.threadId) || { id: params.threadId, turns: [] } } });
  if (message.method === "thread/resume") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (!thread) return send({ id, error: { code: -32000, message: "thread not found: " + params.threadId } });
    thread.loaded = true;
    thread.status = { type: "idle" };
    writeState(state);
    return send({ id, result: { thread } });
  }
  if (message.method === "thread/unsubscribe") return send({ id, result: { status: "unsubscribed" } });
  if (message.method === "thread/archive") return send({ id, result: {} });
  if (message.method === "turn/interrupt") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (thread) thread.status = { type: "idle" };
    writeState(state);
    return send({ id, result: { interrupted: true, turnId: params.turnId } });
  }
  if (message.method === "turn/start") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (!thread || !thread.loaded) return send({ id, error: { code: -32000, message: "thread not found: " + params.threadId } });
    const requestedStatus = process.env.FAKE_CODEX_TURN_STATUS || "completed";
    state.nextTurnNumber = (state.nextTurnNumber || 0) + 1;
    const turn = { id: "turn_" + String(state.nextTurnNumber).padStart(6, "0"), threadId: params.threadId, status: "inProgress", items: [] };
    const text = params.input?.find((item) => item.type === "text")?.text || "";
    const user = { type: "userMessage", id: "user_" + turn.id, content: [{ type: "text", text }] };
    const agent = { type: "agentMessage", id: "agent_" + turn.id, text: "Reply to: " + text, phase: "final_answer" };
    turn.items = requestedStatus === "interrupted" ? [user] : [user, agent];
    thread.turns.push(turn);
    writeState(state);
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    if (requestedStatus !== "interrupted") send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: agent } });
    turn.status = requestedStatus;
    thread.status = { type: "idle" };
    writeState(state);
    send({ method: "turn/completed", params: { turn: { ...turn, status: requestedStatus, error: requestedStatus === "interrupted" ? { message: "Conversation interrupted - tell the model what to do differently." } : null } } });
    return;
  }
  send({ id, result: {} });
});
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);
  return { bin, stateFile };
}

async function createFakeCodexWebSocketServer(socketPath) {
  await fs.rm(socketPath, { force: true }).catch(() => {});
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  const state = { threads: [], calls: [] };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const send = (ws, message) => ws.send(JSON.stringify(message));
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw || ""));
      const id = message.id;
      const params = message.params || {};
      state.calls.push({ method: message.method || "", params });
      if (message.method === "initialize") return send(ws, { id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
      if (message.method === "initialized") return;
      if (message.method === "thread/start") {
        const thread = { id: "thr_" + String(state.threads.length + 1).padStart(3, "0"), sessionId: "sess_001", name: "", preview: "", cwd: params.cwd || "", status: { type: "idle" }, loaded: true, turns: [] };
        state.threads.push(thread);
        send(ws, { id, result: { thread } });
        send(ws, { method: "thread/started", params: { thread } });
        return;
      }
      if (message.method === "thread/name/set") {
        const thread = state.threads.find((item) => item.id === params.threadId);
        if (thread) thread.name = params.name;
        return send(ws, { id, result: {} });
      }
      return send(ws, { id, result: {} });
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    state,
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

async function markAppServerTurnActive(thread, env, turnId = "active-turn") {
  const codexThreadId = thread?.executor?.codexThreadId || thread?.codexThreadId;
  const client = await getCodexAppServerClient({ env, home: env.HOME });
  client.threadStates.set(codexThreadId, {
    ...(client.threadStates.get(codexThreadId) || {}),
    activeTurnId: turnId,
    status: { type: "active", activeFlags: ["running"] },
  });
}

async function waitForAppServerReady(thread, env, attempts = 50) {
  let status = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await getThread(thread.id, env).catch(() => null);
    status = await codexAppServerThreadStatus(current || thread, env);
    if (status.state === "ready") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return status;
}

test("Codex app-server turn params ignore corrupt model and reasoning metadata", () => {
  const previousModel = process.env.ORKESTR_DEFAULT_CODEX_MODEL;
  const previousReasoning = process.env.ORKESTR_DEFAULT_CODEX_REASONING;
  try {
    delete process.env.ORKESTR_DEFAULT_CODEX_MODEL;
    delete process.env.ORKESTR_DEFAULT_CODEX_REASONING;
    const thread = {
      id: "corrupt-metadata-thread",
      codexThreadId: "codex-thread-1",
      cwd: "/tmp/orkestr-workspace",
      codexModel: "openai",
      codexReasoningEffort: "0",
      executor: {
        metadata: {
          codexModel: "<operator-codex-home>/sessions/2026/05/29/rollout.jsonl",
          codexReasoningEffort: "0",
        },
      },
    };

    assert.equal(modelForThread(thread), "");
    assert.equal(effortForThread(thread), "");
    assert.equal(turnStartParams(thread, { text: "hello" }).model, undefined);
    assert.equal(turnStartParams(thread, { text: "hello" }).effort, undefined);

    const valid = {
      ...thread,
      codexModel: "gpt-5.5",
      codexReasoningEffort: "extra-high",
    };
    assert.equal(modelForThread(valid), "gpt-5.5");
    assert.equal(effortForThread(valid), "xhigh");
    assert.equal(turnStartParams(valid, { text: "hello" }).model, "gpt-5.5");
    assert.equal(turnStartParams(valid, { text: "hello" }).effort, "xhigh");
  } finally {
    if (previousModel === undefined) delete process.env.ORKESTR_DEFAULT_CODEX_MODEL;
    else process.env.ORKESTR_DEFAULT_CODEX_MODEL = previousModel;
    if (previousReasoning === undefined) delete process.env.ORKESTR_DEFAULT_CODEX_REASONING;
    else process.env.ORKESTR_DEFAULT_CODEX_REASONING = previousReasoning;
  }
});

test("Codex app-server turn params include prompt file inputs", () => {
  const thread = { codexThreadId: "codex-thread-1", cwd: "/tmp/orkestr-workspace" };

  assert.equal(
    turnStartParams(thread, { text: "", promptFile: "/tmp/magie-daily.md" }).input[0].text,
    "Run the prompt file: /tmp/magie-daily.md",
  );
  assert.equal(
    turnStartParams(thread, { text: "Run daily checker", promptFile: "/tmp/magie-daily.md" }).input[0].text,
    "Run daily checker\n\nPrompt file: /tmp/magie-daily.md",
  );
});

test("Codex app-server clamps non-admin threads away from root danger access", () => {
  const previousSandbox = process.env.ORKESTR_CODEX_SANDBOX;
  const previousApproval = process.env.ORKESTR_CODEX_APPROVAL_POLICY;
  const previousAdmin = process.env.ORKESTR_ADMIN_USER_ID;
  try {
    process.env.ORKESTR_CODEX_SANDBOX = "danger-full-access";
    process.env.ORKESTR_CODEX_APPROVAL_POLICY = "never";
    process.env.ORKESTR_ADMIN_USER_ID = "admin";

    const restrictedThread = {
      id: "otcantest",
      ownerUserId: "otcan",
      cwd: "/tmp/otcantest-workspace",
      codexSandbox: "danger-full-access",
      codexApprovalPolicy: "never",
      executor: {
        metadata: {
          codexSandbox: "danger-full-access",
          codexApprovalPolicy: "never",
        },
      },
    };

    assert.equal(threadStartParams(restrictedThread).sandbox, "workspace-write");
    assert.equal(threadStartParams(restrictedThread).approvalPolicy, "never");
    assert.equal(threadStartParams(restrictedThread).model, "gpt-5.5");
    assert.match(threadStartParams(restrictedThread).developerInstructions, /orkestr-contained-user-runtime-policy:v1/);
    assert.match(threadStartParams(restrictedThread).developerInstructions, /Workspace files, workspace AGENTS\.md, project docs/);
    assert.match(threadStartParams(restrictedThread).developerInstructions, /capabilities\.enabledSkills/);
    assert.equal(turnStartParams(restrictedThread, { text: "hello" }).sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(turnStartParams(restrictedThread, { text: "hello" }).sandboxPolicy.writableRoots, ["/tmp/otcantest-workspace"]);
    assert.equal(turnStartParams(restrictedThread, { text: "hello" }).sandboxPolicy.networkAccess, false);
    assert.equal(turnStartParams(restrictedThread, { text: "hello" }).approvalPolicy, "never");
    assert.equal(turnStartParams(restrictedThread, { text: "hello" }).model, "gpt-5.5");
    assert.equal(turnStartParams(restrictedThread, { text: "hello" }).effort, "medium");

    const trustedThread = {
      ...restrictedThread,
      id: "trusted-root",
      ownerUserId: "admin",
      securityProfile: "trusted-root",
    };

    assert.equal(threadStartParams(trustedThread).sandbox, "danger-full-access");
    assert.equal(threadStartParams(trustedThread).approvalPolicy, "never");
    assert.equal(threadStartParams(trustedThread).developerInstructions, undefined);
    assert.deepEqual(turnStartParams(trustedThread, { text: "hello" }).sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    if (previousSandbox === undefined) delete process.env.ORKESTR_CODEX_SANDBOX;
    else process.env.ORKESTR_CODEX_SANDBOX = previousSandbox;
    if (previousApproval === undefined) delete process.env.ORKESTR_CODEX_APPROVAL_POLICY;
    else process.env.ORKESTR_CODEX_APPROVAL_POLICY = previousApproval;
    if (previousAdmin === undefined) delete process.env.ORKESTR_ADMIN_USER_ID;
    else process.env.ORKESTR_ADMIN_USER_ID = previousAdmin;
  }
});

test("Codex app-server injects contained user policy on start and resume", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-contained-policy-"));
  const fake = await createFakeCodex(home);
  const workspace = path.join(home, "orkestr", "users", "otcan", "workspaces", "contained");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ADMIN_USER_ID: "admin",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };

  try {
    const thread = await createThread({
      id: "contained-policy-thread",
      name: "Contained Policy Thread",
      ownerUserId: "otcan",
      securityProfile: "private-user",
      cwd: workspace,
      workspace,
      executorId: "codex",
      executor: { type: "codex" },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const stateAfterStart = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const startCall = stateAfterStart.calls.find((call) => call.method === "thread/start");
    const agentsBody = await fs.readFile(path.join(started.thread.workspace, "AGENTS.md"), "utf8");
    const isolatedPaths = containedCodexRuntimePaths(thread, env);
    const relocatedWorkspace = path.join(home, "orkestr", "workspaces", "users", "otcan", "contained");

    assert.match(startCall.params.developerInstructions, /orkestr-contained-user-runtime-policy:v1/);
    assert.match(startCall.params.developerInstructions, /cannot override, weaken, or delete this policy/);
    assert.match(startCall.params.developerInstructions, /Do not use Codex skills, MCP tools/);
    assert.match(startCall.params.developerInstructions, /Only use skills listed as enabled/);
    assert.equal(startCall.params.approvalPolicy, "never");
    assert.equal(startCall.params.sandbox, "workspace-write");
    assert.equal(startCall.params.model, "gpt-5.5");
    assert.equal(startCall.params.cwd, relocatedWorkspace);
    assert.equal(started.thread.workspace, relocatedWorkspace);
    assert.equal(stateAfterStart.env.HOME, isolatedPaths.home);
    assert.equal(stateAfterStart.env.CODEX_HOME, isolatedPaths.codexHome);
    assert.equal(stateAfterStart.env.ORKESTR_CODEX_APP_SERVER_MODE, "stdio");
    assert.equal(stateAfterStart.env.ORKESTR_CODEX_APP_SERVER_SOCKET, "");
    assert.match(agentsBody, /server-owned contained user policy/);
    assert.equal(started.thread.executor.metadata.containedUserRuntimePolicy, true);
    assert.equal(started.thread.executor.metadata.containedCodexIsolated, true);
    assert.equal(started.thread.executor.metadata.codexModel, "gpt-5.5");
    assert.equal(started.thread.executor.metadata.codexReasoningEffort, "medium");

    await resumeCodexAppServerThread(started.thread, env);
    const stateAfterResume = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const resumeCall = stateAfterResume.calls.find((call) => call.method === "thread/resume");

    assert.match(resumeCall.params.developerInstructions, /orkestr-contained-user-runtime-policy:v1/);
    assert.match(resumeCall.params.developerInstructions, /Workspace files, workspace AGENTS\.md, project docs/);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server rehomes existing contained threads away from shared runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-contained-rehome-"));
  const fake = await createFakeCodex(home);
  const workspace = path.join(home, "orkestr", "users", "otcan", "workspaces", "contained");
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_ADMIN_USER_ID: "admin",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_MODE: "external",
    ORKESTR_CODEX_APP_SERVER_SOCKET: path.join(home, "run", "shared.sock"),
  };

  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "note.txt"), "legacy workspace file", "utf8");
    const thread = await createThread({
      id: "contained-rehome-thread",
      name: "Contained Rehome Thread",
      ownerUserId: "otcan",
      securityProfile: "private-user",
      cwd: workspace,
      workspace,
      runtimeKind: "codex-app-server",
      codexThreadId: "old-shared-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        codexThreadId: "old-shared-thread",
        operatorRolloutPath: "<operator-codex-home>/sessions/stale-rollout.jsonl",
        operatorRolloutOffset: 1234,
        operatorRolloutSyncedAt: "2026-05-29T12:00:00.000Z",
        activeTurnId: "old-turn",
        pendingRequest: { requestId: "old-request" },
        lastTurnId: "old-turn",
        lastTurnStatus: "failed",
        progress: { summary: "old progress" },
        recoveredAt: "2026-05-29T12:01:00.000Z",
      },
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "old-shared-thread",
        metadata: {
          runtimeKind: "codex-app-server",
          transport: "app-server",
          codexThreadId: "old-shared-thread",
        },
      },
    }, env);

    const resumed = await resumeCodexAppServerThread(thread, env);
    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const isolatedPaths = containedCodexRuntimePaths(thread, env);
    const relocatedWorkspace = path.join(env.ORKESTR_HOME, "workspaces", "users", "otcan", "contained");
    const startCall = state.calls.find((call) => call.method === "thread/start");

    assert.equal(resumed.thread.executor.codexThreadId, "thr_001");
    assert.equal(resumed.thread.executor.metadata.containedCodexIsolated, true);
    assert.equal(resumed.thread.workspace, relocatedWorkspace);
    assert.equal(resumed.thread.cwd, relocatedWorkspace);
    assert.equal(startCall.params.cwd, relocatedWorkspace);
    assert.equal(await fs.readFile(path.join(relocatedWorkspace, "note.txt"), "utf8"), "legacy workspace file");
    assert.equal(state.calls.some((call) => call.method === "thread/resume"), false);
    assert.equal(state.calls.some((call) => call.method === "thread/start"), true);
    assert.equal(state.env.HOME, isolatedPaths.home);
    assert.equal(state.env.CODEX_HOME, isolatedPaths.codexHome);
    assert.equal(state.env.ORKESTR_CODEX_APP_SERVER_MODE, "stdio");
    assert.equal(state.env.ORKESTR_CODEX_APP_SERVER_SOCKET, "");
    assert.equal(resumed.thread.runtime.operatorRolloutPath, undefined);
    assert.equal(resumed.thread.runtime.operatorRolloutOffset, undefined);
    assert.equal(resumed.thread.runtime.operatorRolloutSyncedAt, undefined);
    assert.equal(resumed.thread.runtime.activeTurnId, undefined);
    assert.equal(resumed.thread.runtime.pendingRequest, undefined);
    assert.equal(resumed.thread.runtime.lastTurnId, undefined);
    assert.equal(resumed.thread.runtime.lastTurnStatus, undefined);
    assert.equal(resumed.thread.runtime.progress, undefined);
    assert.equal(resumed.thread.runtime.recoveredAt, undefined);

    const contaminated = await updateThread(resumed.thread.id, {
      runtime: {
        ...(resumed.thread.runtime || {}),
        operatorRolloutPath: "<operator-codex-home>/sessions/stale-after-rehome.jsonl",
        operatorRolloutOffset: 456,
        operatorRolloutSyncedAt: "2026-05-29T12:02:00.000Z",
        activeTurnId: "old-current-turn",
        pendingRequest: { requestId: "old-current-request" },
        lastTurnId: "old-current-turn",
        lastTurnStatus: "completed",
        progress: { summary: "stale contained progress" },
        recoveredAt: "2026-05-29T12:03:00.000Z",
      },
    }, env);
    const resumedAgain = await resumeCodexAppServerThread(contaminated, env);
    const stateAfterCurrentResume = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(stateAfterCurrentResume.calls.some((call) => call.method === "thread/resume"), true);
    assert.equal(resumedAgain.thread.runtime.operatorRolloutPath, undefined);
    assert.equal(resumedAgain.thread.runtime.operatorRolloutOffset, undefined);
    assert.equal(resumedAgain.thread.runtime.operatorRolloutSyncedAt, undefined);
    assert.equal(resumedAgain.thread.runtime.activeTurnId, null);
    assert.equal(resumedAgain.thread.runtime.pendingRequest, undefined);
    assert.equal(resumedAgain.thread.runtime.lastTurnId, undefined);
    assert.equal(resumedAgain.thread.runtime.lastTurnStatus, undefined);
    assert.equal(resumedAgain.thread.runtime.progress, undefined);
    assert.equal(resumedAgain.thread.runtime.recoveredAt, undefined);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server client can use an external proxy socket", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-proxy-"));
  const fake = await createFakeCodex(home);
  const socket = path.join(home, "run", "codex.sock");
  const server = await createFakeCodexWebSocketServer(socket);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_CODEX_APP_SERVER_MODE: "external",
    ORKESTR_CODEX_APP_SERVER_SOCKET: socket,
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };

  try {
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    assert.equal(client.transport, "websocket");
    assert.equal(client.socket, socket);
    const thread = await createThread({ id: "proxy-thread", name: "Proxy Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const status = await codexAppServerThreadStatus(started.thread, env);
    assert.equal(status.codexAppServerTransport, "websocket");
    assert.equal(status.codexAppServerSocket, socket);
    assert.deepEqual(server.state.calls.map((call) => call.method), ["initialize", "initialized", "thread/start", "thread/name/set"]);
  } finally {
    stopCodexAppServerClients();
    await server.close();
  }
});

test("Codex app-server client starts once when shared concurrently", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-concurrent-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };

  try {
    const clients = await Promise.all(Array.from({ length: 20 }, () => getCodexAppServerClient({ env, home: env.HOME })));
    assert.equal(new Set(clients).size, 1);
    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    assert.equal(state.spawnCount, 1);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server starts threads, delivers input, and imports existing threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-thread", name: "App Server Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    assert.equal(started.thread.executor.transport, "app-server");
    assert.equal(started.thread.executor.codexThreadId, "thr_001");

    await enqueueThreadInput(thread.id, { text: "hello app server" }, env);
    const delivered = await deliverCodexAppServerPendingInputs(started.thread, env);
    const messages = await listThreadMessages(thread.id, env);
    assert.equal(delivered.length, 1);
    assert.ok(messages.some((message) => message.source === "codex-app-server" && /Reply to: hello app server/.test(message.text)));
    await waitForAppServerReady(started.thread, env);

    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-turn",
      },
    }, env);
    await enqueueThreadInput(started.thread.id, { text: "ignore stale persisted active turn" }, env);
    const staleDelivery = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const staleMessages = await listThreadMessages(started.thread.id, env);
    assert.equal(staleDelivery.length, 1);
    assert.ok(staleMessages.some((message) => message.source === "codex-app-server" && /Reply to: ignore stale persisted active turn/.test(message.text)));

    const whatsappThread = await createThread({
      id: "app-server-whatsapp-thread",
      name: "App Server WhatsApp Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
      binding: {
        connector: "whatsapp",
        chatId: "chat-1",
        responderAccountId: "account-1",
      },
    }, env);
    const startedWhatsApp = await startCodexAppServerThread(whatsappThread, env);
    const inbound = await enqueueThreadInput(startedWhatsApp.thread.id, {
      text: "whatsapp ping",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-1",
      accountId: "account-1",
    }, env);
    await deliverCodexAppServerPendingInputs(await getThread(startedWhatsApp.thread.id, env), env);
    const whatsappMessages = await listThreadMessages(startedWhatsApp.thread.id, env);
    const whatsappReply = whatsappMessages.find((message) => message.source === "codex-app-server" && /Reply to: whatsapp ping/.test(message.text));
    assert.ok(whatsappReply);
    assert.equal(whatsappReply.parentMessageId, inbound.id);
    assert.equal(whatsappReply.connector, "whatsapp");
    assert.equal(whatsappReply.chatId, "chat-1");
    assert.equal(whatsappReply.accountId, "account-1");
    assert.equal(whatsappReply.originSurface, "codex");
    assert.equal(whatsappReply.originTransport, "codex-app-server");
    assert.equal(whatsappReply.executorKind, "codex");
    assert.equal(whatsappReply.executorTransport, "app-server");
    assert.equal(whatsappReply.executorThreadId, startedWhatsApp.thread.executor.codexThreadId);
    assert.equal(whatsappReply.codexThreadId, startedWhatsApp.thread.executor.codexThreadId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const status = await codexAppServerThreadStatus(await getThread(startedWhatsApp.thread.id, env), env);
      if (status.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const attachmentPath = path.join(home, "fitness-label.jpg");
    await fs.writeFile(attachmentPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await enqueueThreadInput(startedWhatsApp.thread.id, {
      text: "add this too",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-1",
      accountId: "account-1",
      attachments: [{ path: attachmentPath, filename: "fitness-label.jpg", mimetype: "image/jpeg", kind: "image" }],
    }, env);
    await deliverCodexAppServerPendingInputs(startedWhatsApp.thread, env);
    const attachmentMessages = await listThreadMessages(startedWhatsApp.thread.id, env);
    assert.ok(attachmentMessages.some((message) =>
      message.source === "codex-app-server" &&
      /Reply to: add this too/.test(message.text) &&
      String(message.text || "").includes(`Attachment 1: ${attachmentPath}`)
    ));
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
    const whatsappCalls = [];
    const whatsappDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
      whatsappCalls.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, ids: ["sent-app-server-reply"] });
    });
    assert.equal(whatsappDelivery.delivered.length, 2);
    assert.equal(whatsappCalls.length, 2);
    assert.equal(whatsappCalls[0].url.pathname, "/send-text");
    assert.equal(whatsappCalls[0].body.to, "chat-1");
    assert.equal(whatsappCalls[0].body.accountId, "account-1");
    assert.ok(whatsappCalls.some((call) => /Reply to: whatsapp ping/.test(call.body.text)));
    assert.ok(whatsappCalls.some((call) => call.body.text.includes(`Attachment 1: ${attachmentPath}`)));

    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    rawState.threads.push({
      id: "old_cli_001",
      sessionId: "old_cli_001",
      name: "Old CLI Thread",
      preview: "Imported old CLI session",
      cwd: home,
      status: { type: "notLoaded" },
      loaded: false,
      turns: [],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2), "utf8");
    const sleeping = await createThread({
      id: "sleeping-app-server-thread",
      name: "Sleeping App Server Thread",
      state: "sleeping",
      cwd: home,
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "old_cli_001",
        codexSessionId: "old_cli_001",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "old_cli_001",
      codexSessionId: "old_cli_001",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "sleeping",
      },
      lastError: "thread not found: old_cli_001",
    }, env);
    await enqueueThreadInput(sleeping.id, { text: "resume before send" }, env);
    const resumedDelivery = await deliverCodexAppServerPendingInputs(sleeping, env);
    const resumedThread = await getThread(sleeping.id, env);
    const resumedMessages = await listThreadMessages(sleeping.id, env);
    assert.equal(resumedDelivery.length, 1);
    assert.equal(resumedThread.state, "ready");
    assert.equal(resumedThread.lastError, null);
    let resumedStatus = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      resumedStatus = await codexAppServerThreadStatus({
        ...resumedThread,
        runtime: { ...(resumedThread.runtime || {}), activeTurnId: "stale-turn" },
      }, env);
      if (resumedStatus.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(resumedStatus.state, "ready");
    assert.equal(resumedStatus.activeTurnId, null);
    assert.ok(resumedMessages.some((message) => message.source === "codex-app-server" && /Reply to: resume before send/.test(message.text)));
    stopCodexAppServerClients();
    const coldStatus = await codexAppServerThreadStatus({
      ...resumedThread,
      runtime: {
        ...(resumedThread.runtime || {}),
        activeTurnId: "stale-turn",
        codexStatus: { type: "idle" },
      },
    }, env);
    assert.equal(coldStatus.state, "ready");
    assert.equal(coldStatus.activeTurnId, null);

    const staleThread = await createThread({ id: "app-server-stale-turn-thread", name: "App Server Stale Turn Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const startedStale = await startCodexAppServerThread(staleThread, env);
    await updateThread(startedStale.thread.id, {
      runtime: { ...(startedStale.thread.runtime || {}), activeTurnId: "stale-turn", state: "working" },
    }, env);
    await enqueueThreadInput(startedStale.thread.id, { text: "recover stale turn" }, env);
    const staleDelivered = await deliverCodexAppServerPendingInputs({
      ...startedStale.thread,
      runtime: { ...(startedStale.thread.runtime || {}), activeTurnId: "stale-turn", state: "working" },
    }, env);
    const staleTurnMessages = await listThreadMessages(startedStale.thread.id, env);
    const staleInput = staleTurnMessages.find((message) => message.role === "user" && /recover stale turn/.test(message.text));
    const staleReply = staleTurnMessages.find((message) => message.source === "codex-app-server" && /Reply to: recover stale turn/.test(message.text));
    assert.equal(staleDelivered.length, 1);
    assert.equal(staleInput.state, "completed");
    assert.equal(staleInput.observedVia, "codex_app_server_turn_start");
    assert.ok(staleReply);

    const listed = await listCodexAppServerThreads({}, env);
    assert.equal(listed.data.length, 4);
    await createThread({
      id: "legacy-codex-thread",
      name: "Legacy Codex Thread",
      cwd: home,
      executor: { type: "codex", codexThreadId: "legacy_codex_001" },
      runtime: { sessionName: "orkestr-legacy-codex-thread", state: "ready" },
    }, env);
    const dryRun = await migrateCodexThreadsToAppServer({ dryRun: true }, env);
    assert.equal(dryRun.counts.mark_existing_codex_thread, 1);
    const migration = await migrateCodexThreadsToAppServer({}, env);
    assert.equal(migration.counts.migrated_existing_codex_thread, 1);
    const migrated = await getThread("legacy-codex-thread", env);
    assert.equal(migrated.runtimeKind, "codex-app-server");
    assert.equal(migrated.executor.transport, "app-server");
    assert.equal(migrated.executor.codexThreadId, "legacy_codex_001");

    const imported = await importCodexAppServerThread("thr_001", { id: "imported-thread", name: "Imported Thread" }, { ...env, ORKESTR_HOME: path.join(home, "imported-home") });
    const importedMessages = await listThreadMessages(imported.thread.id, { ...env, ORKESTR_HOME: path.join(home, "imported-home") });
    assert.equal(imported.imported, true);
    assert.equal(imported.thread.state, "unloaded");
    assert.ok(importedMessages.some((message) => message.source === "codex-app-server-import"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server records bare mode commands locally", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-mode-command-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-mode-command-thread", name: "Mode Command Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const planInput = await enqueueThreadInput(started.thread.id, { text: "/plan", source: "whatsapp_inbound", connector: "whatsapp", chatId: "chat-mode" }, env);

    const planDelivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const afterPlan = await getThread(started.thread.id, env);
    const planMessages = await listThreadMessages(started.thread.id, env);
    const completedPlan = planMessages.find((message) => message.id === planInput.id);
    let rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(planDelivered, [planInput.id]);
    assert.equal(afterPlan.codexMode, "plan");
    assert.equal(afterPlan.codexModeSource, "orkestr-command");
    assert.equal(completedPlan.state, "completed");
    assert.equal(completedPlan.deliveryState, "delivered");
    assert.equal(completedPlan.observedVia, "codex_app_server_mode_recorded");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start"));

    const codeInput = await enqueueThreadInput(started.thread.id, { text: "/code", source: "whatsapp_inbound", connector: "whatsapp", chatId: "chat-mode" }, env);
    const codeDelivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const afterCode = await getThread(started.thread.id, env);
    const codeMessages = await listThreadMessages(started.thread.id, env);
    const completedCode = codeMessages.find((message) => message.id === codeInput.id);
    rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(codeDelivered, [codeInput.id]);
    assert.equal(afterCode.codexMode, "code");
    assert.equal(afterCode.codexModeSource, "orkestr-command");
    assert.equal(completedCode.state, "completed");
    assert.equal(completedCode.deliveryState, "delivered");
    assert.equal(completedCode.observedVia, "codex_app_server_mode_recorded");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server strips mode commands before sending payload turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-mode-payload-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-mode-payload-thread", name: "Mode Payload Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const input = await enqueueThreadInput(started.thread.id, {
      text: "/plan write the migration steps",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-mode-payload",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const afterDelivery = await getThread(started.thread.id, env);
    const messages = await listThreadMessages(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);
    const reply = messages.find((message) => message.source === "codex-app-server" && /Reply to: write the migration steps/.test(message.text));
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const turnStart = rawState.calls.find((call) => call.method === "turn/start");

    assert.deepEqual(delivered, [input.id]);
    assert.equal(afterDelivery.codexMode, "plan");
    assert.equal(afterDelivery.codexModeSource, "orkestr-command");
    assert.equal(completed.text, "write the migration steps");
    assert.equal(completed.state, "completed");
    assert.equal(completed.deliveryState, "delivered");
    assert.equal(completed.observedVia, "codex_app_server_turn_start");
    assert.ok(reply);
    assert.equal(turnStart.params.input.find((item) => item.type === "text").text, "write the migration steps");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server ignores overlapping delivery attempts for the same queued input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-delivery-lock-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-delivery-lock-thread", name: "Delivery Lock Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const input = await enqueueThreadInput(thread.id, { text: "deliver once" }, env);

    const results = await Promise.all([
      deliverCodexAppServerPendingInputs(started.thread, env),
      deliverCodexAppServerPendingInputs(started.thread, env),
    ]);
    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const messages = await listThreadMessages(thread.id, env);
    const deliveredMessage = messages.find((message) => message.id === input.id);

    assert.deepEqual(results.flat(), [input.id]);
    assert.equal(state.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(deliveredMessage.state, "completed");
    assert.equal(deliveredMessage.deliveryState, "delivered");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server does not reclaim a recent cross-process delivery claim", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-delivery-claim-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_INPUT_CLAIM_STALE_MS: "60000",
  };
  try {
    const thread = await createThread({ id: "app-server-delivery-claim-thread", name: "Delivery Claim Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const input = await enqueueThreadInput(thread.id, { text: "claimed elsewhere" }, env);
    await updateThreadMessage(thread.id, input.id, {
      state: "pending_delivery",
      deliveryState: "codex_app_server_sending",
      deliveryLastAttemptAt: new Date().toISOString(),
      deliveryClaimId: "other-process",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(started.thread, env);
    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const messages = await listThreadMessages(thread.id, env);
    const claimed = messages.find((message) => message.id === input.id);

    assert.deepEqual(delivered, []);
    assert.equal(claimed.state, "pending_delivery");
    assert.equal(claimed.deliveryClaimId, "other-process");
    assert.equal(state.calls.filter((call) => call.method === "turn/start").length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server sends short chat replies to pending user-input requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-user-input-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-user-input-thread", name: "User Input Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    const responses = [];
    client.respond = (id, result) => responses.push({ id, result });
    const request = {
      requestId: "ask-continue",
      method: "item/tool/requestUserInput",
      threadId: started.thread.id,
      codexThreadId: codexId,
      params: {
        questions: [
          {
            id: "nextAction",
            question: "Continue with the LinkedIn send?",
            options: [{ label: "Go" }, { label: "Stop" }],
          },
        ],
      },
    };
    client.pendingRequests.set(request.requestId, request);
    await updateThread(started.thread.id, {
      state: "awaiting_approval",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "awaiting_approval",
        pendingRequest: request,
      },
    }, env);
    const input = await enqueueThreadInput(started.thread.id, { text: "go", source: "manual" }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, [input.id]);
    assert.deepEqual(responses, [{ id: "ask-continue", result: { answers: { nextAction: "Go" } } }]);
    assert.equal(completed.state, "completed");
    assert.equal(completed.deliveryState, "delivered");
    assert.equal(completed.observedVia, "codex_app_server_user_input");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server auto-accepts command approvals for YOLO threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-yolo-approval-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({
      id: "app-server-yolo-approval-thread",
      name: "YOLO Approval Thread",
      cwd: home,
      codexSandbox: "danger-full-access",
      codexApprovalPolicy: "never",
      executorId: "codex",
      executor: {
        type: "codex",
        metadata: {
          codexSandbox: "danger-full-access",
          codexApprovalPolicy: "never",
        },
      },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    const writes = [];
    client.write = (payload) => writes.push(payload);

    await client.handleServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: started.thread.executor.codexThreadId,
        turnId: "turn-yolo",
        itemId: "call-yolo",
        command: ["git", "status", "--short"],
        cwd: home,
      },
    });

    const updated = await getThread(started.thread.id, env);
    const messages = await listThreadMessages(started.thread.id, env);

    assert.deepEqual(writes, [{ id: 7, result: { decision: "accept" } }]);
    assert.equal(client.pendingRequests.has("7"), false);
    assert.notEqual(updated.state, "awaiting_approval");
    assert.equal(updated.runtime?.pendingRequest, undefined);
    assert.equal(messages.some((message) => message.phase === "awaiting_approval"), false);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server completed turns clear persisted approval requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-complete-clears-approval-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-complete-clears-approval-thread", name: "Complete Clears Approval Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const request = {
      requestId: "approval-before-completion",
      method: "item/commandExecution/requestApproval",
      threadId: started.thread.id,
      codexThreadId: started.thread.executor.codexThreadId,
      turnId: "turn-clears-approval",
      itemId: "call-clears-approval",
    };
    await updateThread(started.thread.id, {
      state: "awaiting_approval",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "awaiting_approval",
        activeTurnId: "turn-clears-approval",
        pendingRequest: request,
        codexStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    }, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });

    await client.handleNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-clears-approval",
          threadId: started.thread.executor.codexThreadId,
          status: "completed",
          error: null,
        },
      },
    });

    const updated = await getThread(started.thread.id, env);

    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.pendingRequest, null);
    assert.equal(updated.runtime.activeTurnId, null);
    assert.deepEqual(updated.runtime.codexStatus, { type: "idle" });
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server approval helper refuses stale persisted requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-approval-helper-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-approval-helper-thread",
      name: "Stale Approval Helper Thread",
      state: "awaiting_approval",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-approval-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-approval-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "awaiting_approval",
        pendingRequest: {
          requestId: "stale-approval-request",
          method: "item/commandExecution/requestApproval",
          threadId: "app-server-stale-approval-helper-thread",
          codexThreadId: "stale-approval-codex-thread",
        },
        codexStatus: { type: "active", activeFlags: [] },
      },
    }, env);

    const result = await answerCodexAppServerPendingRequest(thread, { decision: "accept" }, env);
    const updated = await getThread(thread.id, env);

    assert.equal(result.answered, false);
    assert.equal(result.reason, "no_pending_request");
    assert.equal(updated.runtime.pendingRequest, null);
    assert.equal(updated.state, "ready");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server mirrors interrupted turns to the thread and WhatsApp", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-interrupted-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    FAKE_CODEX_TURN_STATUS: "interrupted",
  };
  try {
    const thread = await createThread({
      id: "app-server-interrupted-thread",
      name: "App Server Interrupted Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
      binding: {
        connector: "whatsapp",
        chatId: "chat-interrupted-app-server",
        responderAccountId: "account-1",
      },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const inbound = await enqueueThreadInput(started.thread.id, {
      text: "run interrupted work",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-interrupted-app-server",
      accountId: "account-1",
    }, env);

    await deliverCodexAppServerPendingInputs(started.thread, env);
    let notice = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const messages = await listThreadMessages(started.thread.id, env);
      notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
      if (notice) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(notice);
    assert.match(notice.text, /^Codex conversation interrupted/);
    assert.doesNotMatch(notice.text, /\/now/);
    assert.equal(notice.parentMessageId, inbound.id);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-interrupted-app-server");
    assert.equal(notice.accountId, "account-1");

    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
    const calls = [];
    const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, ids: ["sent-interrupted-app-server"] });
    });

    assert.equal(delivery.delivered.length, 1);
    assert.equal(delivery.delivered[0].deliveryType, "router_update");
    assert.equal(calls[0].body.to, "chat-interrupted-app-server");
    assert.match(calls[0].body.text, /^Codex conversation interrupted/);
    assert.doesNotMatch(calls[0].body.text, /\/now/);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server mirrors interrupted bound threads without a WhatsApp parent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-bound-interrupted-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    FAKE_CODEX_TURN_STATUS: "interrupted",
  };
  try {
    const thread = await createThread({
      id: "app-server-bound-interrupted-thread",
      name: "App Server Bound Interrupted Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
      binding: {
        connector: "whatsapp",
        chatId: "chat-bound-interrupted",
        responderAccountId: "account-bound",
      },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    await enqueueThreadInput(started.thread.id, {
      text: "run interrupted work from the web ui",
      source: "manual",
    }, env);

    await deliverCodexAppServerPendingInputs(started.thread, env);
    let notice = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const messages = await listThreadMessages(started.thread.id, env);
      notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
      if (notice) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(notice);
    assert.equal(notice.parentMessageId, null);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-bound-interrupted");
    assert.equal(notice.accountId, "account-bound");

    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
    const calls = [];
    const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, ids: ["sent-bound-interrupted-app-server"] });
    });

    assert.equal(delivery.delivered.length, 1);
    assert.equal(delivery.delivered[0].deliveryType, "router_update");
    assert.equal(calls[0].body.to, "chat-bound-interrupted");
    assert.match(calls[0].body.text, /^Codex conversation interrupted/);
    assert.doesNotMatch(calls[0].body.text, /\/now/);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server projects orphan bound replies to the WhatsApp binding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-bound-orphan-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  const signals = [];
  const clearSignalHandler = setThreadConnectorDeliverySignalHandler((event) => {
    signals.push(event);
  });
  try {
    consumeThreadConnectorDeliverySignalCount();
    const thread = await createThread({
      id: "app-server-bound-orphan-thread",
      name: "App Server Bound Orphan Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
      binding: {
        connector: "whatsapp",
        chatId: "chat-bound-orphan",
        responderAccountId: "account-bound",
      },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    consumeThreadConnectorDeliverySignalCount();
    await client.projectItem({
      id: "orphan-agent-message",
      type: "agentMessage",
      text: "Reply from an orphan app-server notification.",
      phase: "final_answer",
    }, { threadId: codexId, turnId: "orphan-turn" }, codexId);

    const messages = await listThreadMessages(started.thread.id, env);
    const reply = messages.find((message) => message.source === "codex-app-server" && /orphan app-server/.test(message.text));

    assert.ok(reply);
    assert.equal(reply.parentMessageId, null);
    assert.equal(reply.connector, "whatsapp");
    assert.equal(reply.chatId, "chat-bound-orphan");
    assert.equal(reply.accountId, "account-bound");
    assert.equal(consumeThreadConnectorDeliverySignalCount(), 1);
    assert.equal(signals.filter((event) =>
      event.messageId === reply.id &&
      event.connector === "whatsapp" &&
      event.chatId === "chat-bound-orphan" &&
      event.deliveryState === "completed"
    ).length, 1);

    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
    const calls = [];
    const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, ids: ["sent-bound-orphan-app-server"] });
    });

    assert.equal(delivery.delivered.length, 1);
    assert.equal(delivery.delivered[0].deliveryType, "final");
    assert.equal(calls[0].body.to, "chat-bound-orphan");
    assert.equal(calls[0].body.accountId, "account-bound");
    assert.match(calls[0].body.text, /Reply from an orphan app-server notification/);
  } finally {
    clearSignalHandler();
    stopCodexAppServerClients();
  }
});

test("Codex app-server status ignores stale stored working state without live client state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-working-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const stale = await createThread({
      id: "app-server-stale-working-status-thread",
      name: "App Server Stale Working Status Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-codex-thread",
        codexSessionId: "stale-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-codex-thread",
      codexSessionId: "stale-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-active-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
        endedAt: "2026-05-26T08:18:17.735Z",
      },
    }, env);
    const staleStatus = await codexAppServerThreadStatus(stale, env);

    assert.equal(staleStatus.state, "ready");
    assert.equal(staleStatus.working, false);
    assert.equal(staleStatus.activeTurnId, null);

    const idleActive = await createThread({
      id: "app-server-active-empty-status-thread",
      name: "App Server Active Empty Status Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "empty-active-codex-thread",
        codexSessionId: "empty-active-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "empty-active-codex-thread",
      codexSessionId: "empty-active-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        codexStatus: { type: "active", activeFlags: [] },
        pendingRequest: {
          requestId: "stale-request-after-completion",
          method: "item/commandExecution/requestApproval",
          threadId: "app-server-active-empty-status-thread",
          codexThreadId: "empty-active-codex-thread",
        },
      },
    }, env);
    const idleActiveStatus = await codexAppServerThreadStatus(idleActive, env);
    const idleActiveUpdated = await getThread(idleActive.id, env);

    assert.equal(idleActiveStatus.state, "ready");
    assert.equal(idleActiveStatus.working, false);
    assert.equal(idleActiveStatus.activeTurnId, null);
    assert.equal(idleActiveStatus.pendingRequest, null);
    assert.equal(idleActiveUpdated.runtime.pendingRequest, null);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server status clears stale active client turn after live verification", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-active-status-"));
  const fake = await createFakeCodex(home);
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_VERIFY_MS: "1",
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-active-status-thread",
      name: "App Server Stale Active Status Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set(codexId, {
      activeTurnId: "missed-completion-turn",
      activeTurnObservedAt: staleAt,
      liveStateCheckedAt: staleAt,
      status: { type: "active", activeFlags: ["running"] },
    });
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "missed-completion-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);

    const status = await codexAppServerThreadStatus(await getThread(started.thread.id, env), env);
    const updated = await getThread(started.thread.id, env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(status.state, "ready");
    assert.equal(status.working, false);
    assert.equal(status.activeTurnId, null);
    assert.equal(status.turnLifecycle.sidebarWorking, false);
    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.state, "ready");
    assert.equal(updated.runtime.activeTurnId, null);
    assert.equal(rawState.calls.some((call) => call.method === "thread/read" && call.params?.threadId === codexId), true);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server status clears active turn when Orkestr already has its final answer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-final-answer-status-"));
  const fake = await createFakeCodex(home);
  const activeTurnId = "final-answer-already-stored-turn";
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_VERIFY_MS: "disabled",
  };
  try {
    const thread = await createThread({
      id: "app-server-final-answer-status-thread",
      name: "App Server Final Answer Status Thread",
      cwd: home,
      executorId: "codex",
      executor: { type: "codex" },
    }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set(codexId, {
      activeTurnId,
      activeTurnObservedAt: new Date(Date.now() - 60_000).toISOString(),
      status: { type: "active", activeFlags: ["running"] },
    });
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId,
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    await appendThreadMessage(started.thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      text: "Stored final answer.",
      state: "completed",
      codexThreadId: codexId,
      codexTurnId: activeTurnId,
    }, env);

    const messages = await listThreadMessages(started.thread.id, env);
    const status = await codexAppServerThreadStatus(await getThread(started.thread.id, env), env, { messages });
    const updated = await getThread(started.thread.id, env);

    assert.equal(status.state, "ready");
    assert.equal(status.working, false);
    assert.equal(status.activeTurnId, null);
    assert.equal(status.turnLifecycle.sidebarWorking, false);
    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.state, "ready");
    assert.equal(updated.runtime.activeTurnId, null);
    assert.equal(client.threadStates.get(codexId)?.activeTurnId, "");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server status does not report idle while an active turn is known", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-idle-active-turn-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({
      id: "app-server-idle-active-turn-thread",
      name: "App Server Idle Active Turn Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "idle-active-codex-thread",
        codexSessionId: "idle-active-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "idle-active-codex-thread",
      codexSessionId: "idle-active-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "known-active-turn",
        codexStatus: { type: "idle" },
      },
    }, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set("idle-active-codex-thread", {
      activeTurnId: "known-active-turn",
      status: { type: "idle" },
    });

    const status = await codexAppServerThreadStatus(thread, env);

    assert.equal(status.state, "working");
    assert.equal(status.working, true);
    assert.equal(status.activeTurnId, "known-active-turn");
    assert.equal(status.codexStatus.type, "active");
    assert.deepEqual(status.codexStatus.activeFlags, ["running"]);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server status exposes planning progress for active plan-mode turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-plan-progress-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({
      id: "app-server-plan-progress-thread",
      name: "App Server Plan Progress Thread",
      state: "working",
      codexMode: "plan",
      codexModeSource: "orkestr-command",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "plan-progress-codex-thread",
        codexSessionId: "plan-progress-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "plan-progress-codex-thread",
      codexSessionId: "plan-progress-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "plan-progress-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set("plan-progress-codex-thread", {
      activeTurnId: "plan-progress-turn",
      status: { type: "active", activeFlags: ["running"] },
    });

    const status = await codexAppServerThreadStatus(thread, env);

    assert.equal(status.state, "working");
    assert.equal(status.progress.stateHint, "planning");
    assert.equal(status.progress.summary, "Planning");
    assert.equal(status.turnLifecycle.state, "planning");
    assert.equal(status.turnLifecycle.planning, true);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server active status does not erase live pending approval requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-live-approval-status-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const codexThreadId = "live-approval-codex-thread";
    const thread = await createThread({
      id: "app-server-live-approval-status-thread",
      name: "App Server Live Approval Status Thread",
      state: "awaiting_approval",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId,
        codexSessionId: codexThreadId,
      },
      runtimeKind: "codex-app-server",
      codexThreadId,
      codexSessionId: codexThreadId,
      runtime: {
        runtimeKind: "codex-app-server",
        state: "awaiting_approval",
        activeTurnId: "approval-turn",
      },
    }, env);
    const request = {
      requestId: "approval-request-live",
      method: "item/commandExecution/requestApproval",
      threadId: thread.id,
      codexThreadId,
      turnId: "approval-turn",
      itemId: "approval-item",
    };
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.pendingRequests.set(request.requestId, request);

    await client.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: codexThreadId,
        status: { type: "active", activeFlags: [] },
      },
    });
    const updated = await getThread(thread.id, env);
    const status = await codexAppServerThreadStatus(updated, env);

    assert.equal(client.pendingRequests.has(request.requestId), true);
    assert.equal(updated.state, "awaiting_approval");
    assert.equal(updated.runtime.pendingRequest.requestId, request.requestId);
    assert.deepEqual(updated.runtime.codexStatus.activeFlags, ["waitingOnApproval"]);
    assert.equal(status.state, "awaiting_approval");
    assert.equal(status.turnLifecycle.awaitingApproval, true);
    assert.equal(status.progress.stateHint, "awaiting_approval");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server status normalizes approval flags case-insensitively", () => {
  assert.equal(appServerStateFromStatus({ type: "active", activeFlags: ["waitingOnApproval"] }), "awaiting_approval");
  assert.equal(appServerStateFromStatus({ type: "ACTIVE", activeFlags: ["waiting_on_approval"] }), "awaiting_approval");
});

test("Codex app-server recovery asks app-server before marking an active turn interrupted", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-live-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({ id: "app-server-live-recovery-thread", name: "Live Recovery Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "live-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    await appendThreadMessage(started.thread.id, {
      role: "user",
      source: "manual",
      text: "This active turn has not finished yet.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: codexId,
      codexTurnId: "live-turn",
    }, env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = rawState.threads.find((item) => item.id === codexId);
    codexThread.status = { type: "active", activeFlags: [] };
    codexThread.turns.push({
      id: "live-turn",
      threadId: codexId,
      status: "inProgress",
      items: [
        { type: "userMessage", id: "user_live_turn", content: [{ type: "text", text: "This active turn has not finished yet." }] },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2));
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.delete(codexId);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(started.thread.id, env);
    const status = await codexAppServerThreadStatus(await getThread(started.thread.id, env), env);

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(messages.some((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted"), false);
    assert.equal(status.state, "working");
    assert.equal(status.activeTurnId, "live-turn");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery interrupts stale live active turns with no visible response", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-live-active-timeout-"));
  const fake = await createFakeCodex(home);
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_ACTIVE_TURN_MS: "1",
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS: "0",
  };
  try {
    const thread = await createThread({ id: "app-server-live-active-timeout-thread", name: "Live Active Timeout Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const activeTurnId = "live-active-timeout-turn";
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId,
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    const input = await appendThreadMessage(started.thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-live-active-timeout",
      accountId: "account-live-active-timeout",
      text: "This active turn never produced a visible reply.",
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: staleAt,
      observedVia: "codex_app_server_turn_start",
      codexThreadId: codexId,
      codexTurnId: activeTurnId,
      createdAt: staleAt,
    }, env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = rawState.threads.find((item) => item.id === codexId);
    codexThread.status = { type: "active", activeFlags: [] };
    codexThread.activeTurnId = activeTurnId;
    codexThread.turns.push({
      id: activeTurnId,
      threadId: codexId,
      status: "inProgress",
      items: [
        { type: "userMessage", id: "user_live_active_timeout", content: [{ type: "text", text: "This active turn never produced a visible reply." }] },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2));
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set(codexId, {
      activeTurnId,
      activeTurnObservedAt: staleAt,
      liveStateCheckedAt: staleAt,
      status: { type: "active", activeFlags: ["running"] },
      statusObservedAt: staleAt,
    });

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(started.thread.id, env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
    const updated = await getThread(started.thread.id, env);
    const finalState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(result.recovered, 1);
    assert.equal(result.appended, 1);
    assert.equal(notice.parentMessageId, input.id);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-live-active-timeout");
    assert.match(notice.text, /^Codex response timed out/);
    assert.match(notice.text, /Doctor: no final answer found, no approval pending/);
    assert.match(notice.text, /Action: interrupt the current stale turn/);
    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.state, "ready");
    assert.equal(updated.runtime.activeTurnId, null);
    assert.equal(updated.runtime.codexStatus.type, "idle");
    assert.equal(client.threadStates.get(codexId)?.activeTurnId, "");
    assert.equal(finalState.calls.some((call) => call.method === "thread/read" && call.params?.threadId === codexId), true);
    assert.equal(finalState.calls.some((call) => call.method === "turn/interrupt" && call.params?.threadId === codexId && call.params?.turnId === activeTurnId), true);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery interrupts only the matching stale live active turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-multi-active-timeout-"));
  const fake = await createFakeCodex(home);
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_ACTIVE_TURN_MS: "1",
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS: "0",
  };
  try {
    const thread = await createThread({ id: "app-server-multi-active-timeout-thread", name: "Multi Active Timeout Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "second-live-active-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    await appendThreadMessage(started.thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-multi-active-timeout",
      accountId: "account-multi-active-timeout",
      text: "Newest active turn has no final answer.",
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: staleAt,
      observedVia: "codex_app_server_turn_start",
      codexThreadId: codexId,
      codexTurnId: "second-live-active-turn",
      createdAt: staleAt,
    }, env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = rawState.threads.find((item) => item.id === codexId);
    codexThread.status = { type: "active", activeFlags: [] };
    codexThread.turns.push(
      { id: "first-live-active-turn", threadId: codexId, status: "inProgress", items: [{ type: "userMessage", id: "multi-active-user-1", content: [{ type: "text", text: "Older active turn" }] }] },
      { id: "second-live-active-turn", threadId: codexId, status: "inProgress", items: [{ type: "userMessage", id: "multi-active-user-2", content: [{ type: "text", text: "Newest active turn has no final answer." }] }] },
    );
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2));
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set(codexId, {
      activeTurnId: "second-live-active-turn",
      activeTurnIds: ["second-live-active-turn", "first-live-active-turn"],
      activeTurnObservedAt: staleAt,
      liveStateCheckedAt: staleAt,
      status: { type: "active", activeFlags: ["running"] },
      statusObservedAt: staleAt,
    });

    const result = await recoverStaleCodexAppServerTurns(env);
    const finalState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const interrupted = finalState.calls
      .filter((call) => call.method === "turn/interrupt" && call.params?.threadId === codexId)
      .map((call) => call.params?.turnId)
      .sort();
    const messages = await listThreadMessages(started.thread.id, env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
    const events = (await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const recoveryEvent = events.find((event) => event.type === "codex_app_server_stale_turn_recovered");

    assert.equal(result.recovered, 1);
    assert.deepEqual(interrupted, ["second-live-active-turn"]);
    assert.match(notice.text, /ignored 1 stale cached active turn id/);
    assert.deepEqual(recoveryEvent.interruptedTurnIds, ["second-live-active-turn"]);
    assert.deepEqual(recoveryEvent.skippedCachedActiveTurnIds, ["first-live-active-turn"]);
    assert.equal(recoveryEvent.activeTurnRecoveryTargetId, "second-live-active-turn");
    assert.equal(recoveryEvent.interruptError, null);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery treats unscoped rollout final answers as completed turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-rollout-final-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-rollout-final-recovery-thread",
      name: "Rollout Final Recovery Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "rollout-final-codex-thread",
        codexSessionId: "rollout-final-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "rollout-final-codex-thread",
      codexSessionId: "rollout-final-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "Run the crawler cleanup.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "rollout-final-codex-thread",
      codexTurnId: "rollout-turn",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-rollout",
      phase: "commentary",
      text: "I am still checking the rendered pages.",
      state: "completed",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "Done. The crawler pages now render cleanly.",
      state: "completed",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env, { noticeCause: "orkestr_restart" });
    const messages = await listThreadMessages(thread.id, env);

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(messages.some((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted"), false);
    assert.ok(messages.find((message) => message.id === input.id));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery marks stale delivered turns ready and appends one interruption notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-recovery-thread",
      name: "App Server Stale Recovery Thread",
      state: "failed",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-recovery-codex-thread",
        codexSessionId: "stale-recovery-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-recovery-codex-thread",
      codexSessionId: "stale-recovery-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-turn",
        codexStatus: { type: "systemError" },
        lastTurnStatus: "failed",
      },
    }, env);
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "Please continue this delivered turn.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "stale-recovery-codex-thread",
      codexTurnId: "stale-turn",
    }, env);

    const first = await recoverStaleCodexAppServerTurns(env);
    const after = await getThread(thread.id, env);
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(first.recovered, 1);
    assert.equal(first.appended, 1);
    assert.equal(after.state, "ready");
    assert.equal(after.lastError, null);
    assert.equal(after.runtime.activeTurnId, null);
    assert.equal(after.runtime.state, "ready");
    assert.equal(after.runtime.codexStatus.type, "idle");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].parentMessageId, null);
    assert.equal(notices[0].codexTurnId, "stale-turn");
    assert.match(notices[0].text, /^Codex response missing/);
    assert.match(notices[0].text, /\/safe-reset/);
    assert.doesNotMatch(notices[0].text, /\/now/);
    assert.ok(messages.find((message) => message.id === input.id));

    const second = await recoverStaleCodexAppServerTurns(env);
    const messagesAfterSecond = await listThreadMessages(thread.id, env);
    assert.equal(second.recovered, 0);
    assert.equal(second.appended, 0);
    assert.equal(messagesAfterSecond.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted").length, 1);

    const restartThread = await createThread({
      id: "app-server-restart-recovery-thread",
      name: "App Server Restart Recovery Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "restart-recovery-codex-thread",
        codexSessionId: "restart-recovery-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "restart-recovery-codex-thread",
      codexSessionId: "restart-recovery-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "restart-turn",
      },
    }, env);
    await appendThreadMessage(restartThread.id, {
      role: "user",
      source: "manual",
      text: "This was active during Orkestr restart.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "restart-recovery-codex-thread",
      codexTurnId: "restart-turn",
    }, env);

    const restartRecovery = await recoverStaleCodexAppServerTurns(env, { noticeCause: "orkestr_restart" });
    const restartMessages = await listThreadMessages(restartThread.id, env);
    const restartNotice = restartMessages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(restartRecovery.recovered, 1);
    assert.equal(restartRecovery.appended, 1);
    assert.match(restartNotice.text, /^Orkestr restarted before Codex replied/);
    assert.match(restartNotice.text, /Orkestr restarted after this message reached Codex/);

    const rebootThread = await createThread({
      id: "app-server-host-reboot-recovery-thread",
      name: "App Server Host Reboot Recovery Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "host-reboot-recovery-codex-thread",
        codexSessionId: "host-reboot-recovery-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "host-reboot-recovery-codex-thread",
      codexSessionId: "host-reboot-recovery-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "host-reboot-turn",
      },
    }, env);
    await appendThreadMessage(rebootThread.id, {
      role: "user",
      source: "manual",
      text: "This was active during host reboot.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "host-reboot-recovery-codex-thread",
      codexTurnId: "host-reboot-turn",
    }, env);

    const rebootRecovery = await recoverStaleCodexAppServerTurns(env, { noticeCause: "host_reboot", recoverySource: "startup_recovery" });
    const rebootMessages = await listThreadMessages(rebootThread.id, env);
    const rebootNotice = rebootMessages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
    const events = (await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const rebootEvent = events.find((event) => event.type === "codex_app_server_stale_turn_recovered" && event.threadId === rebootThread.id);

    assert.equal(rebootRecovery.recovered, 1);
    assert.equal(rebootRecovery.appended, 1);
    assert.match(rebootNotice.text, /^Host rebooted before Codex replied/);
    assert.match(rebootNotice.text, /The machine restarted after this message reached Codex/);
    assert.equal(rebootEvent.noticeCause, "host_reboot");
    assert.equal(rebootEvent.recoverySource, "startup_recovery");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery does not emit a missing-response notice during final grace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-grace-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "120000",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-grace-thread",
      name: "App Server Stale Grace Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-grace-codex-thread",
        codexSessionId: "stale-grace-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-grace-codex-thread",
      codexSessionId: "stale-grace-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-grace-turn",
        codexStatus: { type: "idle" },
      },
    }, env);
    await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "This delivered turn is still inside final grace.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "stale-grace-codex-thread",
      codexTurnId: "stale-grace-turn",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const updated = await getThread(thread.id, env);
    const messages = await listThreadMessages(thread.id, env);

    assert.equal(result.recovered, 1);
    assert.equal(result.appended, 0);
    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.state, "ready");
    assert.equal(updated.runtime.activeTurnId, null);
    assert.equal(messages.some((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted"), false);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery auto safe-resets repeated stale delivered turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-repeat-stale-reset-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS: "0",
    ORKESTR_CODEX_APP_SERVER_AUTO_SAFE_RESET_COOLDOWN_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-repeat-stale-reset-thread",
      name: "App Server Repeat Stale Reset Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "repeat-stale-codex-thread",
        codexSessionId: "repeat-stale-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "repeat-stale-codex-thread",
      codexSessionId: "repeat-stale-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-repeat-stale",
        responderAccountId: "account-repeat-stale",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    const previousInput = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-repeat-stale",
      accountId: "account-repeat-stale",
      text: "First delivered turn with no reply.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "repeat-stale-codex-thread",
      codexTurnId: "repeat-stale-first-turn",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "orkestr_runtime",
      phase: "runtime_interrupted",
      text: "Codex response missing",
      state: "completed",
      parentMessageId: previousInput.id,
      connector: "whatsapp",
      chatId: "chat-repeat-stale",
      accountId: "account-repeat-stale",
      codexThreadId: "repeat-stale-codex-thread",
      codexTurnId: "repeat-stale-first-turn",
    }, env);
    const latestInput = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-repeat-stale",
      accountId: "account-repeat-stale",
      text: "Second delivered turn with no reply.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "repeat-stale-codex-thread",
      codexTurnId: "repeat-stale-second-turn",
    }, env);
    const resets = [];

    const result = await recoverStaleCodexAppServerTurns(env, {
      autoSafeResetThread: async (threadId, context = {}) => {
        resets.push({ threadId, context });
        return {
          ok: true,
          reset: true,
          safeReset: true,
          oldCodexThreadId: context.codexThreadId,
          newCodexThreadId: "repeat-stale-new-codex-thread",
          manualCheckpoint: { path: path.join(home, "repeat-stale-safe-reset.md") },
        };
      },
    });
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");
    const recoveryNotice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_recovered");
    const continuation = messages.find((message) =>
      message.role === "user" &&
      message.parentMessageId === latestInput.id &&
      message.codexThreadId === "repeat-stale-new-codex-thread"
    );
    const events = (await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const autoEvent = events.find((event) => event.type === "codex_app_server_auto_safe_reset");
    const recoveryEvent = events.find((event) => event.type === "codex_app_server_stale_turn_recovered" && event.latestUserMessageId === latestInput.id);

    assert.equal(result.recovered, 1);
    assert.equal(result.appended, 1);
    assert.equal(result.autoSafeReset, 1);
    assert.equal(result.continued, 1);
    assert.equal(resets.length, 1);
    assert.equal(resets[0].threadId, thread.id);
    assert.equal(resets[0].context.reason, "stale_turn_auto_safe_reset");
    assert.equal(resets[0].context.latestUserMessageId, latestInput.id);
    assert.equal(notices.length, 2);
    assert.equal(notices.at(-1).parentMessageId, latestInput.id);
    assert.equal(recoveryNotice, undefined);
    assert.ok(continuation);
    assert.equal(continuation.text, latestInput.text);
    assert.equal(continuation.state, "queued");
    assert.equal(continuation.visibility, "internal");
    assert.equal(continuation.connector, "whatsapp");
    assert.equal(continuation.chatId, "chat-repeat-stale");
    assert.equal(continuation.accountId, "account-repeat-stale");
    assert.equal(autoEvent.oldCodexThreadId, "repeat-stale-codex-thread");
    assert.equal(autoEvent.newCodexThreadId, "repeat-stale-new-codex-thread");
    assert.equal(recoveryEvent.autoSafeReset, true);
    assert.equal(recoveryEvent.autoSafeResetError, null);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery waits through recent progress before declaring a missing final", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-recent-progress-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({
      id: "app-server-recent-progress-thread",
      name: "App Server Recent Progress Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "recent-progress-codex-thread",
        codexSessionId: "recent-progress-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "recent-progress-codex-thread",
      codexSessionId: "recent-progress-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
        lastTurnStatus: "completed",
      },
    }, env);
    const turnId = "recent-progress-turn";
    const user = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp_inbound",
      text: "What is the status?",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "recent-progress-codex-thread",
      codexTurnId: turnId,
      createdAt: new Date(Date.now() - 70_000).toISOString(),
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "commentary",
      text: "I am checking the live state.",
      state: "completed",
      parentMessageId: user.id,
      codexThreadId: "recent-progress-codex-thread",
      codexTurnId: turnId,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(messages.some((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted"), false);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery ignores delayed imported user rows for completed turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-import-race-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-import-race-thread",
      name: "App Server Import Race Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "import-race-codex-thread",
        codexSessionId: "import-race-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "import-race-codex-thread",
      codexSessionId: "import-race-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "Delivered question.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "import-race-codex-thread",
      codexTurnId: "live-turn",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      text: "Delivered answer.",
      state: "completed",
      codexThreadId: "import-race-codex-thread",
      codexTurnId: "live-turn",
      createdAt: "2026-01-01T00:00:01.000Z",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      text: "Imported answer already exists.",
      state: "completed",
      codexThreadId: "import-race-codex-thread",
      codexTurnId: "imported-turn",
      createdAt: "2026-01-01T00:00:03.000Z",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "user",
      source: "codex-app-server-import",
      text: "Imported question arrived late.",
      state: "completed",
      codexThreadId: "import-race-codex-thread",
      codexTurnId: "imported-turn",
      createdAt: "2026-01-01T00:00:02.000Z",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(notices.length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery treats parent-linked final answers as completed turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-parent-final-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-parent-final-thread",
      name: "App Server Parent Final Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "parent-final-codex-thread",
        codexSessionId: "parent-final-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "parent-final-codex-thread",
      codexSessionId: "parent-final-codex-thread",
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "Delivered question with imported parent final.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "parent-final-codex-thread",
      codexTurnId: "parent-final-turn",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "This final was imported without a turn id.",
      state: "completed",
      parentMessageId: input.id,
      codexThreadId: "parent-final-codex-thread",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(notices.length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery ignores old historical progress-only turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-old-history-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
    ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_LOOKBACK_MS: String(60 * 60 * 1000),
  };
  try {
    const thread = await createThread({
      id: "app-server-old-history-thread",
      name: "App Server Old History Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "old-history-codex-thread",
        codexSessionId: "old-history-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "old-history-codex-thread",
      codexSessionId: "old-history-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-old-history",
        responderAccountId: "account-old-history",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    const oldInputAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const oldProgressAt = new Date(Date.now() - 2 * 60 * 60 * 1000 + 1000).toISOString();
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-old-history",
      accountId: "account-old-history",
      text: "Old imported turn.",
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: oldInputAt,
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "old-history-codex-thread",
      codexTurnId: "old-history-turn",
      createdAt: oldInputAt,
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "commentary",
      text: "Old progress update without a final answer.",
      state: "completed",
      parentMessageId: input.id,
      connector: "whatsapp",
      chatId: "chat-old-history",
      accountId: "account-old-history",
      codexThreadId: "old-history-codex-thread",
      codexTurnId: "old-history-turn",
      createdAt: oldProgressAt,
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(notices.length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery ignores historical progress-only turns after a newer final answer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-superseded-history-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-superseded-history-thread",
      name: "App Server Superseded History Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "superseded-history-codex-thread",
        codexSessionId: "superseded-history-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "superseded-history-codex-thread",
      codexSessionId: "superseded-history-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-superseded-history",
        responderAccountId: "account-superseded-history",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
      },
    }, env);
    const oldInput = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-superseded-history",
      accountId: "account-superseded-history",
      text: "Older turn that only produced progress.",
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: "2026-05-30T08:00:00.000Z",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "superseded-history-codex-thread",
      codexTurnId: "old-progress-turn",
      createdAt: "2026-05-30T08:00:00.000Z",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "commentary",
      text: "Older progress without a final answer.",
      state: "completed",
      parentMessageId: oldInput.id,
      connector: "whatsapp",
      chatId: "chat-superseded-history",
      accountId: "account-superseded-history",
      codexThreadId: "superseded-history-codex-thread",
      codexTurnId: "old-progress-turn",
      createdAt: "2026-05-30T08:01:00.000Z",
    }, env);
    const newerInput = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-superseded-history",
      accountId: "account-superseded-history",
      text: "Newer turn that completed.",
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: "2026-05-30T09:00:00.000Z",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "superseded-history-codex-thread",
      codexTurnId: "newer-final-turn",
      createdAt: "2026-05-30T09:00:00.000Z",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      text: "Newer final answer completed the live conversation.",
      state: "completed",
      parentMessageId: newerInput.id,
      connector: "whatsapp",
      chatId: "chat-superseded-history",
      accountId: "account-superseded-history",
      codexThreadId: "superseded-history-codex-thread",
      codexTurnId: "newer-final-turn",
      createdAt: "2026-05-30T09:01:00.000Z",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notices = messages.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 0);
    assert.equal(result.appended, 0);
    assert.equal(notices.length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery projects stale WhatsApp turns back to the source chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-wa-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-wa-recovery-thread",
      name: "App Server Stale WA Recovery Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-wa-recovery-codex-thread",
        codexSessionId: "stale-wa-recovery-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-wa-recovery-codex-thread",
      codexSessionId: "stale-wa-recovery-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-stale-wa",
        responderAccountId: "account-stale-wa",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-wa-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-stale-wa",
      accountId: "account-stale-wa",
      text: "WhatsApp delivered turn with no reply.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "stale-wa-recovery-codex-thread",
      codexTurnId: "stale-wa-turn",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 1);
    assert.equal(result.appended, 1);
    assert.equal(notice.parentMessageId, input.id);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-stale-wa");
    assert.equal(notice.accountId, "account-stale-wa");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery mirrors stale bound threads without a WhatsApp parent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-bound-wa-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-stale-bound-wa-recovery-thread",
      name: "App Server Stale Bound WA Recovery Thread",
      state: "working",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "stale-bound-wa-recovery-codex-thread",
        codexSessionId: "stale-bound-wa-recovery-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "stale-bound-wa-recovery-codex-thread",
      codexSessionId: "stale-bound-wa-recovery-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-stale-bound-wa",
        responderAccountId: "account-stale-bound-wa",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-bound-wa-turn",
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);
    await appendThreadMessage(thread.id, {
      role: "user",
      source: "manual",
      text: "Web UI delivered turn with no final reply.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "stale-bound-wa-recovery-codex-thread",
      codexTurnId: "stale-bound-wa-turn",
    }, env);

    const result = await recoverStaleCodexAppServerTurns(env);
    const messages = await listThreadMessages(thread.id, env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(result.recovered, 1);
    assert.equal(result.appended, 1);
    assert.equal(notice.parentMessageId, null);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-stale-bound-wa");
    assert.equal(notice.accountId, "account-stale-bound-wa");
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server recovery reports progress-only turns with no final answer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-progress-only-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS: "0",
  };
  try {
    const thread = await createThread({
      id: "app-server-progress-only-recovery-thread",
      name: "App Server Progress Only Recovery Thread",
      state: "ready",
      executorId: "codex",
      executor: {
        type: "codex",
        transport: "app-server",
        codexThreadId: "progress-only-codex-thread",
        codexSessionId: "progress-only-codex-thread",
      },
      runtimeKind: "codex-app-server",
      codexThreadId: "progress-only-codex-thread",
      codexSessionId: "progress-only-codex-thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-progress-only",
        responderAccountId: "account-progress-only",
      },
      runtime: {
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        codexStatus: { type: "idle" },
        lastTurnStatus: "completed",
      },
    }, env);
    const input = await appendThreadMessage(thread.id, {
      role: "user",
      source: "whatsapp",
      connector: "whatsapp",
      chatId: "chat-progress-only",
      accountId: "account-progress-only",
      text: "Finish this turn.",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "codex_app_server_turn_start",
      codexThreadId: "progress-only-codex-thread",
      codexTurnId: "progress-turn",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "commentary",
      text: "I am still working on it.",
      state: "completed",
      parentMessageId: input.id,
      connector: "whatsapp",
      chatId: "chat-progress-only",
      accountId: "account-progress-only",
      codexThreadId: "progress-only-codex-thread",
      codexTurnId: "progress-turn",
    }, env);

    const first = await recoverStaleCodexAppServerTurns(env, { noticeCause: "orkestr_restart" });
    const messages = await listThreadMessages(thread.id, env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.equal(first.recovered, 1);
    assert.equal(first.appended, 1);
    assert.equal(notice.parentMessageId, input.id);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-progress-only");
    assert.match(notice.text, /^Orkestr restarted before Codex finished/);
    assert.match(notice.text, /Progress updates before the restart were preserved/);
    assert.doesNotMatch(notice.text, /\/now/);

    const second = await recoverStaleCodexAppServerTurns(env);
    const messagesAfterSecond = await listThreadMessages(thread.id, env);
    assert.equal(second.recovered, 0);
    assert.equal(second.appended, 0);
    assert.equal(messagesAfterSecond.filter((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted").length, 1);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server history hydration preserves non-final assistant messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-history-preserve-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr") };
  const thread = await createThread({ id: "app-server-history-preserve-thread", name: "History Preserve Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
  const codexThread = {
    id: "codex-history-preserve-thread",
    turns: [
      {
        id: "codex-history-preserve-turn",
        threadId: "codex-history-preserve-thread",
        status: "completed",
        items: [
          { type: "userMessage", id: "history-preserve-user", content: [{ type: "text", text: "User request" }] },
          { type: "agentMessage", id: "history-preserve-commentary", text: "Working on it.", phase: "commentary" },
          { type: "contextCompaction", id: "history-preserve-context", phase: "context_compaction" },
          { type: "plan", id: "history-preserve-plan", text: "Plan survives.", phase: "plan" },
          { type: "agentMessage", id: "history-preserve-final", text: "Final answer survives.", phase: "final_answer" },
        ],
      },
    ],
  };

  const result = await hydrateCodexAppServerThreadMessages(thread, codexThread, env);
  const messages = await listThreadMessages(thread.id, env);

  assert.equal(result.created, 5);
  assert.ok(messages.find((message) => message.role === "assistant" && message.phase === "commentary" && message.text === "Working on it."));
  assert.ok(messages.find((message) => message.role === "assistant" && message.phase === "context_compaction" && message.text === "Codex compacted the conversation context."));
  assert.ok(messages.find((message) => message.role === "assistant" && message.phase === "plan" && message.text === "Plan survives."));
  assert.ok(messages.find((message) => message.role === "assistant" && message.phase === "final_answer" && message.text === "Final answer survives."));
});

test("Codex app-server history hydration spreads turn-level timestamps across items", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-history-times-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr") };
  const thread = await createThread({ id: "app-server-history-times-thread", name: "History Times Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
  const codexThread = {
    id: "codex-history-times-thread",
    turns: [
      {
        id: "codex-history-times-turn",
        threadId: "codex-history-times-thread",
        status: "completed",
        createdAt: "2026-06-06T09:18:39.000Z",
        items: [
          { type: "userMessage", id: "history-times-user", content: [{ type: "text", text: "User request" }] },
          { type: "agentMessage", id: "history-times-commentary", text: "All final checks are complete.", phase: "commentary" },
          { type: "agentMessage", id: "history-times-final", text: "Deployed.", phase: "final_answer" },
        ],
      },
    ],
  };

  await hydrateCodexAppServerThreadMessages(thread, codexThread, env);
  const messages = await listThreadMessages(thread.id, env);
  const createdAt = messages.map((message) => message.createdAt);

  assert.deepEqual(createdAt, [
    "2026-06-06T09:18:39.000Z",
    "2026-06-06T09:18:39.001Z",
    "2026-06-06T09:18:39.002Z",
  ]);
  assert.equal(new Set(createdAt).size, createdAt.length);
});

test("Codex app-server history sync adopts native turns without duplicating Orkestr inputs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-sync-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_HISTORY_SYNC_INTERVAL_MS: "0",
  };
  try {
    const thread = await createThread({ id: "app-server-sync-thread", name: "App Server Sync Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await enqueueThreadInput(thread.id, { text: "hello from orkestr" }, env);
    await deliverCodexAppServerPendingInputs(started.thread, env);

    const beforeSync = await listThreadMessages(thread.id, env);
    assert.equal(beforeSync.filter((message) => message.role === "user" && /hello from orkestr/.test(message.text)).length, 1);
    assert.equal(beforeSync.find((message) => message.role === "user" && /hello from orkestr/.test(message.text))?.source, "manual");

    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = state.threads.find((item) => item.id === started.thread.executor.codexThreadId);
    const nativeTurnId = "019e014d-2538-7fd2-9506-681dc91be528";
    const nativeCreatedAt = "2026-05-07T07:18:13.560Z";
    codexThread.turns.push({
      id: nativeTurnId,
      threadId: codexThread.id,
      status: "completed",
      items: [
        { type: "userMessage", id: "native-user-001", content: [{ type: "text", text: "hello from native codex" }] },
        { type: "userMessage", id: "native-user-001-duplicate", content: [{ type: "text", text: "hello from native codex" }] },
        { type: "agentMessage", id: "native-agent-001", text: "native codex reply", phase: "final_answer" },
        { type: "agentMessage", id: "native-agent-import-only", text: "native import-only reply", phase: "final_answer" },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(state, null, 2));
    const importOnlyCreatedAt = new Date(Date.parse(nativeCreatedAt) + 3).toISOString();

    const liveProjectedReply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      state: "completed",
      text: "native codex reply",
      codexThreadId: codexThread.id,
      codexTurnId: nativeTurnId,
      codexItemId: "msg_live_projected_reply",
    }, env);
    const result = await syncCodexAppServerThreadMessages(started.thread, env, { force: true });
    const afterSync = await listThreadMessages(thread.id, env);
    const orkestrInputs = afterSync.filter((message) => message.role === "user" && /hello from orkestr/.test(message.text));
    const nativeInputs = afterSync.filter((message) => message.role === "user" && /hello from native codex/.test(message.text));
    const nativeInput = nativeInputs[0];
    const nativeReplies = afterSync.filter((message) => message.role === "assistant" && /native codex reply/.test(message.text));
    const nativeReply = nativeReplies[0];
    const importOnlyReply = afterSync.find((message) => message.role === "assistant" && /native import-only reply/.test(message.text));

    assert.equal(result.synced, true);
    assert.equal(orkestrInputs.length, 1);
    assert.equal(orkestrInputs[0].source, "manual");
    assert.equal(orkestrInputs[0].codexItemId, "user_" + orkestrInputs[0].codexTurnId);
    assert.equal(nativeInputs.length, 1);
    assert.equal(nativeInput?.source, "codex-app-server-import");
    assert.equal(nativeInput?.codexTurnId, nativeTurnId);
    assert.equal(nativeInput?.createdAt, nativeCreatedAt);
    assert.equal(nativeReplies.length, 1);
    assert.equal(nativeReply?.id, liveProjectedReply.id);
    assert.equal(nativeReply?.source, "codex-app-server");
    assert.equal(nativeReply?.codexItemId, "msg_live_projected_reply");
    assert.notEqual(nativeReply?.createdAt, nativeCreatedAt);
    assert.equal(importOnlyReply?.source, "codex-app-server-import");
    assert.equal(importOnlyReply?.codexItemId, "native-agent-import-only");
    assert.equal(importOnlyReply?.createdAt, importOnlyCreatedAt);

    await updateThreadMessage(thread.id, importOnlyReply.id, { createdAt: "2026-05-27T11:54:36.000Z" }, env);
    const repair = await syncCodexAppServerThreadMessages(started.thread, env, { force: true });
    const repairedMessages = await listThreadMessages(thread.id, env);
    const repairedReply = repairedMessages.find((message) => message.id === importOnlyReply.id);

    assert.equal(repair.synced, true);
    assert.equal(repair.updated, 1);
    assert.equal(repairedReply?.createdAt, importOnlyCreatedAt);

    const second = await syncCodexAppServerThreadMessages(started.thread, env, { force: true });
    assert.equal(second.count, 0);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server history sync clears active turns when the final answer is imported", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-sync-complete-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_HISTORY_SYNC_INTERVAL_MS: "0",
  };
  try {
    const thread = await createThread({ id: "app-server-sync-complete-thread", name: "Sync Complete Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const activeTurnId = "019e0151-8a98-7cd4-af9c-254e13705e67";
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId,
        codexStatus: { type: "active", activeFlags: ["running"] },
      },
    }, env);

    const state = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = state.threads.find((item) => item.id === codexId);
    codexThread.turns.push({
      id: activeTurnId,
      threadId: codexId,
      status: "inProgress",
      items: [
        { type: "userMessage", id: "sync-complete-user", content: [{ type: "text", text: "finish from native history" }] },
        { type: "agentMessage", id: "sync-complete-agent", text: "history imported final", phase: "final_answer" },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(state, null, 2));

    const result = await syncCodexAppServerThreadMessages(await getThread(started.thread.id, env), env, { force: true });
    const updated = await getThread(started.thread.id, env);
    const messages = await listThreadMessages(started.thread.id, env);
    const final = messages.find((message) => message.text === "history imported final");

    assert.equal(result.completedTurnId, activeTurnId);
    assert.equal(updated.state, "ready");
    assert.equal(updated.runtime.state, "ready");
    assert.equal(updated.runtime.activeTurnId, null);
    assert.equal(updated.runtime.lastTurnId, activeTurnId);
    assert.equal(updated.runtime.lastTurnStatus, "completed");
    assert.equal(final?.source, "codex-app-server-import");
    assert.equal(final?.codexTurnId, activeTurnId);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server sleep is rejected and reset interrupts active turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-reset-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-sleep-thread", name: "App Server Sleep Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);

    await assert.rejects(
      () => sleepThread(started.thread.id, { reason: "ui_sleep", kill: false }, env),
      (error) => error?.message === "codex_app_server_sleep_unsupported_use_stop" && error?.statusCode === 409,
    );
    const stillWorking = await getThread(started.thread.id, env);
    let rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(stillWorking.state, "working");
    assert.equal(stillWorking.runtime.activeTurnId, "active-turn");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/interrupt"));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/unsubscribe"));

    const reset = await resetThreadRuntime(stillWorking.id, { reason: "ui_reset", kill: true }, env);
    rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const resetThread = await getThread(started.thread.id, env);

    assert.equal(reset.slept, 0);
    assert.equal(resetThread.state, "ready");
    assert.equal(resetThread.runtime.activeTurnId, null);
    assert.ok(rawState.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-turn"));
    assert.ok(rawState.calls.some((call) => call.method === "thread/resume"));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/unsubscribe"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server safe reset checkpoints and starts a fresh thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-safe-reset-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-safe-reset-thread", name: "App Server Safe Reset Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await appendThreadMessage(started.thread.id, { role: "user", text: "Important active task", state: "completed" }, env);
    await appendThreadMessage(started.thread.id, { role: "assistant", phase: "final_answer", text: "Important result", state: "completed" }, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);

    const oldCodexThreadId = started.thread.codexThreadId;
    const reset = await safeResetThreadRuntime(started.thread.id, { reason: "test_safe_reset" }, env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const resetThread = await getThread(started.thread.id, env);
    const checkpoint = await fs.readFile(reset.manualCheckpoint.path, "utf8");

    assert.equal(reset.ok, true);
    assert.equal(reset.safeReset, true);
    assert.equal(reset.slept, 0);
    assert.equal(reset.oldCodexThreadId, oldCodexThreadId);
    assert.notEqual(reset.newCodexThreadId, oldCodexThreadId);
    assert.equal(resetThread.codexThreadId, reset.newCodexThreadId);
    assert.equal(resetThread.executor.metadata.lastSafeReset.codexThreadId, oldCodexThreadId);
    assert.match(checkpoint, /Important active task/);
    assert.match(checkpoint, /Important result/);
    assert.equal(rawState.calls.filter((call) => call.method === "thread\/start").length, 2);
    assert.ok(rawState.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-turn"));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/resume"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server /safe-reset command starts fresh thread without delivering prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-safe-reset-command-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-safe-reset-command-thread", name: "App Server Safe Reset Command Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const oldCodexThreadId = started.thread.codexThreadId;
    const input = await enqueueThreadInput(started.thread.id, {
      text: "/safe-reset",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-safe-reset-command",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const resetThread = await getThread(started.thread.id, env);
    const messages = await listThreadMessages(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);

    assert.deepEqual(delivered, [input.id]);
    assert.equal(completed.state, "completed");
    assert.equal(completed.deliveryState, "delivered");
    assert.equal(completed.observedVia, "orkestr_safe_reset_command");
    assert.equal(completed.oldCodexThreadId, oldCodexThreadId);
    assert.notEqual(completed.newCodexThreadId, oldCodexThreadId);
    assert.equal(resetThread.codexThreadId, completed.newCodexThreadId);
    assert.equal(rawState.calls.filter((call) => call.method === "thread/start").length, 2);
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start" && call.params?.input?.some((item) => item.text === "/safe-reset")));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/resume"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server queues WhatsApp input behind active turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-wa-queue-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_RETRY_MS: "60000",
  };
  try {
    const thread = await createThread({ id: "app-server-wa-queue-thread", name: "App Server WA Queue Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);
    const input = await enqueueThreadInput(started.thread.id, {
      text: "queue this behind the current turn",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-queue",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const queued = messages.find((message) => message.id === input.id);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, []);
    assert.equal(queued.state, "queued");
    assert.equal(queued.deliveryState, "awaiting_active_turn");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/steer"));
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server delivers queued input when live status cleared a stale active turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-active-delivery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_RETRY_MS: "60000",
  };
  try {
    const thread = await createThread({ id: "app-server-stale-active-delivery-thread", name: "App Server Stale Active Delivery Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexThreadId = started.thread.executor.codexThreadId;
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.set(codexThreadId, {
      ...(client.threadStates.get(codexThreadId) || {}),
      activeTurnId: "stale-completed-turn",
      status: { type: "idle" },
    });
    await updateThread(started.thread.id, {
      state: "ready",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: "stale-completed-turn",
        codexStatus: { type: "idle" },
      },
    }, env);
    const input = await enqueueThreadInput(started.thread.id, {
      text: "deliver after stale active turn",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-stale",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);
    const reply = messages.find((message) => message.parentMessageId === input.id && /Reply to: deliver after stale active turn/.test(message.text));
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, [input.id]);
    assert.equal(completed.state, "completed");
    assert.equal(completed.deliveryState, "delivered");
    assert.ok(reply);
    assert.ok(rawState.calls.some((call) => call.method === "turn/start"));
    assert.ok(!rawState.calls.some((call) => call.method === "turn/interrupt"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server queues normal input behind active turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-generic-queue-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_RETRY_MS: "60000",
  };
  try {
    const thread = await createThread({ id: "app-server-generic-queue-thread", name: "App Server Generic Queue Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);
    const input = await enqueueThreadInput(started.thread.id, { text: "queue normal input behind the turn" }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const queued = messages.find((message) => message.id === input.id);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, []);
    assert.equal(queued.state, "queued");
    assert.equal(queued.deliveryState, "awaiting_active_turn");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/steer"));
    assert.ok(!rawState.calls.some((call) => call.method === "turn/start"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server reads live active turns before delivering queued input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-live-active-delivery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
    ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_RETRY_MS: "60000",
  };
  try {
    const thread = await createThread({ id: "app-server-live-active-delivery-thread", name: "App Server Live Active Delivery Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = rawState.threads.find((item) => item.id === codexId);
    codexThread.status = { type: "active", activeFlags: [] };
    codexThread.turns.push({
      id: "live-empty-flags-turn",
      threadId: codexId,
      status: "inProgress",
      items: [
        { type: "userMessage", id: "user_live_empty_flags", content: [{ type: "text", text: "Still working." }] },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2));
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: null,
        codexStatus: { type: "active", activeFlags: [] },
      },
    }, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.delete(codexId);
    const input = await enqueueThreadInput(started.thread.id, { text: "do not interrupt the live turn" }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const queued = messages.find((message) => message.id === input.id);
    const status = await codexAppServerThreadStatus(await getThread(started.thread.id, env), env);
    const rawStateAfter = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const deliveryTurnStarts = rawStateAfter.calls.filter((call) =>
      call.method === "turn/start" && call.params?.input?.some((item) => item.text === "do not interrupt the live turn")
    );

    assert.deepEqual(delivered, []);
    assert.equal(queued.state, "queued");
    assert.equal(queued.deliveryState, "awaiting_active_turn");
    assert.equal(status.state, "working");
    assert.equal(status.activeTurnId, "live-empty-flags-turn");
    assert.equal(rawStateAfter.calls.some((call) => call.method === "thread/read" && call.params?.threadId === codexId), true);
    assert.equal(deliveryTurnStarts.length, 0);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server interrupt reads live active turns before reporting no active turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-live-active-interrupt-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-live-active-interrupt-thread", name: "App Server Live Active Interrupt Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    const codexId = started.thread.executor.codexThreadId;
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const codexThread = rawState.threads.find((item) => item.id === codexId);
    codexThread.status = { type: "active", activeFlags: [] };
    codexThread.turns.push({
      id: "live-empty-flags-interrupt-turn",
      threadId: codexId,
      status: "inProgress",
      items: [
        { type: "userMessage", id: "user_live_empty_flags_interrupt", content: [{ type: "text", text: "Still working." }] },
      ],
    });
    await fs.writeFile(fake.stateFile, JSON.stringify(rawState, null, 2));
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: null,
        codexStatus: { type: "active", activeFlags: [] },
      },
    }, env);
    const client = await getCodexAppServerClient({ env, home: env.HOME });
    client.threadStates.delete(codexId);

    const result = await interruptCodexAppServerThread(await getThread(started.thread.id, env), env);
    const interruptedThread = await getThread(started.thread.id, env);
    const rawStateAfter = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(result.interrupted, true);
    assert.equal(result.turnId, "live-empty-flags-interrupt-turn");
    assert.equal(interruptedThread.state, "ready");
    assert.equal(interruptedThread.runtime.activeTurnId, null);
    assert.equal(rawStateAfter.calls.some((call) => call.method === "thread/read" && call.params?.threadId === codexId), true);
    assert.equal(rawStateAfter.calls.some((call) =>
      call.method === "turn/interrupt" &&
      call.params?.threadId === codexId &&
      call.params?.turnId === "live-empty-flags-interrupt-turn"
    ), true);
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server /now interrupts the active turn and starts the next turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-wa-now-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-wa-now-thread", name: "App Server WA Now Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);
    const input = await enqueueThreadInput(started.thread.id, {
      text: "/now urgent next turn",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-now",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);
    const reply = messages.find((message) => message.source === "codex-app-server" && /Reply to: urgent next turn/.test(message.text));
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, [input.id]);
    assert.equal(completed.text, "urgent next turn");
    assert.equal(completed.state, "completed");
    assert.equal(completed.observedVia, "codex_app_server_turn_start");
    assert.ok(reply);
    assert.ok(rawState.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-turn"));
    assert.ok(rawState.calls.some((call) => call.method === "turn/start"));
    assert.ok(!rawState.calls.some((call) => call.method === "turn/steer"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server /stop interrupts the active turn without sleeping the thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-wa-stop-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
  };
  try {
    const thread = await createThread({ id: "app-server-wa-stop-thread", name: "App Server WA Stop Thread", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
    const started = await startCodexAppServerThread(thread, env);
    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "active-turn",
      },
    }, env);
    await markAppServerTurnActive(started.thread, env);
    const input = await enqueueThreadInput(started.thread.id, {
      text: "/stop",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-stop",
    }, env);

    const delivered = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const messages = await listThreadMessages(started.thread.id, env);
    const stopped = await getThread(started.thread.id, env);
    const completed = messages.find((message) => message.id === input.id);
    const rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.deepEqual(delivered, [input.id]);
    assert.equal(completed.state, "completed");
    assert.equal(completed.observedVia, "codex_app_server_stop");
    assert.equal(completed.interruptSent, true);
    assert.equal(stopped.state, "ready");
    assert.equal(stopped.runtime.activeTurnId, null);
    assert.ok(rawState.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-turn"));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/unsubscribe"));
  } finally {
    stopCodexAppServerClients();
  }
});
