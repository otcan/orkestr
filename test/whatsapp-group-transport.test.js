import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWhatsAppGroupForStatus, resolveWhatsAppGroupRuntimeAccounts } from "../packages/connectors/src/whatsapp-group-transport.js";
import { createAndBindWhatsAppThreadGroup, createExternalWhatsAppChat } from "../packages/connectors/src/whatsapp-thread-groups.js";
import { createLocalWhatsAppChat } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { unknownWhatsAppGroupAccountError } from "../packages/connectors/src/whatsapp-group-create-evidence.js";
import { createThread, getThread } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { createConnectorsMcpGateway } from "../scripts/orkestr-connectors-mcp.mjs";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

const canonical = "15550000001";
const status = {
  mode: "worker",
  accounts: [{ id: canonical, accountId: canonical, runtimeAccountId: "sender", contactId: `${canonical}@c.us` }],
  health: { accounts: [{ id: "sender" }] },
};
const input = { name: "Example project", senderAccountId: canonical, responderAccountId: canonical };

for (const mode of ["local", "worker"]) {
  test(`${mode} group transport resolves canonical IDs and preserves callbacks`, async () => {
    const callback = () => {};
    const source = { ...input, onGroupCreated: callback, operationId: "wgp_test", correlationId: "cor_test" };
    let calls = 0;
    const create = async (actual) => {
      calls++;
      assert.equal(actual.senderAccountId, "sender");
      assert.equal(actual.responderAccountId, "sender");
      assert.equal(actual.onGroupCreated, callback);
      assert.equal(actual.operationId, "wgp_test");
      assert.equal(actual.correlationId, "cor_test");
      return { ok: true };
    };
    const unexpected = () => assert.fail("wrong transport");
    await createWhatsAppGroupForStatus(source, { ...status, mode }, {}, {
      createLocal: mode === "local" ? create : unexpected,
      createExternal: mode === "worker" ? create : unexpected,
    });
    assert.equal(calls, 1);
    assert.equal(source.senderAccountId, canonical);
  });
}

test("runtime aliases work, distinct reply accounts resolve, and external namespaces are untouched", () => {
  const accounts = [...status.accounts, { id: "15550000002", runtimeAccountId: "reply" }];
  const mapped = resolveWhatsAppGroupRuntimeAccounts({ ...input, senderAccountId: "sender", responderAccountId: "15550000002" }, { ...status, accounts }, {});
  assert.equal(mapped.senderAccountId, "sender");
  assert.equal(mapped.responderAccountId, "reply");
  assert.equal(resolveWhatsAppGroupRuntimeAccounts(input, { mode: "external" }, {}), input);
});

test("unmapped managed account rejects before any transport call", async () => {
  let calls = 0;
  await assert.rejects(async () => createWhatsAppGroupForStatus({ ...input, responderAccountId: "missing" }, status, {}, {
    createExternal: () => { calls++; },
  }), (error) => {
    assert.equal(error.message, "unknown_whatsapp_account");
    assert.equal(error.groupCreateFailure.externalOutcome, "not_created");
    assert.equal(error.groupCreateFailure.nextAction, "check_account_mapping");
    assert.equal(error.groupCreateFailure.retryable, false);
    return true;
  });
  assert.equal(calls, 0);
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, create) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wa-group-transport-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WA_SERVICE_TOKEN: "fixture-token",
    WHATSAPP_BRIDGE_TOKEN: "fixture-token",
    ORKESTR_WA_WORKER_TOKEN: "fixture-token",
    ORKESTR_CONNECTORS_MCP_HOST: "127.0.0.1",
    ORKESTR_CONNECTORS_MCP_LEGACY_REST: "1",
    ORKESTR_CONNECTOR_INBOX_RETRY_INTERVAL_MS: "600000",
  };
  const calls = [];
  const worker = createOrkestrWaService({ env, bridge: {
    createLocalWhatsAppChat: async (payload) => { calls.push({ action: "create", payload }); return create(payload); },
    completeLocalWhatsAppGroupSetup: async (payload) => { calls.push({ action: "setup", payload }); return { ok: true }; },
  } });
  env.ORKESTR_WA_WORKER_URL = await listen(worker);
  const gateway = createConnectorsMcpGateway({ env });
  const server = http.createServer(gateway.app);
  const url = await listen(server);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: url }, env);
  t.after(async () => {
    gateway.close();
    await Promise.all([server, worker].map((s) => new Promise((resolve) => s.close(resolve))));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, calls };
}

