import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createThread, updateThread, getThread, listThreadMessages, appendThreadMessage } from "../packages/core/src/threads.js";
import { resolveCodexThreadSettingsCommand } from "../packages/core/src/codex-thread-settings.js";
import { executeSettingsCommand } from "../packages/core/src/codex-settings-command-control.js";
import { settingsOperationKey, runSettingsOperation, readSettingsOperation, recordSettingsReplyState } from "../packages/core/src/codex-settings-operations.js";
import { handleWhatsAppSettingsCommand, deliverWhatsAppSettingsReplies } from "../packages/connectors/src/whatsapp-settings-command.js";
import { ensureConnectorOutboxJob, listConnectorOutboxJobs, writeConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { upsertWhatsAppBindingRecord } from "../packages/connectors/src/whatsapp-binding-registry.js";
import { whatsappDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { CodexAppServerClient, stopCodexAppServerClients } from "../packages/core/src/codex-app-server-client.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";

const models = [{ id: "gpt-example", isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"], serviceTiers: [{ id: "priority", name: "Fast" }] }];
const principal = { kind: "user", userId: "admin", role: "admin" };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-settings-control-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_CONNECTOR_OUTBOX_STORE: "json",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  t.after(() => { stopCodexAppServerClients(); return fs.rm(home, { recursive: true, force: true }); });
  const created = await createThread({ id: "settings-test", name: "Settings test", cwd: home, ownerUserId: "admin",
    runtimeKind: "codex-app-server", executor: { type: "codex", transport: "codex-app-server" },
    binding: { connector: "whatsapp", chatId: "test-group@g.us", accountId: "test-account", enabled: true,
      inboundSecurity: { mode: "owner-only", ownerParticipantIds: ["15550000111@c.us"], trustedParticipantIds: ["15550000222@c.us"] } },
  }, env);
  const thread = await updateThread(created.id, { codexThreadId: "fake-generation", codexModel: "gpt-example", codexReasoningEffort: "medium" }, env);
  const calls = [];
  const client = { async request(method, params) { calls.push({ method, params }); return method === "model/list" ? { data: models } : {}; } };
  const input = { thread, text: "/fast toggle", senderEffectiveRole: "owner", accountId: "test-account",
    chatId: "test-group@g.us", canonicalEventId: "source-event", client };
  return { home, env, thread, client, calls, input };
}

test("status aliases never mutate; setters and case-insensitive aliases are exact", () => {
  for (const command of ["model", "effort", "fast"]) {
    for (const text of ["", "STATUS"]) {
      const resolved = resolveCodexThreadSettingsCommand({ command: command.toUpperCase(), text, models });
      assert.equal(resolved.action, "status", command + " " + text);
      assert.equal(resolved.runtimePatch, undefined);
    }
    assert.equal(resolveCodexThreadSettingsCommand({ command, text: "status extra", models }).ok, false);
  }
  for (const text of ["enable", "ENABLED", "on", "toggle"]) {
    assert.deepEqual(resolveCodexThreadSettingsCommand({ command: "fast", text, models }).runtimePatch, { serviceTier: "priority" });
  }
  for (const text of ["disable", "DISABLED", "off"]) {
    assert.deepEqual(resolveCodexThreadSettingsCommand({ command: "fast", text, models }).runtimePatch, { serviceTier: null });
  }
  assert.equal(resolveCodexThreadSettingsCommand({ command: "fast", text: "enable extra", models }).ok, false);
});

test("all status queries perform catalog reads but zero mutation/turn RPCs", async t => {
  const f = await fixture(t);
  for (const text of ["/model", "/MODEL status", "/effort", "/EFFORT STATUS", "/fast", "/FAST STATUS"]) {
    const result = await executeSettingsCommand({ thread: f.thread, principal, text, client: f.client }, f.env);
    assert.equal(result.ok, true);
    assert.equal(result.action, "status");
  }
  assert.deepEqual(f.calls.map(c => c.method), Array(6).fill("model/list"));
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
});

test("concurrent/duplicate events and outbox pruning cannot repeat mutation or send", async t => {
  const f = await fixture(t);
  resetObservabilityForTests();
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => handleWhatsAppSettingsCommand(f.input, f.env)));
  assert.equal(outcomes.filter(r => !r.duplicate).length, 1);
  assert.deepEqual(f.calls.map(c => c.method), ["model/list", "thread/settings/update"]);
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
  let jobs = (await listConnectorOutboxJobs({}, f.env)).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].deliveryType, "control_reply");
  const auditFiles = await fs.readdir(path.join(f.home, "settings-control-operations"));
  assert.equal(auditFiles.length, 1);
  const audit = await fs.readFile(path.join(f.home, "settings-control-operations", auditFiles[0]), "utf8");
  assert.doesNotMatch(audit, /test-account|test-group|source-event|15550000|fake-generation|\/fast toggle/);
  let sends = 0;
  const send = async () => { sends++; return { ids: ["mock-ack"] }; };
  await Promise.all([deliverWhatsAppSettingsReplies(f.env, send), deliverWhatsAppSettingsReplies(f.env, send)]);
  assert.equal(sends, 1);
  jobs = (await listConnectorOutboxJobs({}, f.env)).jobs;
  assert.equal(jobs[0].state, "delivered");
  await writeConnectorOutbox({ jobs: [] }, f.env);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  await deliverWhatsAppSettingsReplies(f.env, send);
  assert.equal(sends, 1);
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").length, 1);
  assert.match(renderOpenMetrics(f.env), /orkestr_settings_command_deduplicated_total/);
});

