import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadsController } from "../dist/server/apps/server/src/modules/threads/threads.controller.js";
import { CodexAppServerClient, stopCodexAppServerClients } from "../dist/server/packages/core/src/codex-app-server-client.js";
import { createThread, updateThread, listThreadMessages } from "../dist/server/packages/core/src/threads.js";

test("typed WebUI commands, send-now and existing model-settings endpoints share controls without history", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-settings-api-"));
  const prior = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    stopCodexAppServerClients();
    if (prior === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = prior;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const calls = [];
  t.mock.method(CodexAppServerClient.prototype, "start", async function () { return this; });
  t.mock.method(CodexAppServerClient.prototype, "request", async method => {
    calls.push(method);
    assert.ok(["model/list", "thread/settings/update"].includes(method), method);
    return method === "model/list" ? { data: [{ id: "gpt-test", isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"],
      serviceTiers: [{ id: "priority", name: "Fast" }] }] } : {};
  });
  const thread = await createThread({ id: "api-settings", name: "API settings", cwd: home,
    runtimeKind: "codex-app-server", executor: { type: "codex", transport: "codex-app-server" } });
  await updateThread(thread.id, { codexThreadId: "test-generation", codexModel: "gpt-test", codexReasoningEffort: "medium" });
  let sanitized = 0;
  const controller = new ThreadsController({ async assertAllowed() { sanitized++; } }, {
    status: () => assert.fail("settings do not start or interrupt runtimes"),
  });
  const request = { orkestrPrincipal: { kind: "user", userId: "admin", role: "admin" } };
  const first = await controller.uiInput(request, thread.id, { text: "/fast toggle", clientMessageId: "command-one", replyDelivery: "ui_only" });
  assert.equal(first.controlCommand, true);
  assert.equal(first.ok, true);
  assert.equal(first.message, null);
  const repeat = await controller.uiInput(request, thread.id, { text: "/fast toggle", clientMessageId: "command-one", replyDelivery: "ui_only" });
  assert.equal(repeat.duplicate, true);
  assert.equal(calls.filter(c => c === "thread/settings/update").length, 1);
  const status = await controller.uiInput(request, thread.id, { text: "/effort", clientMessageId: "command-two", replyDelivery: "ui_only" });
  assert.match(status.replyText, /Supported efforts/);
  const interrupt = await controller.interrupt(request, thread.id, { text: "/model status", clientMessageId: "command-three" });
  assert.equal(interrupt.action, "status");
  const uiInterrupt = await controller.uiInterrupt(request, thread.id, { text: "/fast", clientMessageId: "command-four", replyDelivery: "bound_whatsapp" });
  assert.equal(uiInterrupt.action, "status");
  const settings = await controller.modelSettings(request, thread.id);
  assert.equal(settings.readOnly, false);
  assert.equal((await controller.updateModelSettings(request, thread.id, { model: "gpt-test", effort: "high" })).effort, "high");
  assert.equal(calls.filter(c => c === "thread/settings/update").length, 2);
  assert.deepEqual(await listThreadMessages(thread.id), []);
  assert.ok(sanitized >= 4);
  const before = calls.length;
  await assert.rejects(controller.uiInput({ orkestrPrincipal: { kind: "user", userId: "outsider", role: "user" } },
    thread.id, { text: "/model", replyDelivery: "ui_only" }), error => [403, 404].includes(error.statusCode));
  assert.equal(calls.length, before);
});

test("WebUI composer handles settings before optimistic history or interrupt dispatch", async () => {
  const source = await fs.readFile(new URL("../apps/web/src/app/app.component.ts", import.meta.url), "utf8");
  const send = source.slice(source.indexOf("async sendMessage()"), source.indexOf("async sendMessageNow()"));
  assert.ok(send.indexOf("settingsCommandReplies") < send.indexOf("appendOptimisticUserMessage"));
  assert.match(send, /timeout\(20000\)/);
  const now = source.slice(source.indexOf("async sendMessageNow()"), source.indexOf("async resendFailedMessage("));
  assert.ok(now.indexOf("return this.sendMessage()") < now.indexOf("appendOptimisticUserMessage"));
  const template = await fs.readFile(new URL("../apps/web/src/app/app.component.html", import.meta.url), "utf8");
  assert.match(template, /role="status"/);
  assert.match(template, /Dismiss settings result/);
});
