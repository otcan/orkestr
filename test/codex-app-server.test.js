import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexAppServerThreadStatus,
  deliverCodexAppServerPendingInputs,
  importCodexAppServerThread,
  listCodexAppServerThreads,
  sleepCodexAppServerThread,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../packages/core/src/codex-app-server.js";
import { migrateCodexThreadsToAppServer } from "../packages/core/src/codex-app-server-migration.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";
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
  if (message.method === "turn/steer") {
    if (params.expectedTurnId === "stale-turn") {
      return send({ id, error: { code: -32000, message: "no active turn to steer" } });
    }
    return send({ id, result: { turnId: params.expectedTurnId } });
  }
  if (message.method === "turn/interrupt") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (thread) thread.status = { type: "idle" };
    writeState(state);
    return send({ id, result: { interrupted: true, turnId: params.turnId } });
  }
  if (message.method === "turn/start") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    if (!thread || !thread.loaded) return send({ id, error: { code: -32000, message: "thread not found: " + params.threadId } });
    const turn = { id: "turn_" + Date.now(), threadId: params.threadId, status: "inProgress", items: [] };
    const text = params.input?.find((item) => item.type === "text")?.text || "";
    const user = { type: "userMessage", id: "user_" + turn.id, content: [{ type: "text", text }] };
    const agent = { type: "agentMessage", id: "agent_" + turn.id, text: "Reply to: " + text, phase: "final_answer" };
    turn.items = [user, agent];
    thread.turns.push(turn);
    writeState(state);
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: agent } });
    send({ method: "turn/completed", params: { turn: { ...turn, status: "completed" } } });
    return;
  }
  if (message.method === "turn/steer") {
    if (params.expectedTurnId === "stale-turn") return send({ id, error: { code: -32000, message: "no active turn to steer" } });
    return send({ id, result: { turnId: params.expectedTurnId } });
  }
  send({ id, result: {} });
});
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);
  return { bin, stateFile };
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

    await updateThread(started.thread.id, {
      state: "working",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-turn",
      },
    }, env);
    await enqueueThreadInput(started.thread.id, { text: "recover stale steer" }, env);
    const staleDelivery = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const staleMessages = await listThreadMessages(started.thread.id, env);
    assert.equal(staleDelivery.length, 1);
    assert.ok(staleMessages.some((message) => message.source === "codex-app-server" && /Reply to: recover stale steer/.test(message.text)));

    const failedStale = await enqueueThreadInput(started.thread.id, { text: "recover failed stale steer" }, env);
    await updateThreadMessage(started.thread.id, failedStale.id, {
      state: "failed",
      deliveryState: "failed",
      error: "no active turn to steer",
    }, env);
    await updateThread(started.thread.id, {
      state: "failed",
      lastError: "no active turn to steer",
      runtime: {
        ...(started.thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "working",
        activeTurnId: "stale-turn",
      },
    }, env);
    const failedRetry = await deliverCodexAppServerPendingInputs(await getThread(started.thread.id, env), env);
    const failedRetryMessages = await listThreadMessages(started.thread.id, env);
    const recoveredFailed = failedRetryMessages.find((message) => message.id === failedStale.id);
    assert.equal(failedRetry.length, 1);
    assert.equal(recoveredFailed.state, "completed");
    assert.equal(recoveredFailed.error, null);
    assert.ok(failedRetryMessages.some((message) => message.source === "codex-app-server" && /Reply to: recover failed stale steer/.test(message.text)));

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
    await deliverCodexAppServerPendingInputs(startedWhatsApp.thread, env);
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      resumedStatus = await codexAppServerThreadStatus({
        ...resumedThread,
        runtime: { ...(resumedThread.runtime || {}), activeTurnId: "stale-turn" },
      }, env);
      if (resumedStatus.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    assert.equal(staleInput.observedVia, "codex_app_server_turn_start_after_stale_steer");
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
    assert.ok(importedMessages.some((message) => message.source === "codex-app-server-import"));
  } finally {
    stopCodexAppServerClients();
  }
});

test("Codex app-server sleep only interrupts active turns when forced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-sleep-"));
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

    const skipped = await sleepCodexAppServerThread(await getThread(started.thread.id, env), { reason: "ui_sleep", kill: false }, env);
    const stillWorking = await getThread(started.thread.id, env);
    let rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));

    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "active_turn");
    assert.equal(stillWorking.state, "working");
    assert.equal(stillWorking.runtime.activeTurnId, "active-turn");
    assert.ok(!rawState.calls.some((call) => call.method === "turn/interrupt"));
    assert.ok(!rawState.calls.some((call) => call.method === "thread/unsubscribe"));

    const forced = await sleepCodexAppServerThread(stillWorking, { reason: "ui_stop", kill: true }, env);
    rawState = JSON.parse(await fs.readFile(fake.stateFile, "utf8"));
    const slept = await getThread(started.thread.id, env);

    assert.equal(forced.skipped, undefined);
    assert.equal(slept.state, "sleeping");
    assert.equal(slept.runtime.activeTurnId, null);
    assert.ok(rawState.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-turn"));
    assert.ok(rawState.calls.some((call) => call.method === "thread/unsubscribe"));
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