test("ambiguous transport response is durable delivery_unknown, never blindly replayed", async t => {
  const f = await fixture(t);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  let sends = 0;
  const send = async () => { sends++; throw Error("private transport endpoint and credentials"); };
  await deliverWhatsAppSettingsReplies(f.env, send);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  await deliverWhatsAppSettingsReplies(f.env, send);
  const [job] = (await listConnectorOutboxJobs({}, f.env)).jobs;
  assert.equal(sends, 1);
  assert.equal(job.state, "delivery_uncertain");
  assert.equal(job.metadata.controlReplyOutcome, "delivery_unknown");
  assert.doesNotMatch(JSON.stringify(job), /private transport/);
});

test("post-send process-death fence survives restart and a lost receipt", async t => {
  const f = await fixture(t);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  const [job] = (await listConnectorOutboxJobs({}, f.env)).jobs;
  await recordSettingsReplyState(job.metadata.settingsOperationKey, "delivery_unknown", f.env);
  await deliverWhatsAppSettingsReplies(f.env, () => assert.fail("must not resend"));
  assert.equal((await listConnectorOutboxJobs({}, f.env)).jobs[0].state, "delivery_uncertain");
});

test("untrusted effective roles, contained policy, terminal and attachments never call provider", async t => {
  const f = await fixture(t);
  for (const senderEffectiveRole of ["trusted", "unknown", "blocked", ""]) {
    const result = await handleWhatsAppSettingsCommand({ ...f.input, senderEffectiveRole, canonicalEventId: senderEffectiveRole || "empty" }, f.env);
    assert.equal(result.outcome, "denied");
  }
  assert.equal((await executeSettingsCommand({ thread: f.thread, text: "/model", principal: { userId: "outsider" }, client: f.client }, f.env)).outcome, "denied");
  assert.equal((await handleWhatsAppSettingsCommand({ ...f.input, canonicalEventId: "attachments", hasAttachments: true }, f.env)).outcome, "invalid");
  for (const patch of [{ ownerUserId: "contained-user" }, { ownerUserId: "admin", runtimeKind: "raw-terminal", executor: { type: "codex", transport: "tmux" }, codexThreadId: null }]) {
    const thread = await updateThread(f.thread.id, patch, f.env);
    const result = await handleWhatsAppSettingsCommand({ ...f.input, thread, canonicalEventId: patch.ownerUserId }, f.env);
    assert.equal(result.outcome, "read_only");
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
});

test("provider uncertainty and private errors remain guarded across replay", async t => {
  const f = await fixture(t);
  f.client.request = async method => {
    f.calls.push({ method });
    if (method === "model/list") return { data: models };
    throw Error("secret raw provider message https://private.invalid");
  };
  const first = await handleWhatsAppSettingsCommand(f.input, f.env);
  assert.equal(first.outcome, "unconfirmed");
  await handleWhatsAppSettingsCommand(f.input, f.env);
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").length, 1);
  assert.equal((await getThread(f.thread.id, f.env)).codexSettingsUncertain, true);
  const [job] = (await listConnectorOutboxJobs({}, f.env)).jobs;
  assert.doesNotMatch(JSON.stringify(await readSettingsOperation(job.metadata.settingsOperationKey, f.env)), /secret|private.invalid/);
});

test("operation key scopes independent source events and channels", async t => {
  const f = await fixture(t);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  await handleWhatsAppSettingsCommand({ ...f.input, canonicalEventId: "second-event" }, f.env);
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").length, 2);
  assert.equal((await getThread(f.thread.id, f.env)).codexServiceTier, null);
  assert.notEqual(settingsOperationKey(["whatsapp", "one", "account", "chat", "thread", "event"]), settingsOperationKey(["whatsapp", "two", "account", "chat", "thread", "event"]));
});

test("journal serializes independent processes and never reexecutes after restart", async t => {
  const f = await fixture(t);
  const key = settingsOperationKey(["cross-process"]);
  const module = new URL("../packages/core/src/codex-settings-operations.js", import.meta.url).href;
  const source = `
    import { runSettingsOperation } from ${JSON.stringify(module)};
    import { appendFile } from "node:fs/promises";
    await runSettingsOperation({ key: process.argv[2], surface: "whatsapp", command: "fast" }, async () => {
      await appendFile(process.argv[1] + "/calls", "mutation\\n");
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ok: true, replyText: "Done" };
    }, { ORKESTR_HOME: process.argv[1] });
  `;
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, f.home, key], { env: { PATH: process.env.PATH }, timeout: 20000 });
  await Promise.all([run(), run()]);
  await run();
  assert.equal(await fs.readFile(path.join(f.home, "calls"), "utf8"), "mutation\n");
  const interrupted = settingsOperationKey(["interrupted"]);
  await fs.writeFile(path.join(f.home, "settings-control-operations", interrupted + ".json"), JSON.stringify({ version: 1, operationKey: interrupted, startedAt: new Date().toISOString() }));
  assert.equal((await runSettingsOperation({ key: interrupted, surface: "whatsapp", command: "fast" }, () => assert.fail("must not reexecute"), f.env)).outcome, "unconfirmed");
});

