import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadsController } from "../dist/server/apps/server/src/modules/threads/threads.controller.js";
import { createThread, listThreadMessages } from "../dist/server/packages/core/src/threads.js";

test("authenticated input authors worker reply intent, rejects spoofing and keeps retries idempotent", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-worker-reply-api-"));
  const prior = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    if (prior === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
  });
  const parent = await createThread({ id: "parent", ownerUserId: "admin", name: "Parent" });
  const worker = await createThread({ id: "worker", ownerUserId: "admin", name: "Worker", parentThreadId: parent.id, threadKind: "worker",
    binding: { connector: "whatsapp", chatId: "worker-chat", responderAccountId: "account-a" } });
  const checks = [];
  const controller = new ThreadsController({ async assertAllowed(...args) { checks.push(args); } }, {
    status: () => assert.fail("test must not start a runtime"),
  });
  const request = { orkestrPrincipal: { kind: "user", userId: "admin", role: "admin" } };
  const base = { text: "Implement task", autoRun: false, workerReplyDelivery: "bound_whatsapp", clientMessageId: "task-one" };
  const accepted = await controller.input(request, worker.id, { ...base, source: "forged", connector: "whatsapp", chatId: "attacker", accountId: "attacker",
    replyDeliveryIntent: { serverAuthored: true, target: { chatId: "attacker" } } });
  assert.equal(accepted.message.source, "worker_assignment");
  assert.equal(accepted.message.replyDeliveryIntent.target.chatId, "worker-chat");
  assert.equal(accepted.message.replyDeliveryIntent.target.accountId, "account-a");
  assert.equal(accepted.message.replyDeliveryIntent.issuedFor, "worker-assignment");
  const repeat = await controller.input(request, worker.id, base);
  assert.equal(repeat.message.id, accepted.message.id);
  assert.equal(repeat.message.replyDeliveryIntent.id, accepted.message.replyDeliveryIntent.id);
  assert.equal((await listThreadMessages(worker.id)).length, 1);
  assert.ok(checks.length >= 2);
  const forged = await controller.input(request, worker.id, { text: "Private task", autoRun: false, source: "worker_assignment",
    originSurface: "orkestr-worker", originTransport: "authenticated-http", replyDeliveryIntent: accepted.message.replyDeliveryIntent });
  assert.equal(forged.message.replyDeliveryIntent, undefined);
  await assert.rejects(controller.input(request, parent.id, base), /worker_reply_worker_required/);
  await assert.rejects(controller.input({ orkestrPrincipal: { kind: "user", userId: "other", role: "admin" } }, worker.id, base), /worker_reply_owner_required/);
  await assert.rejects(controller.input(request, worker.id, { ...base, workerReplyDelivery: "all_chats" }), error => error.statusCode === 400 || error.status === 400);
});
