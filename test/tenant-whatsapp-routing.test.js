import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forwardLocalWhatsAppInbound } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { createTenantVm, getTenantVm, updateTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import {
  configureTenantWhatsAppRoute,
  disableTenantWhatsAppRoute,
  listTenantWhatsAppRoutes,
  tenantWhatsAppInboundForwardRoute,
} from "../packages/core/src/tenant-whatsapp-routing.js";
import { readWhatsAppScopedTokenRecords } from "../packages/core/src/whatsapp-scoped-tokens.js";
import { listRouterTraces } from "../packages/core/src/router-traces.js";

function response(payload = {}, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("tenant WhatsApp routes store scoped tokens outside the public VM registry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-route-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    endpoint: { baseUrl: "https://alice.example.test" },
    connectors: { whatsappChatName: "Alice WA", whatsappAccountId: "responder" },
  }, env);

  const configured = await configureTenantWhatsAppRoute("alice-tenant", {
    chatId: "wa-group-zero@g.us",
    accountId: "responder",
  }, env);
  const vm = await getTenantVm("alice-tenant", env);
  const route = await tenantWhatsAppInboundForwardRoute({
    chatId: "wa-group-zero@g.us",
    accountId: "responder",
  }, env);
  const accountMismatch = await tenantWhatsAppInboundForwardRoute({
    chatId: "wa-group-zero@g.us",
    accountId: "other-account",
  }, env);
  const listed = await listTenantWhatsAppRoutes(env);
  const tenantVmFile = await fs.readFile(path.join(home, "tenant-vms.json"), "utf8");
  const bridgeSendToken = (await readWhatsAppScopedTokenRecords(env)).find((record) => record.tokenId === "tenant-whatsapp-send:alice-tenant");

  assert.equal(configured.route.target, "https://alice.example.test/api/connectors/whatsapp/inbound");
  assert.equal(configured.route.routeMode, "direct");
  assert.equal(configured.route.targetSource, "endpoint");
  assert.match(configured.route.token, /^owt_/);
  assert.match(configured.route.bridgeSendToken, /^wa_/);
  assert.equal(configured.route.bridgeTokenSync.recommendedEnv.WHATSAPP_BRIDGE_TOKEN, configured.route.bridgeSendToken);
  assert.equal(configured.route.bridgeTokenSync.recommendedEnv.ORKESTR_CONNECTORS_MCP_BEARER_TOKEN, configured.route.bridgeSendToken);
  assert.equal(configured.route.tokenConfigured, true);
  assert.equal(configured.route.diagnostics.status, "active");
  assert.equal(configured.route.diagnostics.nextAction, "sync_whatsapp_inbound_token_to_target");
  assert.equal(configured.route.tokenSync.recommendedEnv.ORKESTR_WHATSAPP_INBOUND_TOKEN, configured.route.token);
  assert.equal(vm.connectors.whatsappChatId, "wa-group-zero@g.us");
  assert.equal(vm.connectors.whatsappRouteEnabled, true);
  assert.equal(vm.connectors.whatsappRouteMode, "direct");
  assert.equal(route.tenantVmId, "alice-tenant");
  assert.equal(route.target, configured.route.target);
  assert.equal(route.routeMode, "direct");
  assert.equal(route.targetSource, "endpoint");
  assert.equal(route.token, configured.route.token);
  assert.equal(accountMismatch, null);
  assert.equal(listed[0].token, undefined);
  assert.equal(listed[0].bridgeSendToken, undefined);
  assert.equal(listed[0].bridgeTokenSync, undefined);
  assert.equal(listed[0].tokenSync, undefined);
  assert.equal(listed[0].diagnostics.tokenState, "configured");
  assert.equal(listed[0].tokenPreview.includes("..."), true);
  assert.equal(tenantVmFile.includes(configured.route.token), false);
  assert.equal(tenantVmFile.includes(configured.route.bridgeSendToken), false);
  assert.equal(bridgeSendToken.accountId, "responder");
  assert.equal(bridgeSendToken.chatId, "wa-group-zero@g.us");
  assert.deepEqual(bridgeSendToken.allowedChatIds, ["wa-group-zero@g.us"]);
  assert.deepEqual(bridgeSendToken.scopes, [
    "whatsapp:bridge:send",
    "connectors:read",
    "connectors:manage",
    "connectors:send",
  ]);

  const disabled = await disableTenantWhatsAppRoute("alice-tenant", env);
  assert.equal(disabled.route.enabled, false);
  assert.equal(await tenantWhatsAppInboundForwardRoute({ chatId: "wa-group-zero@g.us" }, env), null);

  await createTenantVm({
    id: "credentialed-tenant",
    ownerUserId: "charlie",
    endpoint: { baseUrl: "https://token@example.test" },
  }, env);
  await assert.rejects(
    () => configureTenantWhatsAppRoute("credentialed-tenant", { chatId: "wa-group-route-two@g.us" }, env),
    /tenant_vm_base_url_required/,
  );
});

