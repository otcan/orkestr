import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadBridgeController } from "../dist/server/apps/server/src/modules/threads/thread-bridge.controller.js";
import { createUser } from "../dist/server/packages/core/src/users.js";
import { createThread, listThreadMessages } from "../dist/server/packages/core/src/threads.js";
import { closeThreadMessageRegistryCache } from "../dist/server/packages/storage/src/thread-message-registry.js";

test("bridge controller never promotes body, header, browser or admin identity", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-bridge-api-"));
  const settings = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(async () => {
    await closeThreadMessageRegistryCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const identity = { kind: "delegated-agent", ownerUserId: "owner-example", agentId: "agent-example", grantId: "grant-example", issuer: "test-adapter", authMethod: "test" };
  await createUser({ id: identity.ownerUserId });
  await createThread({ id: "thread-example", ownerUserId: identity.ownerUserId });
  await fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify([{
    id: identity.grantId, ownerUserId: identity.ownerUserId, agentId: identity.agentId,
    issuer: identity.issuer, authMethod: identity.authMethod,
    enabled: true, expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: ["thread-example"],
  }]));
  const controller = new ThreadBridgeController();
  for (const request of [{}, { body: identity }, { headers: { "x-delegated-principal": JSON.stringify(identity) } }, { orkestrPrincipal: identity }, { orkestrPrincipal: { kind: "user", role: "admin", userId: identity.ownerUserId } }]) {
    await assert.rejects(controller.threads(request), /bridge_authentication_required/);
  }
  const request = { orkestrDelegatedPrincipal: identity };
  assert.deepEqual((await controller.threads(request)).threadIds, ["thread-example"]);
  await assert.rejects(controller.reply(request, "thread-example", { requestId: "request-example", text: "Hello", ownerUserId: "forged" }), /bridge_reply_invalid/);
  await controller.reply(request, "thread-example", { requestId: "request-example", text: "Hello" });
  const history = await controller.history(request, "thread-example", {});
  assert.equal(history.messages[0].actor.kind, "delegated-agent");
  assert.equal(history.messages[0].text, "Hello");
  assert.equal((await controller.changes(request, {})).events.length, 0);
  assert.equal((await listThreadMessages("thread-example"))[0].state, "completed");
  process.env.ORKESTR_THREAD_BRIDGE_ENABLED = "0";
  await assert.rejects(controller.threads(request), /thread_bridge_disabled/);
});