test("canonical binding stays canonical through gateway create and deferred setup, with no duplicate create", async (t) => {
  const f = await fixture(t, async (payload) => {
    assert.equal(payload.senderAccountId, "sender");
    assert.equal(payload.responderAccountId, "sender");
    assert.equal(payload.deferSetup, true);
    assert.ok(payload.operationId);
    return { ok: true, chat: { id: "fixture-group@g.us" }, setupPending: true };
  });
  const thread = await createThread({ id: "fixture-thread", name: "Example", ownerUserId: "owner" }, f.env);
  const options = { ...input, participantIds: ["15550000003@c.us"], adminParticipantIds: ["15550000003@c.us"], generatePicture: true };
  const dependencies = { createChat: (args) => createWhatsAppGroupForStatus(args, status, f.env) };
  const result = await createAndBindWhatsAppThreadGroup(thread, options, f.env, dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.binding.responderAccountId, canonical);
  assert.equal(result.binding.senderAccountId, canonical);
  assert.deepEqual(f.calls.map((c) => c.action), ["create", "setup"]);
  assert.equal(f.calls[1].payload.accountId, "sender");
  assert.deepEqual(f.calls[1].payload.adminParticipantIds, options.adminParticipantIds);
  assert.equal(f.calls[1].payload.generatePicture, true);
  await createAndBindWhatsAppThreadGroup(await getThread(thread.id, f.env), options, f.env, dependencies);
  assert.equal(f.calls.filter((c) => c.action === "create").length, 1);
});

test("worker account rejection survives service, gateway and durable provisioning without retries", async (t) => {
  // Real pre-dispatch worker validation; no WhatsApp browser/client is started.
  const f = await fixture(t, (payload) => createLocalWhatsAppChat(payload));
  const thread = await createThread({ id: "rejected-thread", name: "Example", ownerUserId: "owner" }, f.env);
  const options = { ...input, operationId: "wgp_invalid" };
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(thread, options, f.env), (error) => {
    assert.equal(error.groupCreateFailure.code, "unknown_whatsapp_account");
    assert.equal(error.groupCreateFailure.stage, "prepared");
    assert.equal(error.groupCreateFailure.externalOutcome, "not_created");
    assert.equal(error.groupCreateFailure.retryable, false);
    return true;
  });
  const saved = await getThread(thread.id, f.env);
  assert.equal(saved.whatsappGroupProvisioning.state, "rejected");
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(saved, options, f.env));
  assert.equal(f.calls.length, 1);
});

test("gateway preserves only public failure fields, and unstructured failures stay ambiguous", async (t) => {
  const f = await fixture(t, () => {
    const error = unknownWhatsAppGroupAccountError({ operationId: "wgp_fixture" });
    error.groupCreateFailure.privateDetails = "never expose this";
    throw error;
  });
  await assert.rejects(() => createExternalWhatsAppChat(input, f.env), (error) => {
    assert.equal(error.groupCreateFailure.code, "unknown_whatsapp_account");
    assert.equal(error.groupCreateFailure.privateDetails, undefined);
    return true;
  });
  const thread = await createThread({ id: "ambiguous-thread", name: "Example" }, f.env);
  const dependencies = { createChat: () => { throw new Error("transport failure"); } };
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(thread, input, f.env, dependencies), (error) => {
    assert.equal(error.groupCreateFailure.externalOutcome, "outcome_unknown");
    assert.equal(error.groupCreateFailure.retryable, false);
    return true;
  });
});
