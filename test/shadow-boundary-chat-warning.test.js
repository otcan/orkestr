import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { resolveTargetInstance, targetResolutionMetadata } from "../packages/core/src/target-resolver.js";
import { listEvents } from "../packages/storage/src/store.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { outboundMirrorMessageSetKey } from "../packages/connectors/src/whatsapp-outbound-intents.js";

async function fixture(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-shadow-boundary-warning-"));
  return {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_ACCESS_MODE: "shadow",
    ORKESTR_OXRM_ACCESS_MODE: "shadow",
    ORKESTR_MAILBOX_ACCESS_MODE: "shadow",
    ORKESTR_SHADOW_BOUNDARY_CHAT_WARNINGS: "1",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

async function createSelectionThread(id, env, binding = null) {
  return createThread({ id, ownerUserId: "admin", name: id, ...(binding ? { binding } : {}) }, env);
}

function selectionInput({ resourceType, threadId, targetId, requestId, action = "resource.execute", ...extra }) {
  return {
    targetType: resourceType,
    resourceType,
    threadId,
    explicitTargetId: targetId,
    principal: adminPrincipal(),
    permission: resourceType === "desktop" ? "operate" : resourceType === "mailbox" ? "read" : "execute",
    action,
    requestId,
    candidates: [{ id: targetId, type: resourceType, ownerUserId: "admin", status: "active", eligible: true }],
    ...extra,
  };
}

test("selected ungranted shadow targets append one deterministic warning with public metadata", async () => {
  resetObservabilityForTests();
  const env = await fixture();

  for (const resourceType of ["desktop", "oxrm", "mailbox"]) {
    const thread = await createSelectionThread(`shadow-${resourceType}`, env);
    const input = selectionInput({
      resourceType,
      threadId: thread.id,
      targetId: `${resourceType}-legacy`,
      requestId: `logical-${resourceType}`,
    });
    const [first, repeated] = await Promise.all([
      resolveTargetInstance(input, env),
      resolveTargetInstance(input, env),
    ]);
    const messages = await listThreadMessages(thread.id, env);
    const warnings = messages.filter((message) => message.source === "shadow-boundary-warning");

    assert.equal(first.ok, true);
    assert.equal(repeated.ok, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].phase, "notification");
    assert.equal(warnings[0].text, `Warning: this ${resourceType} target was selected under shadow authorization without an effective thread grant. Add an explicit grant before switching ${resourceType} access to enforce.`);
    assert.deepEqual(warnings[0].shadowBoundaryWarning, {
      eligible: true,
      emitted: true,
      resourceType,
      mode: "shadow",
      reason: "shadow_ungranted_target_selected",
      notificationId: `shadow-boundary-warning:logical-${resourceType}`,
    });
    assert.equal(first.shadowBoundaryWarning.eligible, true);
    assert.equal(targetResolutionMetadata(first).shadowBoundaryWarning.resourceType, resourceType);
    assert.equal([first.shadowBoundaryWarning.emitted, repeated.shadowBoundaryWarning.emitted].filter(Boolean).length, 1);
  }

  const events = await listEvents(env, 50);
  assert.equal(events.filter((event) => event.type === "shadow_boundary_chat_warning_emitted").length, 3);
  const metrics = renderOpenMetrics();
  assert.match(metrics, /orkestr_shadow_boundary_chat_warnings_total\{resource_type="desktop",outcome="emitted"\} 1/);
  assert.match(metrics, /orkestr_shadow_boundary_chat_warnings_total\{resource_type="oxrm",outcome="emitted"\} 1/);
  assert.match(metrics, /orkestr_shadow_boundary_chat_warnings_total\{resource_type="mailbox",outcome="emitted"\} 1/);
});

test("shadow target warnings stay silent for probes, off or enforce modes, grants, and denials", async () => {
  const env = await fixture();
  const thread = await createSelectionThread("shadow-warning-silent", env);

  const discovery = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "probe-target", requestId: "probe", action: "oxrm.discover",
  }), env);
  const preflight = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "preflight-target", requestId: "preflight", dryRun: true,
  }), env);
  const disabled = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "disabled-target", requestId: "disabled",
  }), { ...env, ORKESTR_SHADOW_BOUNDARY_CHAT_WARNINGS: "0" });
  assert.equal(discovery.shadowBoundaryWarning.reason, "informational_selection");
  assert.equal(preflight.shadowBoundaryWarning.reason, "informational_selection");
  assert.equal(disabled.shadowBoundaryWarning.reason, "feature_disabled");

  const off = await resolveTargetInstance(selectionInput({
    resourceType: "mailbox", threadId: thread.id, targetId: "off-target", requestId: "off",
  }), { ...env, ORKESTR_MAILBOX_ACCESS_MODE: "off" });
  assert.equal(off.shadowBoundaryWarning.reason, "mode_not_shadow");

  await registerThreadResource({ resourceType: "oxrm", resourceId: "granted-target", ownerUserId: "admin", status: "active" }, { principal: adminPrincipal() }, env);
  await setThreadResourceGrants(thread.id, "oxrm", [{ resourceId: "granted-target", permissions: ["execute"] }], { principal: adminPrincipal() }, env);
  const granted = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "granted-target", requestId: "granted",
  }), env);
  assert.equal(granted.shadowBoundaryWarning.reason, "effective_thread_grant");

  const denied = await resolveTargetInstance(selectionInput({
    resourceType: "desktop", threadId: thread.id, targetId: "denied-target", requestId: "denied",
  }), { ...env, ORKESTR_DESKTOP_ACCESS_MODE: "enforce" });
  assert.equal(denied.ok, false);
  assert.equal(denied.shadowBoundaryWarning.reason, "selection_denied");
  assert.deepEqual((await listThreadMessages(thread.id, env)).filter((message) => message.source === "shadow-boundary-warning"), []);
});

