import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  browserWhatsAppGroupCreate, createWhatsAppGroupWithClient, inspectWhatsAppGroupCreateProtocol,
} from "../packages/connectors/src/whatsapp-group-create-client.js";
import { publicWhatsAppGroupCreateFailure } from "../packages/connectors/src/whatsapp-group-create-evidence.js";
import { createLocalWhatsAppChat, setLocalWhatsAppRuntimeForTest, resetLocalWhatsAppBridgeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

function fixture({ create, resolve, missingModule } = {}) {
  const calls = { creates: [], queries: [], sdk: 0 };
  const modules = {
    WAWebGroupCreateJob: { async createGroup(options, participants) {
      calls.creates.push({ options, participants });
      return create ? create(options, participants) : { wid: { $1: "fake-group@g.us" } };
    } },
    WAWebWidFactory: { createWid(id) { return { $1: id }; } },
    WAWebQueryExistsJob: { async queryWidExists(wid) {
      calls.queries.push(wid.$1);
      return resolve ? resolve(wid) : { wid };
    } },
    WAWebUserPrefsMeUser: {
      getMaybeMePnUser() { return { _serialized: "15550000001@c.us" }; },
      getMaybeMeLidUser() { return { $1: "fake-self@lid" }; },
    },
  };
  const window = { Debug: { VERSION: "2.3000.1000000000" }, require(name) {
    if (name === missingModule || !modules[name]) throw Error("private-token private-title");
    return modules[name];
  } };
  const client = {
    pupPage: { async evaluate(fn, input) {
      return vm.runInNewContext(`(${fn.toString()})(input)`, { window, input });
    } },
    async createGroup() { calls.sdk += 1; throw Error("must not fall back after dispatch"); },
  };
  return { client, calls, modules };
}

test("group adapter omits creator aliases, deduplicates resolved participants and avoids forced LID", async () => {
  const { client, calls } = fixture({ resolve(wid) {
    return { wid: { $1: wid.$1 === "fake-alias@lid" ? "15550000002@c.us" : wid.$1 } };
  } });
  const result = await createWhatsAppGroupWithClient(client, "Public fixture", [
    "15550000001@c.us", "fake-self@lid", "15550000002@c.us", "fake-alias@lid",
  ]);
  assert.equal(result.gid, "fake-group@g.us");
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.sdk, 0);
  assert.equal(calls.queries.length, 2);
  assert.equal(calls.creates[0].participants.length, 1);
  assert.equal(calls.creates[0].participants[0].phoneNumber.$1, "15550000002@c.us");
  assert.equal(Object.hasOwn(calls.creates[0].options, "addressingModeOverride"), false);
  assert.equal(calls.creates[0].options.announce, true);
});

for (const wid of [{ _serialized: "legacy@g.us" }, { $1: "modern@g.us" }, { user: "parts", server: "g.us" }]) {
  test(`group identity returns before optional participant processing: ${Object.keys(wid)[0]}`, async () => {
    const { client } = fixture({ create: () => ({ wid, get participants() { throw Error("metadata unavailable"); } }) });
    const result = await createWhatsAppGroupWithClient(client, "Public fixture", ["15550000002@c.us"]);
    assert.match(result.gid, /@g\.us$/);
  });
}

test("read-only protocol probe never queries contacts or invokes create", async () => {
  const { client, calls } = fixture();
  const result = await inspectWhatsAppGroupCreateProtocol(client);
  assert.equal(result.available, true);
  assert.equal(result.adapter, "group_create_v1");
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.creates.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /155500|fake-self|token|title/i);
});

test("missing module and unresolved participant fail before dispatch", async () => {
  for (const config of [{ missingModule: "WAWebGroupCreateJob" }, { resolve: () => null }]) {
    const { client, calls } = fixture(config);
    await assert.rejects(createWhatsAppGroupWithClient(client, "Public fixture", ["15550000002@c.us"]), (error) => {
      const f = publicWhatsAppGroupCreateFailure(error);
      assert.equal(f.stage, "prepared");
      assert.equal(f.externalOutcome, "not_created");
      assert.equal(f.retryable, false);
      assert.doesNotMatch(JSON.stringify(f), /private-token|private-title|155500/);
      return true;
    });
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.sdk, 0);
  }
});