test("tenant WhatsApp routes can be prepared before a VM target exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-route-pending-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "planned-tenant",
    ownerUserId: "planned",
    connectors: { whatsappChatName: "Planned WA", whatsappAccountId: "sender" },
  }, env);

  const prepared = await configureTenantWhatsAppRoute("planned-tenant", {
    chatId: "wa-group-planned@g.us",
    accountId: "sender",
    allowPending: true,
    enabled: false,
  }, env);
  const vm = await getTenantVm("planned-tenant", env);
  const forwardRoute = await tenantWhatsAppInboundForwardRoute({
    chatId: "wa-group-planned@g.us",
    accountId: "sender",
  }, env);
  const listed = await listTenantWhatsAppRoutes(env);

  assert.equal(prepared.route.enabled, false);
  assert.equal(prepared.route.forwardingReady, false);
  assert.equal(prepared.route.target, "");
  assert.match(prepared.route.token, /^owt_/);
  assert.equal(prepared.route.tokenConfigured, true);
  assert.equal(prepared.route.diagnostics.status, "incomplete");
  assert.equal(prepared.route.diagnostics.nextAction, "set_target_base_url");
  assert.equal(vm.connectors.whatsappChatId, "wa-group-planned@g.us");
  assert.equal(vm.connectors.whatsappRouteEnabled, false);
  assert.equal(forwardRoute, null);
  assert.equal(listed[0].token, undefined);
  assert.equal(listed[0].tokenConfigured, true);
  assert.equal(listed[0].forwardingReady, false);
});

test("local WhatsApp bridge forwards tenant-routed chats with the scoped tenant token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "bob-tenant",
    ownerUserId: "bob",
    endpoint: { baseUrl: "https://bob.example.test" },
  }, env);
  const configured = await configureTenantWhatsAppRoute("bob-tenant", {
    chatId: "wa-group-route-one@g.us",
    chatName: "Bob tenant WA",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "tenant-wa-event-1",
    chatId: "wa-group-route-one@g.us",
    accountId: "tenant-wa",
    from: "wa-contact-tenant@c.us",
    text: "hello tenant",
  }, env, async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url) === "https://bob.example.test/api/health") return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(String(calls[0].url), "https://bob.example.test/api/health");
  assert.equal(String(calls[1].url), "https://bob.example.test/api/connectors/whatsapp/inbound");
  assert.equal(calls[1].options.headers.authorization, `Bearer ${configured.route.token}`);
  assert.equal(calls[1].body.chatId, "wa-group-route-one@g.us");
  assert.equal(calls[1].body.accountId, "tenant-wa");
  assert.equal(calls[1].body.displayName, "Bob tenant WA");
  assert.equal(calls[1].body.chatName, "Bob tenant WA");
});

test("WhatsApp worker forwards inbound events to the connector MCP gateway before route resolution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-worker-sink-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_WORKER_EVENT_SINK_URL: "http://127.0.0.1:18914/internal/whatsapp/inbound",
    ORKESTR_WA_WORKER_EVENT_TOKEN: "worker-event-token",
  };
  const calls = [];
  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "worker-sink-event-1",
    chatId: "worker-sink@g.us",
    accountId: "sender",
    text: "route me durably",
  }, env, async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({ ok: true, eventId: "worker-sink-event-1", state: "delivered" }, true, 200);
  });
  assert.equal(forwarded.forwarded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18914/internal/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, "Bearer worker-event-token");
  assert.equal(calls[0].body.chatId, "worker-sink@g.us");
});

