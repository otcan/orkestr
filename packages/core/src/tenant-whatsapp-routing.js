import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { attachRoutingFailure } from "./routing-failures.js";
import { tenantPublicSetupUrl, tenantPublicUrls } from "./tenant-public-urls.js";
import { getTenantVm, listTenantVms, publicTenantVm, updateTenantVm } from "./tenant-vm-registry.js";
import { ensureWhatsAppScopedTokens, readWhatsAppScopedTokenRecords } from "./whatsapp-scoped-tokens.js";

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || clean(value) === "") return fallback;
  return value === true || ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function routeSecretPath(env = process.env) {
  return `${dataPaths(env).secrets}/tenant-whatsapp-routes.json`;
}

function tokenPreview(token = "") {
  const value = clean(token);
  if (!value) return "";
  if (value.length <= 12) return "********";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function routeDiagnostics(routeTarget = {}, token = "", { enabled = false } = {}) {
  const missing = [];
  if (!routeTarget.target) missing.push(routeTarget.routeMode === "broker" ? "brokerBaseUrl" : "baseUrl");
  if (!clean(token)) missing.push("routeToken");
  const configured = missing.length === 0;
  const status = configured ? (enabled ? "active" : "prepared") : "incomplete";
  const nextAction = !routeTarget.target
    ? (routeTarget.routeMode === "broker" ? "set_broker_base_url" : "set_target_base_url")
    : !clean(token)
      ? "configure_route_token"
      : enabled
        ? "sync_whatsapp_inbound_token_to_target"
        : "enable_route_when_target_is_ready";
  const safeMessage = configured
    ? enabled
      ? "Route is active. The target instance must also have the same WhatsApp inbound token."
      : "Route is prepared but disabled. Enable it only after the target instance accepts the inbound token."
    : "Route is incomplete and cannot receive brokered WhatsApp messages yet.";
  return {
    status,
    routeMode: routeTarget.routeMode || "",
    targetSource: routeTarget.targetSource || "",
    tokenState: clean(token) ? "configured" : "missing",
    missing,
    nextAction,
    safeMessage,
  };
}

function tokenSyncPayload(token = "", routeTarget = {}) {
  const value = clean(token);
  if (!value) return null;
  return {
    requiredOnTarget: true,
    targetUrl: routeTarget.target || "",
    recommendedEnv: {
      ORKESTR_WHATSAPP_INBOUND_TOKEN: value,
    },
    acceptedEnvKeys: [
      "ORKESTR_WHATSAPP_INBOUND_TOKEN",
      "WHATSAPP_INBOUND_TOKEN",
      "ORKESTR_WHATSAPP_INBOUND_TOKENS",
      "WHATSAPP_INBOUND_TOKENS",
    ],
    targetEnvFile: "/etc/orkestr/orkestr.env",
    authHeader: "Authorization: Bearer <ORKESTR_WHATSAPP_INBOUND_TOKEN>",
    verifyTarget: {
      method: "POST",
      path: "/api/connectors/whatsapp/inbound",
      expectedAuthSuccessErrors: ["whatsapp_target_required", "message_text_required"],
    },
  };
}

function bridgeSendTokenSyncPayload(token = "") {
  const value = clean(token);
  if (!value) return null;
  return {
    requiredOnTarget: true,
    recommendedEnv: {
      WHATSAPP_BRIDGE_MODE: "external",
      ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
      WHATSAPP_BRIDGE_TOKEN: value,
    },
    acceptedEnvKeys: [
      "WHATSAPP_BRIDGE_TOKEN",
      "WA_HTTP_TOKEN",
    ],
    targetEnvFile: "/etc/orkestr/orkestr.env",
    authHeader: "Authorization: Bearer <WHATSAPP_BRIDGE_TOKEN>",
    verifyTarget: {
      method: "POST",
      path: "/api/connectors/whatsapp/bridge/send-text",
      expectedAuthSuccessErrors: ["whatsapp_chat_id_required", "whatsapp_text_required"],
    },
  };
}

function newScopedToken() {
  return `owt_${crypto.randomBytes(32).toString("base64url")}`;
}

function tenantBridgeSendTokenId(tenantVmId = "") {
  return `tenant-whatsapp-send:${clean(tenantVmId)}`;
}

async function ensureTenantBridgeSendToken(vm = {}, { chatId = "", accountId = "" } = {}, env = process.env) {
  const id = tenantBridgeSendTokenId(vm.id);
  if (!id || !clean(chatId)) return null;
  await ensureWhatsAppScopedTokens([{
    tokenId: id,
    ownerUserId: vm.ownerUserId,
    instanceId: vm.id,
    accountId: clean(accountId),
    chatId: clean(chatId),
    allowedChatIds: [clean(chatId)],
    scopes: ["whatsapp:bridge:send"],
    routeKind: "whatsapp_bridge",
    purpose: "tenant-whatsapp-outbound",
  }], env);
  const records = await readWhatsAppScopedTokenRecords(env);
  return records.find((record) => clean(record.tokenId || record.id) === id) || null;
}

function normalizeBaseUrl(value = "") {
  return clean(value).replace(/\/+$/, "");
}

function normalizeRouteMode(value = "") {
  const mode = clean(value).toLowerCase();
  if (["broker", "managed", "control-plane", "controlplane", "internal"].includes(mode)) return "broker";
  if (["direct", "public", "legacy"].includes(mode)) return "direct";
  return "";
}

function inboundApiTarget(baseUrl = "") {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  try {
    const base = new URL(normalized);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
    return String(new URL("/api/connectors/whatsapp/inbound", `${normalized}/`));
  } catch {
    return "";
  }
}

function tenantRouteTarget(vm = {}, input = {}) {
  const routeMode = normalizeRouteMode(
    input.routeMode ||
    input.whatsappRouteMode ||
    vm.connectors?.whatsappRouteMode,
  );
  const brokerBaseUrl = normalizeBaseUrl(
    input.brokerBaseUrl ||
    input.whatsappBrokerBaseUrl ||
    input.controlPlaneBaseUrl ||
    input.internalBaseUrl ||
    vm.connectors?.whatsappBrokerBaseUrl ||
    vm.endpoint?.brokerBaseUrl,
  );
  const directBaseUrl = normalizeBaseUrl(
    input.targetBaseUrl ||
    input.baseUrl ||
    vm.endpoint?.baseUrl ||
    vm.endpoint?.url,
  );
  const brokerTarget = inboundApiTarget(brokerBaseUrl);
  const directTarget = inboundApiTarget(directBaseUrl);

  if (routeMode === "broker") {
    return {
      target: brokerTarget,
      routeMode: "broker",
      targetSource: brokerTarget ? "broker" : "missing_broker",
      brokerBaseUrl,
    };
  }
  if (routeMode === "direct") {
    return {
      target: directTarget,
      routeMode: "direct",
      targetSource: directTarget ? "endpoint" : "missing_endpoint",
      brokerBaseUrl,
    };
  }
  if (brokerTarget) {
    return { target: brokerTarget, routeMode: "broker", targetSource: "broker", brokerBaseUrl };
  }
  return {
    target: directTarget,
    routeMode: "direct",
    targetSource: directTarget ? "endpoint" : "missing_endpoint",
    brokerBaseUrl,
  };
}

async function readRouteSecrets(env = process.env) {
  await ensureDataDirs(env);
  const state = await readJson(routeSecretPath(env), { routes: {} });
  return state && typeof state === "object" && !Array.isArray(state) ? { routes: state.routes || {} } : { routes: {} };
}

async function writeRouteSecrets(state, env = process.env) {
  await ensureDataDirs(env);
  await writeSecretJson(routeSecretPath(env), {
    routes: state.routes || {},
    updatedAt: new Date().toISOString(),
  });
}

function routeSetupUrl(vm = {}, env = process.env) {
  return tenantPublicSetupUrl({
    tenantVmId: vm.id,
    brokerInstanceId: vm.labels?.brokerInstanceId || vm.labels?.instanceId,
    labels: vm.labels,
    connectPublicBaseUrl: vm.endpoint?.connectBaseUrl,
    connectPublicSetupUrl: vm.endpoint?.setupUrl,
    publicAppBaseUrl: vm.endpoint?.publicBaseUrl,
  }, env);
}

function routeAppUrl(vm = {}, env = process.env) {
  return tenantPublicUrls({
    tenantVmId: vm.id,
    brokerInstanceId: vm.labels?.brokerInstanceId || vm.labels?.instanceId,
    labels: vm.labels,
    connectPublicBaseUrl: vm.endpoint?.connectBaseUrl,
    connectPublicSetupUrl: vm.endpoint?.setupUrl,
    publicAppBaseUrl: vm.endpoint?.publicBaseUrl,
  }, env).appUrl;
}

function publicRoute(vm, secret = {}, { includeToken = false, bridgeSendToken = null, env = process.env } = {}) {
  const token = clean(secret.token);
  const bridgeToken = clean(bridgeSendToken?.token);
  const routeTarget = tenantRouteTarget(vm);
  const enabled = vm.connectors?.whatsappRouteEnabled === true;
  const diagnostics = routeDiagnostics(routeTarget, token, { enabled });
  const tokenSync = includeToken ? tokenSyncPayload(token, routeTarget) : null;
  const bridgeTokenSync = includeToken ? bridgeSendTokenSyncPayload(bridgeToken) : null;
  return {
    tenantVmId: vm.id,
    ownerUserId: vm.ownerUserId,
    chatId: clean(vm.connectors?.whatsappChatId),
    chatName: clean(vm.connectors?.whatsappChatName),
    accountId: clean(vm.connectors?.whatsappAccountId),
    enabled,
    forwardingReady: enabled && Boolean(routeTarget.target) && Boolean(token),
    target: routeTarget.target,
    routeMode: routeTarget.routeMode,
    targetSource: routeTarget.targetSource,
    appUrl: routeAppUrl(vm, env),
    setupUrl: routeSetupUrl(vm, env),
    tokenConfigured: Boolean(token),
    tokenPreview: tokenPreview(token),
    diagnostics,
    ...(includeToken && token ? { token } : {}),
    ...(includeToken && bridgeToken ? { bridgeSendToken: bridgeToken } : {}),
    ...(tokenSync ? { tokenSync } : {}),
    ...(bridgeTokenSync ? { bridgeTokenSync } : {}),
  };
}

export async function configureTenantWhatsAppRoute(tenantVmId, input = {}, env = process.env) {
  const vm = await getTenantVm(tenantVmId, env);
  if (!vm) {
    const error = new Error("tenant_vm_not_found");
    error.statusCode = 404;
    throw error;
  }
  const chatId = clean(input.chatId || input.whatsappChatId || input.waChatId || vm.connectors.whatsappChatId);
  if (!chatId) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const routeTarget = tenantRouteTarget(vm, input);
  const allowPending = truthy(input.allowPending || input.prepareOnly || input.stageOnly, false) ||
    input.enabled === false ||
    clean(input.enabled).toLowerCase() === "false";
  if (!routeTarget.target && !allowPending) {
    const error = new Error(routeTarget.routeMode === "broker" ? "tenant_vm_broker_base_url_required" : "tenant_vm_base_url_required");
    error.statusCode = 400;
    throw error;
  }

  const state = await readRouteSecrets(env);
  const existing = state.routes[vm.id] || {};
  const token = clean(input.token) || (!truthy(input.resetToken) && clean(existing.token)) || newScopedToken();
  state.routes[vm.id] = {
    token,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeRouteSecrets(state, env);

  const updated = await updateTenantVm(vm.id, {
    connectors: {
      ...vm.connectors,
      whatsappChatId: chatId,
      whatsappChatName: clean(input.chatName || input.displayName || vm.connectors.whatsappChatName),
      whatsappAccountId: clean(input.accountId || input.whatsappAccountId || vm.connectors.whatsappAccountId),
      whatsappRouteEnabled: routeTarget.target
        ? truthy(input.enabled, true)
        : false,
      whatsappRouteMode: routeTarget.routeMode,
      whatsappBrokerBaseUrl: routeTarget.brokerBaseUrl || clean(vm.connectors?.whatsappBrokerBaseUrl),
    },
  }, env);
  await appendEvent({
    type: updated.connectors.whatsappRouteEnabled ? "tenant_whatsapp_route_configured" : "tenant_whatsapp_route_prepared",
    tenantVmId: updated.id,
    ownerUserId: updated.ownerUserId,
    chatId,
    tokenReset: truthy(input.resetToken) || !existing.token,
    routeMode: routeTarget.routeMode,
    targetSource: routeTarget.targetSource,
  }, env).catch(() => {});
  const bridgeSendToken = await ensureTenantBridgeSendToken(updated, {
    chatId,
    accountId: clean(updated.connectors?.whatsappAccountId),
  }, env);

  return {
    ok: true,
    tenantVm: publicTenantVm(updated),
    route: publicRoute(updated, state.routes[updated.id], { includeToken: true, bridgeSendToken, env }),
  };
}

export async function disableTenantWhatsAppRoute(tenantVmId, env = process.env) {
  const vm = await getTenantVm(tenantVmId, env);
  if (!vm) {
    const error = new Error("tenant_vm_not_found");
    error.statusCode = 404;
    throw error;
  }
  const updated = await updateTenantVm(vm.id, {
    connectors: {
      ...vm.connectors,
      whatsappRouteEnabled: false,
    },
  }, env);
  await appendEvent({
    type: "tenant_whatsapp_route_disabled",
    tenantVmId: updated.id,
    ownerUserId: updated.ownerUserId,
    chatId: clean(updated.connectors?.whatsappChatId),
  }, env).catch(() => {});
  const state = await readRouteSecrets(env);
  return { ok: true, tenantVm: publicTenantVm(updated), route: publicRoute(updated, state.routes[updated.id] || {}, { env }) };
}

export async function listTenantWhatsAppRoutes(env = process.env) {
  const state = await readRouteSecrets(env);
  const vms = await listTenantVms(env);
  return vms.map((vm) => publicRoute(vm, state.routes[vm.id] || {}, { env }));
}

export async function tenantWhatsAppInboundForwardRoute(input = {}, env = process.env) {
  const chatId = clean(input.chatId || input.chat?.id || input.fromChatId);
  const accountId = clean(input.accountId);
  if (!chatId) return null;
  const state = await readRouteSecrets(env);
  const vms = await listTenantVms(env);
  for (const vm of vms) {
    if (vm.deletedAt || vm.status === "deleted") continue;
    if (vm.connectors?.whatsappRouteEnabled !== true) continue;
    if (clean(vm.connectors?.whatsappChatId) !== chatId) continue;
    const routeAccountId = clean(vm.connectors?.whatsappAccountId);
    if (accountId && routeAccountId && accountId !== routeAccountId) continue;
    const routeTarget = tenantRouteTarget(vm);
    const target = routeTarget.target;
    const token = clean(state.routes?.[vm.id]?.token);
    if (!target || !token) {
      const reason = !target && !token ? "missing_target_and_token" : (!target ? routeTarget.targetSource : "missing_token");
      await appendEvent({
        type: "tenant_whatsapp_route_lookup_failed",
        tenantVmId: vm.id,
        ownerUserId: vm.ownerUserId,
        chatId,
        accountId: routeAccountId,
        routeMode: routeTarget.routeMode,
        targetSource: routeTarget.targetSource,
        reason,
      }, env).catch(() => {});
      const error = attachRoutingFailure(new Error("tenant_route_missing"), {
        code: "tenant_route_missing",
        userFacingCategory: "instance_health",
        capability: "whatsapp",
        target,
        instanceId: vm.id,
        appUrl: routeAppUrl(vm, env),
        setupUrl: routeSetupUrl(vm, env),
        retryable: false,
        reason,
      });
      error.statusCode = 502;
      throw error;
    }
    await appendEvent({
      type: "tenant_whatsapp_route_lookup_resolved",
      tenantVmId: vm.id,
      ownerUserId: vm.ownerUserId,
      chatId,
      accountId: routeAccountId,
      routeMode: routeTarget.routeMode,
      targetSource: routeTarget.targetSource,
    }, env).catch(() => {});
    return {
      tenantVmId: vm.id,
      ownerUserId: vm.ownerUserId,
      target,
      token,
      appUrl: routeAppUrl(vm, env),
      setupUrl: routeSetupUrl(vm, env),
      chatName: clean(vm.connectors?.whatsappChatName),
      accountId: routeAccountId,
      routeMode: routeTarget.routeMode,
      targetSource: routeTarget.targetSource,
    };
  }
  return null;
}