test("footer advertises commands only on supported writable settings", async t => {
  const f = await fixture(t);
  assert.match(whatsappDebugFooter({ thread: f.thread, env: f.env }), /model:\/model · effort:\/effort · fast:\/fast/);
  for (const thread of [{ ...f.thread, codexSettingsUncertain: true }, { ...f.thread, ownerUserId: "contained-user" }, { id: "terminal" }]) {
    assert.doesNotMatch(whatsappDebugFooter({ thread, env: f.env }), /model:\/model|effort:\/effort|fast:\/fast/);
  }
});

test("real WhatsApp ingress intercepts before canonical history and deduplicates canonical event aliases", async t => {
  const f = await fixture(t);
  t.mock.method(CodexAppServerClient.prototype, "start", async function () { return this; });
  t.mock.method(CodexAppServerClient.prototype, "request", f.client.request);
  const input = { eventId: "false_test-group@g.us_event", chatId: "test-group@g.us",
    accountId: "test-account", from: "15550000111@c.us", text: "/fast toggle" };
  const first = await routeWhatsAppInbound(input, f.env);
  assert.equal(first.controlCommand, "fast");
  assert.equal(first.ok, true);
  const second = await routeWhatsAppInbound({ ...input, eventId: "true_test-group@g.us_event" }, f.env);
  assert.equal(second.duplicate, true);
  const edited = await routeWhatsAppInbound({ ...input, text: "Changed non-command body" }, f.env);
  assert.equal(edited.duplicate, true);
  const denied = await routeWhatsAppInbound({ ...input, eventId: "untrusted-event", from: "15550000222@c.us",
    senderEffectiveRole: "owner", senderTrustLevel: "owner", text: "/model" }, f.env);
  assert.equal(denied.outcome, "denied");
  assert.deepEqual(f.calls.map(c => c.method), ["model/list", "thread/settings/update"]);
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
});

test("accepted RPC followed by process death is not reissued and preserves the uncertainty guard", async t => {
  const f = await fixture(t);
  const controller = new URL("../packages/connectors/src/whatsapp-settings-command.js", import.meta.url).href;
  const threads = new URL("../packages/core/src/threads.js", import.meta.url).href;
  const source = `
    import { handleWhatsAppSettingsCommand } from ${JSON.stringify(controller)};
    import { getThread } from ${JSON.stringify(threads)};
    import { appendFile } from "node:fs/promises";
    const env = { ORKESTR_HOME: process.argv[1], ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_CONNECTOR_OUTBOX_STORE: "json" };
    const client = { async request(method) {
      if (method === "model/list") return { data: ${JSON.stringify(models)} };
      await appendFile(process.argv[1] + "/accepted-rpcs", method + "\\n");
      process.kill(process.pid, "SIGKILL");
    } };
    await handleWhatsAppSettingsCommand({ thread: await getThread("settings-test", env), text: "/fast toggle",
      senderEffectiveRole: "owner", accountId: "test-account", chatId: "test-group@g.us",
      canonicalEventId: "source-event", client }, env);
  `;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, f.home],
    { env: { PATH: process.env.PATH }, timeout: 15000 }), error => error.signal === "SIGKILL");
  assert.equal((await getThread(f.thread.id, f.env)).codexSettingsUncertain, true);
  const result = await handleWhatsAppSettingsCommand(f.input, f.env);
  assert.equal(result.outcome, "unconfirmed");
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.home, "accepted-rpcs"), "utf8"), "thread/settings/update\n");
  let replies = 0;
  await deliverWhatsAppSettingsReplies(f.env, async ({ text }) => {
    assert.match(text, /interrupted/); replies++; return { id: "recovery-reply" };
  });
  await deliverWhatsAppSettingsReplies(f.env, () => assert.fail("no duplicate recovery reply"));
  assert.equal(replies, 1);
});