test("WhatsApp worker stages inbound media at the connector MCP gateway before forwarding JSON", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-worker-sink-media-"));
  const attachmentPath = path.join(home, "whatsapp-bridge", "inbound-media", "2026-07-17", "candidate.txt");
  await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
  await fs.writeFile(attachmentPath, "candidate cv", "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_WORKER_EVENT_SINK_URL: "http://127.0.0.1:18914/internal/whatsapp/inbound",
    ORKESTR_WA_WORKER_EVENT_TOKEN: "worker-event-token",
  };
  const stagedPath = path.join(home, "data", "connector-inbox-media", "2026-07-17", "candidate.txt");
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "worker-sink-media-1",
    chatId: "firat-jobs@g.us",
    accountId: "sender",
    text: "save the attachment",
    attachments: [{ path: attachmentPath, filename: "candidate.txt", mimetype: "text/plain", kind: "document" }],
  }, env, async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/connectors/whatsapp/inbound-media")) {
      const file = options.body.get("files");
      calls.push({ target, authorization: options.headers.authorization, text: Buffer.from(await file.arrayBuffer()).toString("utf8") });
      return response({
        ok: true,
        attachments: [{
          path: stagedPath,
          saved_path: stagedPath,
          filename: "candidate.txt",
          mimetype: "text/plain",
          source: "connector_mcp_inbound_media_upload",
        }],
      }, true, 201);
    }
    calls.push({ target, authorization: options.headers.authorization, body: JSON.parse(options.body) });
    return response({ ok: true, eventId: "worker-sink-media-1", state: "delivered" }, true, 200);
  });

  assert.equal(forwarded.forwarded, true);
  assert.deepEqual(calls.map((call) => call.target), [
    "http://127.0.0.1:18914/api/connectors/whatsapp/inbound-media",
    "http://127.0.0.1:18914/internal/whatsapp/inbound",
  ]);
  assert.equal(calls[0].authorization, "Bearer worker-event-token");
  assert.equal(calls[0].text, "candidate cv");
  assert.equal(calls[1].body.attachmentsUploadedToTarget, true);
  assert.equal(calls[1].body.attachments[0].path, stagedPath);
});

test("local WhatsApp bridge uploads tenant-routed media before forwarding inbound JSON", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-media-"));
  const env = { ORKESTR_HOME: home };
  const parentAttachmentPath = path.join(home, "parent-report.txt");
  await fs.writeFile(parentAttachmentPath, "tenant media payload", "utf8");
  await createTenantVm({
    id: "media-tenant",
    ownerUserId: "media",
    endpoint: { baseUrl: "https://media.example.test" },
  }, env);
  const configured = await configureTenantWhatsAppRoute("media-tenant", {
    chatId: "wa-group-media@g.us",
    chatName: "Media tenant WA",
    accountId: "tenant-wa",
  }, env);
  const slicePath = "/opt/orkestr/data/whatsapp-bridge/inbound-media/broker/2026-07-04/report.txt";
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "tenant-wa-media-1",
    chatId: "wa-group-media@g.us",
    accountId: "tenant-wa",
    from: "wa-contact-media@c.us",
    text: "see attached",
    attachments: [{ path: parentAttachmentPath, filename: "report.txt", mimetype: "text/plain", kind: "file" }],
  }, env, async (url, options = {}) => {
    const rawUrl = String(url);
    if (rawUrl === "https://media.example.test/api/health") {
      calls.push({ url: rawUrl });
      return response({ ok: true }, true, 200);
    }
    if (rawUrl === "https://media.example.test/api/connectors/whatsapp/inbound-media") {
      const metadata = JSON.parse(String(options.body.get("metadata") || "[]"));
      const file = options.body.get("files");
      calls.push({
        url: rawUrl,
        authorization: options.headers.authorization,
        metadata,
        fileText: Buffer.from(await file.arrayBuffer()).toString("utf8"),
      });
      return response({
        ok: true,
        attachments: [{
          path: slicePath,
          saved_path: slicePath,
          filename: "report.txt",
          mimetype: "text/plain",
          size: "tenant media payload".length,
          source: "broker_whatsapp_inbound_media_upload",
        }],
      }, true, 201);
    }
    calls.push({ url: rawUrl, authorization: options.headers.authorization, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://media.example.test/api/health",
    "https://media.example.test/api/connectors/whatsapp/inbound-media",
    "https://media.example.test/api/connectors/whatsapp/inbound",
  ]);
  assert.equal(calls[1].authorization, `Bearer ${configured.route.token}`);
  assert.equal(calls[1].metadata[0].filename, "report.txt");
  assert.equal(calls[1].fileText, "tenant media payload");
  assert.equal(calls[2].authorization, `Bearer ${configured.route.token}`);
  assert.equal(calls[2].body.attachmentsUploadedToTarget, true);
  assert.equal(calls[2].body.attachments[0].path, slicePath);
  assert.notEqual(calls[2].body.attachments[0].path, parentAttachmentPath);
});

