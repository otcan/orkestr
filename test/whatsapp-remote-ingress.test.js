import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the compiled inbound controller does not run a delegated API-agent stop locally", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-ingress-"));
  const env = {
    HOME: home, ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
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
  const { createThread, listThreadMessages } = await import("../dist/server/packages/core/src/threads.js");
  const { writeConnectorConfig } = await import("../dist/server/packages/storage/src/config.js");
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://bridge.example.test" }, env);
  await createThread({
    id: "example-agent", ownerUserId: "admin", runtimeKind: "api-agent",
    executorId: "api-agent", executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: {
      connector: "whatsapp", chatId: "example-chat", responderAccountId: "example-account",
      remoteBackend: "example", remoteThreadId: "example-remote",
    },
  }, env);
  let inputs = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "runtime.example.test" && parsed.pathname.endsWith("/input")) {
      inputs += 1;
      assert.equal(JSON.parse(options.body).text, "/stop");
      return Response.json({ message: { id: "example-stop", state: "queued", deliveryState: "remote_pending" } });
    }
    if (parsed.host === "runtime.example.test" && parsed.pathname.endsWith("/messages")) {
      return Response.json({ messages: [] });
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  const { ConnectorsController } = await import("../dist/server/apps/server/src/modules/connectors/connectors.controller.js");
  const response = {
    code: null, body: null,
    status(code) { this.code = code; return this; },
    header() { return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
  await new ConnectorsController().whatsappInbound({}, {
    eventId: "example-stop-event", chatId: "example-chat", accountId: "example-account",
    from: "example-participant@lid", text: "/stop",
  }, response);
  assert.equal(response.code, 202);
  assert.equal(response.body.remoteRuntime, true);
  assert.equal(response.body.runtimeKind, undefined);
  assert.equal(inputs, 1, JSON.stringify(response.body));
  const rows = await listThreadMessages("example-agent", env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "queued");
  assert.equal(rows[0].deliveryState, "remote_pending");
  assert.equal(rows[0].remoteMessageId, "example-stop");
});
