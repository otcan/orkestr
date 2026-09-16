import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptWhatsAppGroupCreateResult, publicWhatsAppGroupCreateFailure } from "../packages/connectors/src/whatsapp-group-create-evidence.js";
import { createAndBindWhatsAppThreadGroup, createExternalWhatsAppChat } from "../packages/connectors/src/whatsapp-thread-groups.js";
import { assertWhatsAppRuntimeBrowserOwnership } from "../packages/connectors/src/whatsapp-runtime-provenance.js";
import {
  createLocalWhatsAppChat,
  getLocalWhatsAppBridgeStatus,
  logoutLocalWhatsAppAccount,
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
  setLocalWhatsAppRuntimeRecoveryHooksForTest,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import { getWhatsAppStatus, mapLocalWhatsAppStatusFromHealth } from "../packages/connectors/src/whatsapp.js";
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";
import { runCli } from "../apps/cli/src/commands.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

async function home(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function capture() {
  let text = "";
  return { write: (value) => { text += String(value); }, text: () => text };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function withWaService(env, bridge, fn) {
  const server = createOrkestrWaService({ env, bridge });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("group result adapter accepts only complete allowlisted group IDs", () => {
  for (const result of [
    { gid: { _serialized: "legacy-group@g.us" } },
    { groupId: { $1: "new-group@g.us" } },
    { chatId: { user: "composed-group", server: "g.us" } },
    { id: "direct-group@g.us" },
  ]) {
    const adapted = adaptWhatsAppGroupCreateResult(result);
    assert.equal(adapted.ok, true);
    assert.match(adapted.groupId, /@g\.us$/);
    assert.equal(adapted.externalOutcome, "created");
  }
  for (const result of ["SDK rejected request", { gid: { $1: "partial-only" } }, { user: "bare-user" }, null]) {
    const adapted = adaptWhatsAppGroupCreateResult(result);
    assert.equal(adapted.ok, false);
    assert.equal(adapted.externalOutcome, "outcome_unknown");
    assert.ok(adapted.resultFingerprint);
  }
});

test("public group-create failure envelopes do not relay arbitrary bridge fields", () => {
  const failure = publicWhatsAppGroupCreateFailure({
    groupCreateFailure: {
      operationId: "wgp_fixture",
      stage: "external create / private detail",
      code: "private error with spaces",
      resultKind: "sdk string",
      externalOutcome: "unexpected",
      nextAction: "read private host",
      correlationId: "correlation fixture",
      clientVersion: "SDK version (private)",
      resultFingerprint: "not-a-fingerprint",
    },
  });
  assert.deepEqual(failure, {
    operationId: "wgp_fixture",
    operation: "whatsapp_group_provisioning",
    stage: "external_create___private_detail",
    code: "private_error_with_spaces",
    resultKind: "sdk_string",
    externalOutcome: "outcome_unknown",
    retryable: false,
    nextAction: "read_private_host",
    correlationId: "correlation_fixture",
    clientVersion: "SDK_version__private_",
    resultFingerprint: "",
  });
});

test("public bridge health projection excludes local runtime paths and client identifiers", () => {
  const projected = mapLocalWhatsAppStatusFromHealth({
    ok: true,
    state: "ready",
    ready: true,
    accounts: [{
      accountId: "sender",
      clientId: "internal-client",
      sessionRoot: "/private/runtime",
      localAuthSessionDir: "/private/runtime/session-internal-client",
      debuggerUrl: "ws://private-host",
      capabilities: { auth: "available", read: "available", send: "available", inbound: "available", groupCreate: "available" },
      provenance: { accountId: "sender", ownership: "verified", source: "runtime", observedAt: "2026-01-01T00:00:00.000Z", runtimeGeneration: 1 },
    }],
  });
  assert.doesNotMatch(JSON.stringify(projected), /clientId|sessionRoot|localAuthSessionDir|debugger|private-host|internal-client/i);
});

test("ambiguous local create result is a structured unknown outcome without runtime recovery", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-create-unknown-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  const calls = [];
  try {
    setLocalWhatsAppRuntimeForTest("sender", {
      client: {
        info: { wid: { _serialized: "sender@c.us" } },
        async createGroup() {
          calls.push("create");
          return "SDK result unavailable";
        },
      },
    }, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount() { calls.push("restart"); },
      async startAccount() { calls.push("start"); },
    });
    await assert.rejects(
      () => createLocalWhatsAppChat({ name: "Synthetic group", responderAccountId: "sender", participantIds: ["participant@c.us"], env }),
      (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.groupCreateFailure.resultKind, "sdk_string");
        assert.equal(error.groupCreateFailure.externalOutcome, "outcome_unknown");
        assert.equal(error.groupCreateFailure.retryable, false);
        return true;
      },
    );
    assert.deepEqual(calls, ["create"]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("bridge group setup is deferred until the durable create callback records the group ID", async () => {
  const env = {
    ORKESTR_HOME: await home("orkestr-wa-bridge-create-order-"),
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
  };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://bridge.test" }, env);
  const calls = [];
  let persisted = false;
  const result = await createExternalWhatsAppChat({
    name: "Synthetic",
    senderAccountId: "sender",
    responderAccountId: "responder",
    participantIds: ["participant@c.us"],
    adminParticipantIds: ["participant@c.us"],
    operationId: "wgp_fixture",
    onGroupCreated: async ({ chatId }) => {
      assert.equal(chatId, "deferred-group@g.us");
      persisted = true;
    },
  }, env, async (url, options = {}) => {
    calls.push({ path: url.pathname, body: JSON.parse(options.body || "{}") });
    if (url.pathname === "/chats") {
      assert.equal(calls[0].body.deferSetup, true);
      return jsonResponse({ ok: true, chat: { id: "deferred-group@g.us" }, setupPending: true }, 201);
    }
    assert.equal(persisted, true);
    return jsonResponse({ ok: true, adminPromotion: { ok: true }, picture: { updated: true } });
  });
  assert.equal(result.setup.ok, true);
  assert.deepEqual(calls.map((call) => call.path), [
    "/chats",
    "/accounts/responder/chats/deferred-group%40g.us/setup",
  ]);
});

test("local deferred group creation invokes durable callback before optional setup", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-local-create-order-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  const calls = [];
  try {
    setLocalWhatsAppRuntimeForTest("sender", {
      client: {
        info: { wid: { _serialized: "sender@c.us" } },
        async createGroup() { return { gid: { _serialized: "deferred-local@g.us" } }; },
      },
    }, {}, env);
    const created = await createLocalWhatsAppChat({
      name: "Synthetic",
      responderAccountId: "sender",
      participantIds: ["participant@c.us"],
      deferSetup: true,
      onGroupCreated: async ({ chatId }) => { calls.push(chatId); },
      env,
    });
    assert.deepEqual(calls, ["deferred-local@g.us"]);
    assert.equal(created.setupPending, true);
    assert.equal(created.setup.deferred, true);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("WA service preserves deferred setup and operation correlation across both bridge calls", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-service-create-order-"), ORKESTR_WA_SERVICE_AUTH_DISABLED: "1" };
  const calls = [];
  const bridge = {
    async createLocalWhatsAppChat(payload) {
      calls.push({ kind: "create", payload });
      return { ok: true, chat: { id: "service-group@g.us" }, setupPending: true };
    },
    async completeLocalWhatsAppGroupSetup(payload) {
      calls.push({ kind: "setup", payload });
      return { ok: true, ...payload };
    },
  };
  await withWaService(env, bridge, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic",
        senderAccountId: "sender",
        responderAccountId: "responder",
        participantIds: ["participant@c.us"],
        operationId: "wgp_fixture",
        correlationId: "correlation_fixture",
        deferSetup: true,
      }),
    });
    assert.equal(created.status, 201);
    const setup = await fetch(`${baseUrl}/accounts/responder/chats/service-group%40g.us/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic", adminParticipantIds: ["participant@c.us"] }),
    });
    assert.equal(setup.status, 200);
  });
  assert.equal(calls[0].payload.deferSetup, true);
  assert.equal(calls[0].payload.operationId, "wgp_fixture");
  assert.equal(calls[0].payload.correlationId, "correlation_fixture");
  assert.deepEqual(calls[1].payload, {
    accountId: "responder",
    chatId: "service-group@g.us",
    title: "Synthetic",
    adminParticipantIds: ["participant@c.us"],
    generatePicture: true,
    env,
  });
});

test("a confirmed local capability failure is persisted as rejected before external dispatch", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-operation-rejected-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  const thread = await createThread({ id: "rejected-group-thread", name: "Synthetic", ownerUserId: "owner" }, env);
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: {} }, { ready: false }, env);
    await assert.rejects(
      () => createAndBindWhatsAppThreadGroup(thread, { responderAccountId: "sender" }, env, { createChat: createLocalWhatsAppChat }),
      (error) => {
        assert.equal(error.groupCreateFailure.externalOutcome, "not_created");
        assert.equal(error.groupCreateFailure.stage, "prepared");
        return true;
      },
    );
    const persisted = await getThread(thread.id, env);
    assert.equal(persisted.whatsappGroupProvisioning.state, "rejected");
    assert.equal(persisted.whatsappGroupProvisioning.externalOutcome, "not_created");
    assert.equal(persisted.whatsappGroupProvisioning.groupId, "");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("forced read-only diagnostics attest the runtime without recovering or leaking browser endpoints", async () => {
  const env = {
    ORKESTR_HOME: await home("orkestr-wa-read-only-diagnostics-"),
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WA_WORKER_SOCKET: "",
    PRIVATE_PROFILE_PATH: "/private/not-for-output",
  };
  let recoveries = 0;
  try {
    setLocalWhatsAppRuntimeForTest("sender", {
      client: {
        pupBrowser: {},
        pupPage: {},
        async getChats() { throw new Error("r"); },
      },
    }, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount() { recoveries += 1; },
      async startAccount() { recoveries += 1; },
    });
    const status = await getWhatsAppStatus(env, fetch, { probeChatOps: true, read: true, force: true, readOnly: true });
    const account = status.accounts[0];
    assert.equal(recoveries, 0);
    assert.equal(account.provenance.ownership, "verified");
    assert.equal(account.provenance.runtimeGeneration > 0, true);
    assert.equal(account.capabilities.groupCreate, "unknown");
    assert.equal(assertWhatsAppRuntimeBrowserOwnership(account.provenance, { accountId: "other", generation: account.provenance.runtimeGeneration }).ok, false);
    assert.doesNotMatch(JSON.stringify(status), /private|sessionRoot|clientId|debugger/i);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("a verified logout cannot be masked by stale inbound traffic", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-newer-logout-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: {} }, {
      lastInboundAt: "2027-01-01T00:00:00.000Z",
      verifiedLogoutAt: "2026-01-01T00:01:00.000Z",
    }, env);
    const health = await getLocalWhatsAppBridgeStatus(env, { readOnly: true });
    assert.equal(health.accounts[0].state, "auth_failure");
    assert.equal(health.accounts[0].authenticated, false);
    assert.equal(health.accounts[0].capabilities.auth, "unavailable");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("manual logout is authoritative until an authenticated lifecycle event replaces it", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-manual-logout-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  try {
    setLocalWhatsAppRuntimeForTest("sender", {
      client: {
        async logout() {},
        async destroy() {},
      },
    }, {}, env);
    await logoutLocalWhatsAppAccount("sender", env);
    const health = await getLocalWhatsAppBridgeStatus(env, { readOnly: true });
    assert.equal(health.accounts[0].state, "auth_failure");
    assert.equal(health.accounts[0].authenticated, false);
    assert.equal(health.accounts[0].started, false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("unknown provisioning is fenced across retries and forceNew", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-operation-unknown-") };
  const thread = await createThread({ id: "unknown-group-thread", name: "Synthetic" }, env);
  let creates = 0;
  const dependencies = {
    async createChat() {
      creates += 1;
      throw new Error("transport lost after dispatch");
    },
  };
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(thread, { responderAccountId: "sender" }, env, dependencies));
  const afterFirstAttempt = await getThread(thread.id, env);
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(afterFirstAttempt, { responderAccountId: "sender", forceNew: true }, env, dependencies));
  const persisted = await getThread(thread.id, env);
  assert.equal(creates, 1);
  assert.equal(persisted.whatsappGroupProvisioning.state, "outcome_unknown");
  assert.equal(persisted.whatsappGroupProvisioning.externalOutcome, "outcome_unknown");
  assert.equal(persisted.binding, null);
});

test("concurrent provisioning creates once and resumes binding after a saved group", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-operation-concurrent-") };
  const thread = await createThread({ id: "concurrent-group-thread", name: "Synthetic" }, env);
  let creates = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const createChat = async (input) => {
    creates += 1;
    await gate;
    await input.onGroupCreated({ chatId: "concurrent-group@g.us", resultKind: "group_id", resultFingerprint: "f" });
    return { chat: { id: "concurrent-group@g.us", name: input.name }, responderAccountId: "sender" };
  };
  const first = createAndBindWhatsAppThreadGroup(thread, { responderAccountId: "sender" }, env, { createChat });
  await new Promise((resolve) => setImmediate(resolve));
  const second = createAndBindWhatsAppThreadGroup(thread, { responderAccountId: "sender", forceNew: true }, env, { createChat });
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(creates, 1);
  assert.equal(one.binding.chatId, "concurrent-group@g.us");
  assert.equal(two.binding.chatId, "concurrent-group@g.us");
  assert.equal((await getThread(thread.id, env)).whatsappGroupProvisioning.state, "bound");
});

test("known group survives a binding save failure and retries without a second create", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-operation-bind-") };
  const thread = await createThread({ id: "binding-group-thread", name: "Synthetic" }, env);
  let creates = 0;
  let failBinding = true;
  const flakyUpdate = async (threadId, patch, actualEnv) => {
    if (failBinding && patch.binding) {
      failBinding = false;
      throw Object.assign(new Error("simulated binding save failure"), { statusCode: 503 });
    }
    return updateThread(threadId, patch, actualEnv);
  };
  const createChat = async (input) => {
    creates += 1;
    await input.onGroupCreated({ chatId: "known-group@g.us", resultKind: "group_id", resultFingerprint: "f" });
    return { chat: { id: "known-group@g.us", name: input.name }, responderAccountId: "sender" };
  };
  await assert.rejects(() => createAndBindWhatsAppThreadGroup(thread, { responderAccountId: "sender" }, env, { createChat, updateThread: flakyUpdate }));
  const afterFailure = await getThread(thread.id, env);
  assert.equal(afterFailure.whatsappGroupProvisioning.state, "created");
  const resumed = await createAndBindWhatsAppThreadGroup(afterFailure, { responderAccountId: "sender" }, env, { createChat });
  assert.equal(creates, 1);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.binding.chatId, "known-group@g.us");
});

test("CLI preserves a safe provisioning failure and uses the read-only diagnostics route", async () => {
  const failure = {
    operationId: "wgp_fixture",
    operation: "whatsapp_group_provisioning",
    stage: "external_create",
    code: "whatsapp_group_create_outcome_unknown",
    resultKind: "sdk_string",
    externalOutcome: "outcome_unknown",
    retryable: false,
    nextAction: "reconcile_operation",
    correlationId: "correlation_fixture",
    clientVersion: "fixture",
    resultFingerprint: "f".repeat(64),
  };
  const stdout = capture();
  const routes = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    routes.push(`${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`);
    if (parsed.pathname.endsWith("/thread-groups")) return jsonResponse({ error: failure.code, groupCreateFailure: failure }, 409);
    return jsonResponse({ ok: true, readOnly: true, account: { id: "sender", state: "ready", capabilities: { read: "available" } } });
  };
  const bindCode = await runCli(["--api", "http://orkestr.test", "whatsapp", "bind-thread", "thread-fixture", "--name", "Fixture", "--json"], {
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" }, stdout, stderr: capture(), fetchImpl,
  });
  assert.equal(bindCode, 1);
  const output = JSON.parse(stdout.text());
  assert.deepEqual(output, {
    ok: false,
    operationId: failure.operationId,
    operation: failure.operation,
    stage: failure.stage,
    code: failure.code,
    resultKind: failure.resultKind,
    externalOutcome: failure.externalOutcome,
    retryable: false,
    nextAction: failure.nextAction,
  });

  const diagnosticStdout = capture();
  const diagnosticCode = await runCli(["--api", "http://orkestr.test", "whatsapp", "accounts", "diagnostics", "sender", "--json"], {
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" }, stdout: diagnosticStdout, stderr: capture(), fetchImpl,
  });
  assert.equal(diagnosticCode, 0);
  assert.deepEqual(JSON.parse(diagnosticStdout.text()), { ok: true, readOnly: true, account: { id: "sender", state: "ready", capabilities: { read: "available" } } });
  assert.deepEqual(routes, [
    "POST /api/connectors/whatsapp/thread-groups",
    "GET /api/connectors/whatsapp/accounts/sender/diagnostics",
  ]);
});