test("local WhatsApp bridge suppresses duplicate tenant inbound forwards by source event", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-dupe-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "dupe-tenant",
    ownerUserId: "dupe",
    endpoint: { baseUrl: "https://dupe.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("dupe-tenant", {
    chatId: "wa-group-dupe@g.us",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  const first = await forwardLocalWhatsAppInbound({
    eventId: "false_wa-group-dupe@g.us_msg-1",
    chatId: "wa-group-dupe@g.us",
    accountId: "tenant-wa",
    from: "wa-contact-dupe@c.us",
    text: "hello once",
  }, env, async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url) === "https://dupe.example.test/api/health") return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
  });
  const duplicate = await forwardLocalWhatsAppInbound({
    eventId: "true_wa-group-dupe@g.us_msg-1",
    chatId: "wa-group-dupe@g.us",
    accountId: "tenant-wa",
    from: "wa-contact-dupe@c.us",
    text: "hello once",
  }, env, async () => {
    throw new Error("duplicate source event should not be forwarded again");
  });

  assert.equal(first.forwarded, true);
  assert.equal(duplicate.forwarded, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.skipped, "duplicate_forwarded_source");
  assert.equal(duplicate.payload.threadId, "tenant-thread");
  assert.equal(duplicate.payload.messageId, "tenant-message");
  assert.equal(calls.length, 2);
});

test("local WhatsApp bridge forwards an attachment recovered after a text-only source event", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-attachment-recovery-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "attachment-recovery-tenant",
    ownerUserId: "firat",
    endpoint: { baseUrl: "https://attachment-recovery.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("attachment-recovery-tenant", {
    chatId: "wa-group-attachment-recovery@g.us",
    accountId: "sender",
  }, env);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/api/health")) return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "firat-jobs", messageId: `tenant-message-${calls.length}` }, true, 202);
  };
  const source = {
    eventId: "false_wa-group-attachment-recovery@g.us_msg-1",
    chatId: "wa-group-attachment-recovery@g.us",
    accountId: "sender",
    from: "279611011236064@lid",
    text: "Candidate CV",
  };

  const first = await forwardLocalWhatsAppInbound(source, env, fetchImpl);
  const recovered = await forwardLocalWhatsAppInbound({
    ...source,
    eventId: "true_wa-group-attachment-recovery@g.us_msg-1",
    attachments: [{ filename: "candidate.pdf", mimetype: "application/pdf", size: 1234 }],
  }, env, fetchImpl);
  const duplicate = await forwardLocalWhatsAppInbound({
    ...source,
    attachments: [{ filename: "candidate.pdf", mimetype: "application/pdf", size: 1234 }],
  }, env, async () => {
    throw new Error("recovered attachment should only be forwarded once");
  });

  assert.equal(first.forwarded, true);
  assert.equal(recovered.forwarded, true);
  assert.equal(recovered.duplicate, undefined);
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/connectors/whatsapp/inbound")).length, 2);
});

test("local WhatsApp bridge skips managed tenant routes for the wrong account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-account-mismatch-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "mismatch-tenant",
    ownerUserId: "mismatch",
    endpoint: { baseUrl: "https://mismatch.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("mismatch-tenant", {
    chatId: "wa-group-mismatch@g.us",
    accountId: "tenant-wa",
  }, env);

  const skipped = await forwardLocalWhatsAppInbound({
    eventId: "mismatch-event-1",
    chatId: "wa-group-mismatch@g.us",
    accountId: "other-wa",
    from: "wa-contact-mismatch@c.us",
    text: "wrong account",
  }, env, async () => {
    throw new Error("mismatched managed route account should not be forwarded");
  });

  assert.equal(skipped.forwarded, false);
  assert.equal(skipped.skipped, "managed_route_account_mismatch");
  assert.equal(skipped.payload.reason, "managed_route_account_mismatch");
});