test("command rollback fails closed but does not change the model-settings API policy", async t => {
  const f = await fixture(t);
  const env = { ...f.env, ORKESTR_SETTINGS_COMMANDS_ENABLED: "0" };
  const result = await handleWhatsAppSettingsCommand(f.input, env);
  assert.equal(result.outcome, "read_only");
  assert.match(result.replyText, /Use model settings in the WebUI/);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(whatsappDebugFooter({ thread: f.thread, env }), /model:\/model/);
});

test("intent persisted before journal creation also blocks changed-body replay", async t => {
  const f = await fixture(t);
  const key = settingsOperationKey(["whatsapp", "admin", f.input.accountId, f.input.chatId, f.thread.id, f.input.canonicalEventId]);
  await ensureConnectorOutboxJob({ connector: "whatsapp", deliveryType: "control_reply", ownerUserId: "admin",
    threadId: f.thread.id, accountId: f.input.accountId, chatId: f.input.chatId, sourceMessageId: key,
    idempotencyKey: "settings-control:" + key, metadata: { settingsOperationKey: key, settingsCommand: "fast" } }, f.env);
  const result = await handleWhatsAppSettingsCommand({ ...f.input, text: "Changed non-command body" }, f.env);
  assert.equal(result.outcome, "unconfirmed");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
});

test("reply uses canonical registry binding, not a stale disabled legacy binding", async t => {
  const f = await fixture(t);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  await updateThread(f.thread.id, { binding: { ...f.thread.binding, enabled: false } }, f.env);
  await upsertWhatsAppBindingRecord({ id: "registry-test", level: "chat", threadId: f.thread.id,
    ownerUserId: "admin", accountId: f.input.accountId, chatId: f.input.chatId,
    responderConnectorAccountId: f.input.accountId, enabled: true, routeEligible: true }, f.env);
  let sent = 0;
  await deliverWhatsAppSettingsReplies(f.env, async () => { sent++; return { id: "canonical-reply" }; });
  assert.equal(sent, 1);
});

for (const change of ["owner", "account"]) test("pending reply is suppressed after " + change + " changes", async t => {
  const f = await fixture(t);
  await handleWhatsAppSettingsCommand(f.input, f.env);
  await updateThread(f.thread.id, change === "owner" ? { ownerUserId: "another-user" }
    : { binding: { ...f.thread.binding, accountId: "another-account" } }, f.env);
  await deliverWhatsAppSettingsReplies(f.env, () => assert.fail("must not deliver to changed binding"));
  assert.equal((await listConnectorOutboxJobs({}, f.env)).jobs[0].state, "suppressed");
});

test("history leak backstop emits a bounded metric and alert", async t => {
  const f = await fixture(t);
  resetObservabilityForTests();
  await appendThreadMessage(f.thread.id, { role: "user", source: "ui", text: "/fast" }, f.env);
  assert.match(renderOpenMetrics(f.env), /orkestr_settings_history_leak_total\{surface="webui"\} 1/);
});

test("effort setter issues exactly one correlated update; invalid effort issues none", async t => {
  const f = await fixture(t);
  const invalid = await handleWhatsAppSettingsCommand({ ...f.input, text: "/effort extreme", canonicalEventId: "invalid-effort" }, f.env);
  assert.equal(invalid.outcome, "invalid");
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").length, 0);
  const applied = await handleWhatsAppSettingsCommand({ ...f.input, text: "/EFFORT HIGH", canonicalEventId: "effort-event" }, f.env);
  assert.equal(applied.ok, true);
  const updates = f.calls.filter(c => c.method === "thread/settings/update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params.threadId, "fake-generation");
  assert.equal(updates[0].params.effort, "high");
  assert.equal((await getThread(f.thread.id, f.env)).codexReasoningEffort, "high");
  assert.ok(f.calls.every(c => !["turn/start", "turn/steer"].includes(c.method)));
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
  assert.equal((await listConnectorOutboxJobs({}, f.env)).jobs.filter(job => job.deliveryType === "control_reply").length, 2);
});

test("WhatsApp admin role may use model controls; bare /fast stays status-only", async t => {
  const f = await fixture(t);
  const result = await handleWhatsAppSettingsCommand({ ...f.input, text: "/fast", senderEffectiveRole: "admin", canonicalEventId: "admin-event" }, f.env);
  assert.equal(result.ok, true);
  assert.equal(result.action, "status");
  assert.match(result.replyText, /Fast mode is off/);
  assert.deepEqual(f.calls.map(c => c.method), ["model/list"]);
  assert.deepEqual(await listThreadMessages(f.thread.id, f.env), []);
});
