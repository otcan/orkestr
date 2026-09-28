import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { createThread } from "../packages/core/src/threads.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { isCodexSteerCapableThread, isInstantInterruptCapableThread } from "../packages/core/src/instant-interrupt-capability.js";
import { initialQueueDeliveryState, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { parseInterruptArgs } from "../apps/cli/src/interrupt-command.js";
import { runCli } from "../apps/cli/src/commands.js";

const claudeThread = { id: "claude", executorId: "claude-code", runtimeKind: "claude-code" };
const codexThread = { id: "codex", runtimeKind: "codex-app-server" };
const steer = { role: "user", text: "change of plan", steerActiveTurn: true, codexDeliveryMode: "instant_steer" };
const claudeWorking = { runtimeKind: "claude-code", state: "working", promptReady: false };

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function recordingFetch(seen, payload) {
  return async (url, options = {}) => {
    seen.push({ path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("/now is an interrupt-and-send command while /interrupt stays a stop alias", () => {
  assert.deepEqual(parseThreadInputCommand({ text: "/now ship it" }), { command: "interrupt", rawCommand: "now", text: "ship it" });
  assert.deepEqual(parseThreadInputCommand({ text: "/now" }), { command: "interrupt", rawCommand: "now", text: "" });
  assert.equal(parseThreadInputCommand({ text: "/interrupt ship it" }).command, "stop");
  assert.equal(parseThreadInputCommand({ text: "/nowhere" }).command, null);
  assert.equal(parseThreadInputCommand({ text: "/now ship it", commandProcessing: "disabled" }).command, null);
});

test("instant interrupt capability covers Codex and Claude Code with a Claude kill switch", () => {
  assert.equal(isInstantInterruptCapableThread(claudeThread, {}), true);
  assert.equal(isInstantInterruptCapableThread(claudeThread, { ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT: "0" }), false);
  assert.equal(isInstantInterruptCapableThread(codexThread, { ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT: "0" }), true);
  assert.equal(isInstantInterruptCapableThread({ runtimeKind: "api-agent", executorId: "api-agent" }, {}), false);
  assert.equal(isCodexSteerCapableThread(claudeThread), false);
  assert.equal(isCodexSteerCapableThread(codexThread), true);
});

test("Claude Code steer and /now input report no queue state while a turn runs", () => {
  assert.equal(initialQueueDeliveryState(claudeWorking, steer, {}), "");
  assert.equal(initialQueueDeliveryState(claudeWorking, { role: "user", text: "/now do this instead" }, {}), "");
  assert.equal(initialQueueDeliveryState(claudeWorking, { role: "user", text: "plain queued" }, {}), "awaiting_runtime_completion");
  assert.equal(initialQueueDeliveryState(claudeWorking, { ...steer, codexDeliveryMode: "passive", steerActiveTurn: false }, {}), "awaiting_runtime_completion");
  assert.equal(initialQueueDeliveryState(claudeWorking, steer, { ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT: "off" }), "awaiting_runtime_completion");
  assert.equal(initialQueueDeliveryState(claudeWorking, { role: "user", text: "/now" }, {}), "interrupting");
  assert.equal(initialQueueDeliveryState({ runtimeKind: "codex-app-server", state: "working" }, { role: "user", text: "/now do it" }, {}), "interrupting");
});

test("WhatsApp inbound marks Claude Code threads for instant interrupt unless opted out", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-claude-interrupt-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  const base = { executorId: "claude-code", runtimeKind: "claude-code", executor: { type: "claude-code", metadata: { runtimeKind: "claude-code" } } };
  await createThread({ ...base, id: "wa-claude-default", name: "WA Claude Default", binding: { connector: "whatsapp", chatId: "chat-claude-default", enabled: true } }, env);
  await createThread({ ...base, id: "wa-claude-opt-out", name: "WA Claude Opt Out", binding: { connector: "whatsapp", chatId: "chat-claude-opt-out", enabled: true, inboundDeliveryMode: "queue" } }, env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const steered = await routeWhatsAppInbound({ eventId: "wa-claude-1", chatId: "chat-claude-default", accountId: "account-1", text: "actually do this" }, env);
  assert.equal(steered.threadId, "wa-claude-default");
  assert.equal(steered.message.steerActiveTurn, true);
  assert.equal(steered.message.codexDeliveryMode, "instant_steer");

  const optedOut = await routeWhatsAppInbound({ eventId: "wa-claude-2", chatId: "chat-claude-opt-out", accountId: "account-1", text: "queue this" }, env);
  assert.notEqual(optedOut.message.steerActiveTurn, true);

  const killSwitch = await routeWhatsAppInbound({ eventId: "wa-claude-3", chatId: "chat-claude-default", accountId: "account-1", text: "kill switch" }, {
    ...env,
    ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT: "0",
  });
  assert.notEqual(killSwitch.message.steerActiveTurn, true);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("CLI interrupt and send --now post interrupt-and-send requests", async () => {
  assert.deepEqual(parseInterruptArgs(["Demo", "do", "this", "--json"]), { target: "Demo", text: "do this", json: true, idempotencyKey: "" });

  const seen = [];
  const stdout = capture();
  assert.equal(await runCli(["interrupt", "Demo"], { stdout, stderr: capture(), fetchImpl: recordingFetch(seen, { ok: true, interrupted: true }) }), 0);
  assert.deepEqual(seen[0], { path: "/api/threads/Demo/interrupt", method: "POST", body: { source: "cli" } });
  assert.match(stdout.text(), /^Interrupted Demo/);

  const nowOut = capture();
  assert.equal(await runCli(["send", "Demo", "ship", "it", "--now"], { stdout: nowOut, stderr: capture(), fetchImpl: recordingFetch(seen, { ok: true, interrupted: true }) }), 0);
  assert.deepEqual(seen[1], { path: "/api/threads/Demo/interrupt", method: "POST", body: { source: "cli", text: "ship it" } });
  assert.match(nowOut.text(), /^Interrupted and sent Demo/);

  const jsonOut = capture();
  assert.equal(await runCli(["interrupt", "Demo", "new", "direction", "--json"], { stdout: jsonOut, stderr: capture(), fetchImpl: recordingFetch(seen, { ok: true, interrupted: false }) }), 0);
  assert.equal(seen[2].body.text, "new direction");
  assert.equal(JSON.parse(jsonOut.text()).interrupted, false);

  const stderr = capture();
  assert.equal(await runCli(["send", "Demo", "--now"], { stdout: capture(), stderr, fetchImpl: recordingFetch(seen, {}) }), 1);
  assert.match(stderr.text(), /orkestr send <thread> "<message>" --now/);

  const help = capture();
  await runCli(["--help"], { stdout: help, stderr: capture() });
  assert.match(help.text(), /orkestr interrupt <thread-name-or-id>/);
  assert.match(help.text(), /--now/);
});
