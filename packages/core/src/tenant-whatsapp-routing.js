import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { attachRoutingFailure } from "./routing-failures.js";
import { getTenantVm, listTenantVms, publicTenantVm, updateTenantVm } from "./tenant-vm-registry.js";

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value) {
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

function newScopedToken() {
  return `owt_${crypto.randomBytes(32).toString("base64url")}`;
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

function publicRoute(vm, secret = {}, { includeToken = false } = {}) {
  const token = clean(secret.token);
  const routeTarget = tenantRouteTarget(vm);
  return {
    tenantVmId: vm.id,
    ownerUserId: vm.ownerUserId,
    chatId: clean(vm.connectors?.whatsappChatId),
    chatName: clean(vm.connectors?.whatsappChatName),
    accountId: clean(vm.connectors?.whatsappAccountId),
    enabled: vm.connectors?.whatsappRouteEnabled === true,
    target: routeTarget.target,
    routeMode: routeTarget.routeMode,
    targetSource: routeTarget.targetSource,
    tokenConfigured: Boolean(token),
    tokenPreview: tokenPreview(token),
    ...(includeToken && token ? { token } : {}),
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
  if (!routeTarget.target) {
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
      whatsappRouteEnabled: input.enabled === undefined ? true : truthy(input.enabled),
      whatsappRouteMode: routeTarget.routeMode,
      whatsappBrokerBaseUrl: routeTarget.brokerBaseUrl || clean(vm.connectors?.whatsappBrokerBaseUrl),
    },
  }, env);
  await appendEvent({
    type: "tenant_whatsapp_route_configured",
    tenantVmId: updated.id,
    ownerUserId: updated.ownerUserId,
    chatId,
    tokenReset: truthy(input.resetToken) || !existing.token,
    routeMode: routeTarget.routeMode,
    targetSource: routeTarget.targetSource,
  }, env).catch(() => {});

  return {
    ok: true,
    tenantVm: publicTenantVm(updated),
    route: publicRoute(updated, state.routes[updated.id], { includeToken: true }),
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
  return { ok: true, tenantVm: publicTenantVm(updated), route: publicRoute(updated, state.routes[updated.id] || {}) };
}

export async function listTenantWhatsAppRoutes(env = process.env) {
  const state = await readRouteSecrets(env);
  const vms = await listTenantVms(env);
  return vms.map((vm) => publicRoute(vm, state.routes[vm.id] || {}));
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
      chatName: clean(vm.connectors?.whatsappChatName),
      accountId: routeAccountId,
      routeMode: routeTarget.routeMode,
      targetSource: routeTarget.targetSource,
    };
  }
  return null;
}
