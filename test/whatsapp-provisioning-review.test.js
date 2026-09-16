import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publicWhatsAppGroupProvisioningOperation } from "../packages/connectors/src/whatsapp-group-provisioning.js";
import { attestWhatsAppRuntimeProvenance, assertWhatsAppRuntimeBrowserOwnership } from "../packages/connectors/src/whatsapp-runtime-provenance.js";
import { createAndBindWhatsAppThreadGroup } from "../packages/connectors/src/whatsapp-thread-groups.js";
import {
  getLocalWhatsAppBridgeStatus,
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
  startLocalWhatsAppAccount,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";

async function home(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function account(status, accountId) {
  return status.accounts.find((item) => item.accountId === accountId);
}

function mockLifecycleDependencies(clients) {
  class LocalAuth {}
  class Client {
    constructor() {
      this.handlers = new Map();
      clients.push(this);
    }
    on(event, handler) {
      this.handlers.set(event, handler);
      return this;
    }
    initialize() { return Promise.resolve(); }
    async destroy() {}
  }
  return async () => ({
    whatsapp: { Client, LocalAuth },
    qrcode: { toDataURL: async () => "data:image/png;base64,fixture" },
  });
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture_marker_timeout");
}

function runRaceWorker(args, env) {
  const fixture = fileURLToPath(new URL("./fixtures/whatsapp-provisioning-race-worker.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `fixture_worker_exit_${code}`)));
  });
}

test("mocked lifecycle callbacks distinguish transient disconnect, unrelated QR, and logout", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-lifecycle-review-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender secondary" };
  const clients = [];
  const dependencies = mockLifecycleDependencies(clients);
  try {
    await startLocalWhatsAppAccount("sender", env, { loadBridgeDependencies: dependencies, repairNotification: false });
    await startLocalWhatsAppAccount("secondary", env, { loadBridgeDependencies: dependencies, repairNotification: false });
    await clients[0].handlers.get("ready")();
    await clients[1].handlers.get("qr")("fixture-qr");
    let status = await getLocalWhatsAppBridgeStatus(env, { readOnly: true, probeChatOps: false });
    assert.equal(account(status, "sender").state, "ready");
    assert.equal(account(status, "sender").verifiedLogoutAt, null);

    await clients[0].handlers.get("disconnected")("NAVIGATION");
    status = await getLocalWhatsAppBridgeStatus(env, { readOnly: true, probeChatOps: false });
    assert.equal(account(status, "sender").state, "disconnected");
    assert.equal(account(status, "sender").error, "NAVIGATION");
    assert.equal(account(status, "sender").verifiedLogoutAt, null);
    assert.notEqual(account(status, "sender").capabilities.auth, "unavailable");

    await startLocalWhatsAppAccount("sender", env, { loadBridgeDependencies: dependencies, repairNotification: false });
    const restarted = clients.at(-1);
    await restarted.handlers.get("authenticated")();
    await restarted.handlers.get("ready")();
    await restarted.handlers.get("disconnected")("LOGOUT");
    status = await getLocalWhatsAppBridgeStatus(env, { readOnly: true, probeChatOps: false });
    assert.equal(account(status, "sender").state, "auth_failure");
    assert.equal(account(status, "sender").error, "whatsapp_session_logout_verified");
    assert.ok(account(status, "sender").verifiedLogoutAt);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("read-only probe failure projects degradation without mutating the ready runtime", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-read-only-review-"), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  try {
    setLocalWhatsAppRuntimeForTest("sender", {
      client: {
        async getChats() { throw new Error("fixture_chat_ops_failure"); },
        async createGroup() { return { id: "not-used@g.us" }; },
      },
    }, {}, env);
    const diagnostic = await getLocalWhatsAppBridgeStatus(env, { readOnly: true, force: true, probeChatOps: true, read: true });
    assert.equal(account(diagnostic, "sender").state, "degraded");
    assert.equal(account(diagnostic, "sender").ready, false);
    assert.equal(account(diagnostic, "sender").capabilities.read, "degraded");
    assert.equal(account(diagnostic, "sender").capabilities.inbound, "degraded");
    assert.equal(account(diagnostic, "sender").capabilities.send, "available");
    assert.equal(account(diagnostic, "sender").capabilities.groupCreate, "unknown");
    const passive = await getLocalWhatsAppBridgeStatus(env, { readOnly: true, probeChatOps: false });
    assert.equal(account(passive, "sender").state, "ready");
    assert.equal(account(passive, "sender").ready, true);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("runtime browser ownership requires a fresh matching current runtime reference", () => {
  const runtime = { generation: 7, client: { pupBrowser: {}, pupPage: {} } };
  const provenance = attestWhatsAppRuntimeProvenance({ accountId: "sender", runtime });
  const nowMs = Date.parse(provenance.observedAt);
  assert.equal(assertWhatsAppRuntimeBrowserOwnership(provenance, { accountId: "sender", runtime, nowMs }).ok, true);
  assert.equal(assertWhatsAppRuntimeBrowserOwnership(provenance, { accountId: "sender", nowMs }).ok, false);
  assert.equal(assertWhatsAppRuntimeBrowserOwnership(provenance, { accountId: "sender", runtime, nowMs: nowMs + 60_001 }).ok, false);
  assert.equal(assertWhatsAppRuntimeBrowserOwnership({ ...provenance, source: "other" }, { accountId: "sender", runtime, nowMs }).ok, false);
  assert.equal(assertWhatsAppRuntimeBrowserOwnership(provenance, {
    accountId: "sender",
    runtime: { generation: 7, client: { pupBrowser: runtime.client.pupBrowser, pupPage: {} } },
    nowMs,
  }).ok, false);
});

test("flat stored provisioning failures remain visible in public operation status", () => {
  const operation = publicWhatsAppGroupProvisioningOperation({
    id: "wgp_fixture",
    stage: "reconcile",
    state: "outcome_unknown",
    externalOutcome: "outcome_unknown",
    failure: {
      operationId: "wgp_fixture",
      code: "whatsapp_group_outcome_unknown",
      stage: "reconcile",
      resultKind: "unknown",
      externalOutcome: "outcome_unknown",
      nextAction: "review_operation",
    },
  });
  assert.equal(operation.failure.code, "whatsapp_group_outcome_unknown");
});

test("provisioning refuses a mismatched instance before external creation", async () => {
  const env = { ORKESTR_HOME: await home("orkestr-wa-context-review-") };
  const thread = await createThread({ id: "context-group-thread", name: "Fixture", ownerUserId: "owner" }, env);
  await updateThread(thread.id, {
    whatsappGroupProvisioning: {
      id: "wgp_fixture", operation: "whatsapp_group_provisioning", threadId: thread.id,
      principalId: "owner", instanceId: "instance-a", accountId: "sender",
      state: "prepared", stage: "prepared", externalOutcome: "not_dispatched", groupId: "",
    },
  }, env);
  let creates = 0;
  await assert.rejects(
    () => createAndBindWhatsAppThreadGroup(thread, {
      ownerUserId: "owner", instanceId: "instance-b", responderAccountId: "sender",
    }, env, { createChat: async () => { creates += 1; } }),
    (error) => error.groupCreateFailure?.code === "whatsapp_group_provisioning_context_mismatch",
  );
  assert.equal(creates, 0);
});

test("a delayed cross-process reconcile cannot overwrite a persisted group", async () => {
  const env = { ...process.env, ORKESTR_HOME: await home("orkestr-wa-cross-process-review-") };
  const marker = path.join(env.ORKESTR_HOME, "dispatched.marker");
  await createThread({ id: "cross-process-group-thread", name: "Fixture", ownerUserId: "owner" }, env);
  const create = runRaceWorker([env.ORKESTR_HOME, "create", marker], env);
  await waitForFile(marker);
  await Promise.all([create, runRaceWorker([env.ORKESTR_HOME, "reconcile", marker], env)]);
  const thread = await getThread("cross-process-group-thread", env);
  assert.equal(thread.binding.chatId, "cross-process-group@g.us");
  assert.equal(thread.whatsappGroupProvisioning.groupId, "cross-process-group@g.us");
  assert.equal(thread.whatsappGroupProvisioning.state, "bound");
});
