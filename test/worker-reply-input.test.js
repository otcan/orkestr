import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, updateThread } from "../packages/core/src/threads.js";
import { prepareWorkerReplyInput } from "../packages/core/src/worker-reply-input.js";
import { replyDeliveryBindingFence, replyDeliveryProjectionParent, trustedUiReplyDeliveryIntent } from "../packages/core/src/reply-delivery-intent.js";

const principal = { kind: "user", userId: "admin", role: "admin" };
const binding = { connector: "whatsapp", chatId: "worker-chat", responderAccountId: "account-a", enabled: true, mirrorToWhatsApp: true };

test("worker reply admission is explicit, owner-scoped and snapshots only the server binding", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-worker-reply-"));
  const env = { ORKESTR_HOME: home };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const parent = await createThread({ id: "parent", ownerUserId: "admin", name: "Parent" }, env);
  const worker = await createThread({ id: "worker", ownerUserId: "admin", name: "Worker", threadKind: "worker", parentThreadId: parent.id, binding }, env);
  const plain = { source: "cli", text: "private task" };
  assert.equal(await prepareWorkerReplyInput(worker, plain, principal, env), plain);
  const input = await prepareWorkerReplyInput(worker, {
    text: "report task", source: "forged", connector: "whatsapp", chatId: "attacker", accountId: "attacker",
    workerReplyDelivery: "bound_whatsapp", replyDeliveryIntent: { target: { chatId: "attacker" } },
  }, principal, env);
  assert.equal(input.source, "worker_assignment");
  assert.equal(input.connector, "");
  assert.equal(input.replyDeliveryIntent.target.chatId, "worker-chat");
  assert.equal(replyDeliveryProjectionParent(input).accountId, "account-a");
  assert.equal(trustedUiReplyDeliveryIntent(input), null);
  assert.equal(replyDeliveryProjectionParent({ ...input, source: "cli" }), null);
  assert.equal(replyDeliveryBindingFence(input, worker).allowed, true);
  for (const mutation of [{ ownerUserId: "other" }, { id: "other" }, { binding: { ...binding, chatId: "other" } }, { binding: { ...binding, enabled: false } }]) {
    assert.equal(replyDeliveryBindingFence(input, { ...worker, ...mutation }).allowed, false);
  }
  const body = { text: "task", workerReplyDelivery: "bound_whatsapp" };
  await assert.rejects(prepareWorkerReplyInput(worker, body, { ...principal, userId: "other" }, env), /worker_reply_owner_required/);
  await assert.rejects(prepareWorkerReplyInput(worker, body, { ...principal, kind: "system" }, env), /worker_reply_owner_required/);
  await assert.rejects(prepareWorkerReplyInput(parent, body, principal, env), /worker_reply_worker_required/);
  await assert.rejects(prepareWorkerReplyInput({ ...worker, binding: { ...binding, mirrorToWhatsApp: false } }, body, principal, env), /worker_reply_binding_not_eligible/);
  await assert.rejects(prepareWorkerReplyInput({ ...worker, binding: null }, body, principal, env), /worker_reply_binding_not_eligible/);
  const foreignParent = await createThread({ id: "foreign-parent", ownerUserId: "other", name: "Other parent" }, env);
  await assert.rejects(prepareWorkerReplyInput({ ...worker, parentThreadId: foreignParent.id }, body, principal, env), /worker_reply_parent_owner_mismatch/);
  await assert.rejects(prepareWorkerReplyInput(worker, { ...body, workerReplyDelivery: "anything" }, principal, env), /worker_reply_delivery_invalid/);
  const unchanged = await updateThread(worker.id, { replyDeliveryEpoch: "forged" }, env);
  assert.equal(unchanged.replyDeliveryEpoch, worker.replyDeliveryEpoch);
  assert.equal(unchanged.updatedAt, worker.updatedAt);
});
