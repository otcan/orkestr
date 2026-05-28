import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexAppServerThreadStatus,
  deliverCodexAppServerPendingInputs,
  getCodexAppServerClient,
  importCodexAppServerThread,
  listCodexAppServerThreads,
  recoverStaleCodexAppServerTurns,
  startCodexAppServerThread,
  stopCodexAppServerClients,
  syncCodexAppServerThreadMessages,
} from "../packages/core/src/codex-app-server.js";
import { migrateCodexThreadsToAppServer } from "../packages/core/src/codex-app-server-migration.js";
import { resetThreadRuntime, sleepThread } from "../packages/core/src/runtime-leases.js";
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
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
    await enqueueThreadInput(startedWhatsApp.thread.id, {
      text: "add this too",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-1",
      accountId: "account-1",
      attachments: [{ path: "/tmp/fitness-label.jpg", filename: "fitness-label.jpg", mimetype: "image/jpeg", kind: "image" }],
    }, env);
    await deliverCodexAppServerPendingInputs(startedWhatsApp.thread, env);
    const attachmentMessages = await listThreadMessages(startedWhatsApp.thread.id, env);
    assert.ok(attachmentMessages.some((message) =>
      message.source === "codex-app-server" &&
      /Reply to: add this too/.test(message.text) &&
      String(message.text || "").includes("Attachment 1: /tmp/fitness-label.jpg")
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
    assert.ok(whatsappCalls.some((call) => call.body.text.includes("Attachment 1: /tmp/fitness-label.jpg")));

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
  try {
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
      },
    }, env);
    const idleActiveStatus = await codexAppServerThreadStatus(idleActive, env);

    assert.equal(idleActiveStatus.state, "ready");
    assert.equal(idleActiveStatus.working, false);
    assert.equal(idleActiveStatus.activeTurnId, null);
  } finally {
    stopCodexAppServerClients();
  }
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

test("Codex app-server recovery marks stale delivered turns ready and appends one interruption notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
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

test("Codex app-server recovery projects stale WhatsApp turns back to the source chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-stale-wa-recovery-"));
  const fake = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${fake.bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: fake.stateFile,
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
    assert.equal(importOnlyReply?.createdAt, nativeCreatedAt);

    await updateThreadMessage(thread.id, importOnlyReply.id, { createdAt: "2026-05-27T11:54:36.000Z" }, env);
    const repair = await syncCodexAppServerThreadMessages(started.thread, env, { force: true });
    const repairedMessages = await listThreadMessages(thread.id, env);
    const repairedReply = repairedMessages.find((message) => message.id === importOnlyReply.id);

    assert.equal(repair.synced, true);
    assert.equal(repair.updated, 1);
    assert.equal(repairedReply?.createdAt, nativeCreatedAt);

    const second = await syncCodexAppServerThreadMessages(started.thread, env, { force: true });
    assert.equal(second.count, 0);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
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
