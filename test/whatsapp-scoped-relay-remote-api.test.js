import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Exercises the compiled controllers: relay input on a delegated thread is
// forwarded instead of queued locally, and the relay's receipt is recorded.
test("compiled thread input forwards delegated relay input and records the relay receipt", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-relay-remote-api-"));
  const env = {
    HOME: home, ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      example: { baseUrl: "http://runtime.example.test", token: "public-test-token" },
    }),
  };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const { appendThreadMessage, createThread, listThreadMessages } = await import("../dist/server/packages/core/src/threads.js");
  const binding = {
    connector: "whatsapp", chatId: "example-group@g.us", enabled: true, mirrorToWhatsApp: false,
    inboundAccountId: "example-account", remoteBackend: "example", remoteThreadId: "example-remote",
  };
  await createThread({ id: "example-delegated", ownerUserId: "admin", binding }, env);
  await createThread({ id: "example-mirrored", ownerUserId: "admin", binding: { ...binding, chatId: "other@g.us", mirrorToWhatsApp: true, remoteThreadId: "other" } }, env);
  const inputs = [];
  const acknowledgements = [];
  let remoteReply = null;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "runtime.example.test" && parsed.pathname === "/threads/example-remote/input") {
      inputs.push(JSON.parse(options.body));
      return Response.json({ ok: true, message: { id: "example-remote-user", state: "delivered", deliveryState: "delivered" } }, { status: 202 });
    }
    if (parsed.pathname === '/threads/example-remote/messages') return Response.json({messages: [
      {id: 'example-remote-user', role: 'user', state: 'delivered'},
      ...(remoteReply && !acknowledgements.length ? [remoteReply] : [])], mirrorAck: {version: 1, ackedThrough: acknowledgements.length}});
    if (parsed.pathname === '/threads/example-remote/mirror-acks') {
      acknowledgements.push(JSON.parse(options.body));
      return Response.json({ok: true, sequence: 1, ackedThrough: 1});
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  const { ThreadsController } = await import("../dist/server/apps/server/src/modules/threads/threads.controller.js");
  const { ThreadMessagesController } = await import("../dist/server/apps/server/src/modules/threads/thread-messages.controller.js");
  const controller = new ThreadsController({}, {});
  const body = { source: "whatsapp_group_relay", text: "[WhatsApp: Example]\n\nhello", parseCommands: false,
    controlAllowed: false, idempotencyKey: "group:example" };
  const first = await controller.input({}, "example-delegated", { ...body });
  assert.equal(first.remoteRuntime, true);
  assert.equal(first.reason, "remote_runtime_forwarded");
  assert.equal(first.message.remoteMessageId, "example-remote-user");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].publicMessageId, first.message.id);
  const retry = await controller.input({}, "example-delegated", { ...body });
  assert.equal(retry.message.id, first.message.id);
  assert.equal(inputs.length, 1, "an idempotent relay retry is not forwarded twice");
  await assert.rejects(controller.input({}, "example-mirrored", { ...body, idempotencyKey: "group:other" }),
    (error) => error.getStatus() === 409 && error.getResponse().error === "scoped_relay_delegation_requires_mirror_disabled");
  assert.equal((await listThreadMessages("example-mirrored", env)).length, 0);

  const reply = await appendThreadMessage("example-delegated", {
    role: "assistant", phase: "final_answer", state: "completed", source: "remote-runtime", text: "answer",
    parentMessageId: first.message.id, remoteBackend: "example", remoteThreadId: "example-remote", remoteMessageId: "example-remote-reply",
  }, env);
  remoteReply = {id: 'example-remote-reply', role: 'assistant', state: 'completed', phase: 'final_answer', text: 'answer',
    parentMessageId: 'example-remote-user', exportSequence: 1};
  const messages = new ThreadMessagesController({});
  const recorded = await messages.scopedRelayDelivery({}, "example-delegated", reply.id,
    { requestIds: ["reply:example"], connectorMessageIds: ["provider-1"] });
  assert.equal(recorded.deliveryState, "delivered");
  assert.equal(acknowledgements.length, 1, 'confirmed provider receipt is acknowledged immediately');
  assert.equal(acknowledgements[0].outcome, 'delivered');
  await assert.rejects(messages.scopedRelayDelivery({}, "example-delegated", first.message.id, { requestIds: ["reply:example"] }),
    (error) => error.getStatus() === 409);
});

test('remote change gateway requires admin and validates its configured backend', async () => {
  const {WhatsAppRemoteChangesController} = await import('../dist/server/apps/server/src/modules/connectors/whatsapp-remote-changes.controller.js');
  const controller = new WhatsAppRemoteChangesController();
  const request = {orkestrPrincipal: {kind: 'user', userId: 'guest', role: 'user'}};
  await assert.rejects(controller.watches(request), error => error.getStatus() === 403);
  await assert.rejects(controller.changes(request, {backend: 'example'}), error => error.getStatus() === 403);
  await assert.rejects(controller.sync(request, {backend: 'example', thread: 'example'}), error => error.getStatus() === 403);
  await assert.rejects(controller.changes({}, {backend: ['example']}), error => error.getStatus() === 400);
  await assert.rejects(controller.changes({}, {backend: 'unconfigured-backend'}), error => error.getStatus() === 404);
});