test("local WhatsApp bridge surfaces target inbound token failures in traces", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-token-failure-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_CACHE_MS: "0" };
  await createTenantVm({
    id: "token-broker-tenant",
    ownerUserId: "token",
    endpoint: { brokerBaseUrl: "http://token-broker.internal.test" },
  }, env);
  await configureTenantWhatsAppRoute("token-broker-tenant", {
    chatId: "wa-group-token@g.us",
    accountId: "tenant-wa",
    routeMode: "broker",
  }, env);

  await assert.rejects(
    () => forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-token",
      chatId: "wa-group-token@g.us",
      accountId: "tenant-wa",
      from: "wa-contact-token@c.us",
      text: "hello token",
    }, env, async (url) => {
      if (String(url) === "http://token-broker.internal.test/api/health") return response({ ok: true }, true, 200);
      return response({
        ok: false,
        error: "whatsapp_inbound_token_invalid",
        routingFailure: {
          code: "whatsapp_inbound_token_invalid",
          capability: "whatsapp",
          userFacingCategory: "connector",
          safeMessage: "Target instance rejected the broker WhatsApp inbound token.",
          retryable: false,
        },
      }, false, 401);
    }),
    (error) => {
      assert.equal(error.message, "whatsapp_inbound_token_invalid");
      assert.equal(error.routingFailure.code, "whatsapp_inbound_token_invalid");
      assert.equal(error.routingFailure.userFacingCategory, "connector");
      assert.equal(error.routingFailure.retryable, false);
      assert.match(error.routingFailure.safeMessage, /rejected the broker WhatsApp inbound token/);
      return true;
    },
  );

  const traces = await listRouterTraces({}, env);
  assert.equal(traces[0].currentPhase, "runtime_failed");
  assert.equal(traces[0].diagnostics.terminal, true);
  assert.match(traces[0].lastError, /broker WhatsApp inbound token/);
});

