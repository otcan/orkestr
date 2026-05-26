import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deliverCodexAppServerPendingInputs,
  importCodexAppServerThread,
  listCodexAppServerThreads,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../packages/core/src/codex-app-server.js";
import { migrateCodexThreadsToAppServer } from "../packages/core/src/codex-app-server-migration.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../packages/core/src/threads.js";
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
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { threads: [] }; }
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
  if (message.method === "initialize") return send({ id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const thread = { id: "thr_" + String(state.threads.length + 1).padStart(3, "0"), sessionId: "sess_001", name: "", preview: "", cwd: params.cwd || "", status: { type: "idle" }, turns: [] };
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
  if (message.method === "thread/list") return send({ id, result: { data: state.threads.map(({ turns, ...thread }) => thread), nextCursor: null } });
  if (message.method === "thread/read") return send({ id, result: { thread: state.threads.find((item) => item.id === params.threadId) || { id: params.threadId, turns: [] } } });
  if (message.method === "thread/resume") return send({ id, result: { thread: state.threads.find((item) => item.id === params.threadId) || { id: params.threadId, sessionId: params.threadId } } });
  if (message.method === "thread/unsubscribe") return send({ id, result: { status: "unsubscribed" } });
  if (message.method === "thread/archive") return send({ id, result: {} });
  if (message.method === "turn/start") {
    const thread = state.threads.find((item) => item.id === params.threadId);
    const turn = { id: "turn_" + Date.now(), threadId: params.threadId, status: "inProgress", items: [] };
    const text = params.input?.find((item) => item.type === "text")?.text || "";
    const user = { type: "userMessage", id: "user_" + turn.id, content: [{ type: "text", text }] };
    const agent = { type: "agentMessage", id: "agent_" + turn.id, text: "Reply to: " + text, phase: "final_answer" };
    if (thread) {
      turn.items = [user, agent];
      thread.turns.push(turn);
      writeState(state);
    }
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: agent } });
    send({ method: "turn/completed", params: { turn: { ...turn, status: "completed" } } });
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
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
    const whatsappCalls = [];
    const whatsappDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
      whatsappCalls.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, ids: ["sent-app-server-reply"] });
    });
    assert.equal(whatsappDelivery.delivered.length, 1);
    assert.equal(whatsappCalls[0].url.pathname, "/send-text");
    assert.equal(whatsappCalls[0].body.to, "chat-1");
    assert.equal(whatsappCalls[0].body.accountId, "account-1");
    assert.match(whatsappCalls[0].body.text, /Reply to: whatsapp ping/);

    const listed = await listCodexAppServerThreads({}, env);
    assert.equal(listed.data.length, 2);
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
