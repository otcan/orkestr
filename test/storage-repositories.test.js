import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConnectorStateRepository,
  createTimerRepository,
  createUserIdentityRepository,
  createUserRepository,
  createThreadMessageRepository,
  createThreadRepository,
} from "../packages/storage/src/repositories.js";

test("storage repositories wrap thread, message, timer, user, and connector state files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-repositories-"));
  const env = { ORKESTR_HOME: home };

  const threads = createThreadRepository(env);
  await threads.save([{ id: "thread-1", name: "Thread 1" }]);
  assert.deepEqual(await threads.list(), [{ id: "thread-1", name: "Thread 1" }]);

  const messages = createThreadMessageRepository(env);
  const messagePath = await messages.pathForThread("../unsafe/thread");
  assert.equal(path.basename(messagePath), ".._unsafe_thread.json");
  await messages.save("../unsafe/thread", [{ id: "message-1", text: "hello" }]);
  assert.deepEqual(await messages.list("../unsafe/thread"), [{ id: "message-1", text: "hello" }]);

  const connectors = createConnectorStateRepository(env);
  await connectors.writeWhatsAppState({ inboundEvents: [{ eventId: "event-1" }] });
  assert.deepEqual(await connectors.readWhatsAppState({}), { inboundEvents: [{ eventId: "event-1" }] });

  const timers = createTimerRepository(env);
  await timers.save([{ id: "timer-1", target: "thread-1" }]);
  assert.deepEqual(await timers.list(), [{ id: "timer-1", target: "thread-1" }]);

  const users = createUserRepository(env);
  await users.save([{ id: "alice", role: "user" }]);
  assert.deepEqual(await users.list(), [{ id: "alice", role: "user" }]);

  const identities = createUserIdentityRepository(env);
  await identities.save("../alice", [{ provider: "whatsapp", externalId: "sender-1" }]);
  assert.deepEqual(await identities.list("../alice"), [{ provider: "whatsapp", externalId: "sender-1" }]);
});