test("post-dispatch exception keeps safe diagnostic and never falls back or retries", async () => {
  const { client, calls } = fixture({ create: () => {
    throw new TypeError("Cannot read properties of undefined (reading 'lid') private-token private-title 15550000002");
  } });
  await assert.rejects(createWhatsAppGroupWithClient(client, "Public fixture", ["15550000002@c.us"], {}, {
    operationId: "fake-operation", correlationId: "fake-correlation",
  }), (error) => {
    const f = publicWhatsAppGroupCreateFailure(error);
    assert.equal(f.externalOutcome, "outcome_unknown");
    assert.equal(f.stage, "external_create");
    assert.equal(f.retryable, false);
    assert.equal(f.diagnostic.reason, "missing_property_lid");
    assert.equal(f.correlationId, "fake-correlation");
    assert.doesNotMatch(JSON.stringify(f), /private-token|private-title|155500/);
    return true;
  });
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.sdk, 0);
});

test("malformed result remains ambiguous and cannot invoke legacy SDK", async () => {
  const { client, calls } = fixture({ create: () => ({ wid: { user: "invalid" } }) });
  await assert.rejects(createWhatsAppGroupWithClient(client, "Public fixture", []), (error) => {
    assert.equal(error.groupCreateFailure.externalOutcome, "outcome_unknown");
    assert.equal(error.groupCreateFailure.code, "whatsapp_group_id_unrecognized");
    return true;
  });
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.sdk, 0);
});

test("alternate SDK-only clients keep their existing call contract", async () => {
  const calls = [];
  const client = { async createGroup(...args) { calls.push(args); return { gid: "sdk@g.us" }; } };
  assert.equal((await createWhatsAppGroupWithClient(client, "Public fixture", [], undefined)).gid, "sdk@g.us");
  assert.deepEqual(calls, [["Public fixture", [], undefined]]);
});

test("diagnostics reject non-allowlisted names, reasons, statuses and raw fields", () => {
  const result = publicWhatsAppGroupCreateFailure({ groupCreateFailure: {
    diagnostic: { name: "private-token", reason: "private-title", status: 123456789, raw: "secret" },
  } });
  assert.deepEqual(result.diagnostic, { name: "Error", reason: "upstream_error", status: null });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|123456789/);
});

test("local bridge persists known browser-created identity before optional setup", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "wa-group-client-")), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  const { client, calls } = fixture();
  client.info = { wid: { _serialized: "15550000001@c.us" } };
  const persisted = [];
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client }, {}, env);
    const result = await createLocalWhatsAppChat({
      name: "Public fixture", responderAccountId: "sender", participantIds: ["15550000002@c.us"],
      deferSetup: true, env, onGroupCreated: async (group) => { persisted.push(group.chatId); },
    });
    assert.deepEqual(persisted, ["fake-group@g.us"]);
    assert.equal(result.chat.id, "fake-group@g.us");
    assert.equal(result.setup.deferred, true);
    assert.equal(calls.creates.length, 1);
  } finally { await resetLocalWhatsAppBridgeForTest(env); }
});

test("service protocol diagnostics remain authenticated and allowlisted", async () => {
  const server = createOrkestrWaService({
    env: { ORKESTR_WA_SERVICE_TOKEN: "fixture-token" },
    bridge: { async getLocalWhatsAppBridgeStatus() { return { ok: true, accounts: [{
      id: "sender", ready: true, groupCreateProtocol: {
        adapter: "group_create_v1", available: true, version: "2.3000.1000000000", createArity: 2,
        source: "private-token", participantIds: ["15550000002@c.us"],
      },
    }] }; } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/diagnostics/health?force=1&readOnly=1`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const result = await (await fetch(url, { headers: { authorization: "Bearer fixture-token" } })).json();
    assert.equal(result.accounts[0].groupCreateProtocol.available, true);
    assert.doesNotMatch(JSON.stringify(result), /private-token|15550000002|participantIds/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