test("local WhatsApp bridge prefers managed broker routes over legacy forward maps", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-broker-forward-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      "wa-group-broker@g.us": "https://legacy.example.test/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "legacy-token",
  };
  await createTenantVm({
    id: "broker-tenant",
    ownerUserId: "broker",
    endpoint: { baseUrl: "https://public-broker.example.test" },
  }, env);
  const configured = await configureTenantWhatsAppRoute("broker-tenant", {
    chatId: "wa-group-broker@g.us",
    chatName: "Broker tenant WA",
    accountId: "tenant-wa",
    brokerBaseUrl: "http://broker.internal.test",
  }, env);
  const route = await tenantWhatsAppInboundForwardRoute({
    chatId: "wa-group-broker@g.us",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "tenant-wa-event-broker",
    chatId: "wa-group-broker@g.us",
    accountId: "tenant-wa",
    from: "wa-contact-broker@c.us",
    text: "hello broker",
  }, env, async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    assert.notEqual(String(url), "https://legacy.example.test/api/connectors/whatsapp/inbound");
    if (String(url) === "http://broker.internal.test/api/health") return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "broker-thread", messageId: "broker-message" }, true, 202);
  });

  assert.equal(configured.route.target, "http://broker.internal.test/api/connectors/whatsapp/inbound");
  assert.equal(configured.route.routeMode, "broker");
  assert.equal(configured.route.targetSource, "broker");
  assert.equal(route.target, configured.route.target);
  assert.equal(route.routeMode, "broker");
  assert.equal(forwarded.target, "http://broker.internal.test/api/connectors/whatsapp/inbound");
  assert.equal(forwarded.targetSource, "broker");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://broker.internal.test/api/health",
    "http://broker.internal.test/api/connectors/whatsapp/inbound",
  ]);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${configured.route.token}`);
});

test("local WhatsApp bridge does not fall back to legacy maps when a managed route is incomplete", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-broker-missing-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      "wa-group-missing-broker@g.us": "https://legacy.example.test/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "legacy-token",
  };
  await createTenantVm({
    id: "missing-broker-tenant",
    ownerUserId: "missing",
    endpoint: { baseUrl: "https://missing.example.test" },
  }, env);
  const configured = await configureTenantWhatsAppRoute("missing-broker-tenant", {
    chatId: "wa-group-missing-broker@g.us",
    accountId: "tenant-wa",
  }, env);
  const vm = await getTenantVm("missing-broker-tenant", env);
  await updateTenantVm("missing-broker-tenant", {
    connectors: {
      ...vm.connectors,
      whatsappRouteMode: "broker",
      whatsappBrokerBaseUrl: "",
    },
  }, env);
  const calls = [];

  await assert.rejects(
    () => forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-missing-broker",
      chatId: "wa-group-missing-broker@g.us",
      accountId: "tenant-wa",
      from: "wa-contact-missing-broker@c.us",
      text: "hello missing broker",
    }, env, async (url) => {
      calls.push(String(url));
      throw new Error("legacy forward map should not be called");
    }),
    (error) => {
      assert.equal(error.message, "tenant_route_missing");
      assert.equal(error.routingFailure.code, "tenant_route_missing");
      assert.equal(error.routingFailure.instanceId, "missing-broker-tenant");
      assert.equal(error.routingFailure.reason, "missing_broker");
      return true;
    },
  );
  assert.equal(configured.route.target, "https://missing.example.test/api/connectors/whatsapp/inbound");
  assert.deepEqual(calls, []);
});

test("local WhatsApp bridge wraps tenant forward network failures", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-broker-network-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_CACHE_MS: "0" };
  await createTenantVm({
    id: "network-broker-tenant",
    ownerUserId: "network",
    endpoint: { brokerBaseUrl: "http://network-broker.internal.test" },
  }, env);
  await configureTenantWhatsAppRoute("network-broker-tenant", {
    chatId: "wa-group-network@g.us",
    accountId: "tenant-wa",
    routeMode: "broker",
  }, env);
  const calls = [];

  await assert.rejects(
    () => forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-network",
      chatId: "wa-group-network@g.us",
      accountId: "tenant-wa",
      from: "wa-contact-network@c.us",
      text: "hello network",
    }, env, async (url) => {
      calls.push(String(url));
      if (String(url) === "http://network-broker.internal.test/api/health") return response({ ok: true }, true, 200);
      throw new TypeError("fetch failed");
    }),
    (error) => {
      assert.equal(error.message, "whatsapp_inbound_forward_failed");
      assert.equal(error.routingFailure.code, "whatsapp_inbound_forward_failed");
      assert.equal(error.routingFailure.instanceId, "network-broker-tenant");
      assert.equal(error.routingFailure.reason, "fetch failed");
      return true;
    },
  );
  assert.deepEqual(calls, [
    "http://network-broker.internal.test/api/health",
    "http://network-broker.internal.test/api/connectors/whatsapp/inbound",
  ]);
});

test("local WhatsApp tenant forwards block unhealthy target instances before routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-health-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_CACHE_MS: "0" };
  await createTenantVm({
    id: "down-tenant",
    ownerUserId: "down",
    endpoint: { baseUrl: "https://down.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("down-tenant", {
    chatId: "wa-group-route-four@g.us",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  await assert.rejects(
    () => forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-down",
      chatId: "wa-group-route-four@g.us",
      accountId: "tenant-wa",
      from: "wa-contact-tenant@c.us",
      text: "hello tenant",
    }, env, async (url) => {
      calls.push(String(url));
      return response({ ok: false }, false, 502);
    }),
    (error) => {
      assert.equal(error.routingFailure.code, "target_instance_unhealthy");
      assert.equal(error.routingFailure.instanceId, "down-tenant");
      assert.equal(error.routingFailure.retryable, true);
      return true;
    },
  );
  assert.deepEqual(calls, ["https://down.example.test/api/health"]);
});

test("local WhatsApp tenant forwards allow sanitizer-backed targets enough time by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-timeout-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "slow-tenant",
    ownerUserId: "slow",
    endpoint: { baseUrl: "https://slow.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("slow-tenant", {
    chatId: "wa-group-route-three@g.us",
    accountId: "tenant-wa",
  }, env);
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  };
  try {
    await forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-slow",
      chatId: "wa-group-route-three@g.us",
      accountId: "tenant-wa",
      from: "wa-contact-tenant@c.us",
      text: "hello tenant",
    }, env, async (url) => {
      if (String(url) === "https://slow.example.test/api/health") return response({ ok: true }, true, 200);
      return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.equal(timeouts[0], 5000);
  assert.equal(timeouts[1], 60_000);
});