test("a WhatsApp-bound shadow warning uses the outbound-intent recovery path after the mirror cursor advances", async () => {
  const env = await fixture();
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  const thread = await createSelectionThread("shadow-warning-whatsapp", env, {
    connector: "whatsapp",
    chatId: "shadow-warning-chat",
    responderAccountId: "shadow-warning-account",
    outboundAccountId: "shadow-warning-account",
    mirrorToWhatsApp: true,
  });

  const first = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "legacy-oxrm", requestId: "warning-first",
  }), env);
  const firstMessage = (await listThreadMessages(thread.id, env)).find((message) => message.source === "shadow-boundary-warning");
  const firstDelivery = await deliverWhatsAppReplies(env, async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ids: ["first"] }) }));
  assert.equal(firstDelivery.delivered.length, 1);

  const second = await resolveTargetInstance(selectionInput({
    resourceType: "oxrm", threadId: thread.id, targetId: "legacy-oxrm", requestId: "warning-second",
  }), env);
  const messages = await listThreadMessages(thread.id, env);
  const secondMessage = messages.filter((message) => message.source === "shadow-boundary-warning").at(-1);
  // Reproduce a restart where history syncing advanced the cursor before this
  // fresh notification's outbound intent was persisted.
  const beforeRecovery = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "whatsapp.json"), "utf8"));
  beforeRecovery.outboundMirrorCursors = [{
    messageSetKey: outboundMirrorMessageSetKey({ kind: "thread", threadId: thread.id }),
    kind: "thread",
    agentId: null,
    threadId: thread.id,
    cursor: Number(secondMessage.cursor) + 1,
    updatedAt: new Date().toISOString(),
  }];
  await fs.writeFile(path.join(env.ORKESTR_HOME, "whatsapp.json"), JSON.stringify(beforeRecovery, null, 2));
  const calls = [];
  const recovered = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url: url.pathname, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, ids: ["second"] }) };
  });
  const state = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === secondMessage.id);

  assert.equal(first.shadowBoundaryWarning.emitted, true);
  assert.equal(second.shadowBoundaryWarning.emitted, true);
  assert.equal(firstMessage.chatId, "shadow-warning-chat");
  assert.equal(secondMessage.chatId, "shadow-warning-chat");
  assert.equal(recovered.delivered.length, 1);
  assert.deepEqual(calls.map((call) => call.body.to), ["shadow-warning-chat"]);
  assert.deepEqual(calls.map((call) => call.body.accountId), ["shadow-warning-account"]);
  assert.equal(intent.createdReason, "fresh_notification_after_cursor");
});
