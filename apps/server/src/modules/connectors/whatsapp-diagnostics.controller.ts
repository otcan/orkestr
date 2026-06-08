import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import {
  getWhatsAppBindingStatus,
  listWhatsAppBindingStatuses,
  listPersistentWhatsAppConnectorAccounts,
  retireWhatsAppThreadBinding,
  resolveWhatsAppBinding,
  updateWhatsAppThreadBinding,
  upsertWhatsAppThreadBinding,
} from "../../../../../packages/connectors/src/whatsapp-account-bindings.js";
import {
  applyConnectorOutboxJobAction,
  listConnectorOutboxJobs,
  normalizeConnectorOutboxAction,
} from "../../../../../packages/connectors/src/connector-outbox.js";
import {
  assertWhatsAppConnectorAccountAccess,
  deleteWhatsAppConnectorAccountForPrincipal,
  listWhatsAppConnectorAccountsForPrincipal,
  updateWhatsAppConnectorAccountForPrincipal,
  upsertWhatsAppConnectorAccountForPrincipal,
} from "../../../../../packages/connectors/src/whatsapp-account-registry.js";
import { migrateWhatsAppBrokerConfig } from "../../../../../packages/connectors/src/whatsapp-broker-migration.js";
import {
  applyWhatsAppConnectorOutboxAction,
  getWhatsAppStatus,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import {
  localWhatsAppBridgeBasePath,
  getLocalWhatsAppQrSvg,
  logoutLocalWhatsAppAccount,
  startLocalWhatsAppAccount,
} from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { whatsappBindingAclAllows } from "../../../../../packages/connectors/src/whatsapp-binding-acl.js";
import { whatsappAccountLookupKeys } from "../../../../../packages/connectors/src/whatsapp-account-identity.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function localStatusMode(status: Record<string, any> = {}): boolean {
  return clean(status.mode) === "local" || clean(status.bridgeUrl) === localWhatsAppBridgeBasePath;
}

function filterBindings(payload: Record<string, any> = {}, filters: Record<string, string> = {}) {
  const user = clean(filters.user || filters.userId || filters.ownerUserId).toLowerCase();
  const thread = clean(filters.thread || filters.threadId).toLowerCase();
  const chat = clean(filters.chat || filters.chatId).toLowerCase();
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  if (!user && !thread && !chat) return payload;
  return {
    ...payload,
    bindings: bindings.filter((binding: Record<string, any> = {}) => {
      if (user && clean(binding.ownerUserId || binding.userId).toLowerCase() !== user) return false;
      if (thread && clean(binding.threadId).toLowerCase() !== thread && clean(binding.threadName).toLowerCase() !== thread) return false;
      if (chat && clean(binding.chatId).toLowerCase() !== chat) return false;
      return true;
    }),
  };
}

function principalContext(principal: any = {}) {
  const userId = clean(principal.userId);
  return {
    principalKind: clean(principal.kind || "user"),
    principalId: userId,
    userId,
    ownerUserId: userId,
  };
}

function bindingVisibleToPrincipal(binding: Record<string, any> = {}, principal: any = {}) {
  if (isAdminPrincipal(principal)) return true;
  const context = principalContext(principal);
  if (!context.userId) return false;
  if (clean(binding.ownerUserId || binding.userId).toLowerCase() === context.userId.toLowerCase()) return true;
  return ["read", "send", "manage"].some((action) => (whatsappBindingAclAllows as any)(binding, action, context));
}

function filterBindingsForPrincipal(payload: Record<string, any> = {}, principal: any = {}) {
  if (isAdminPrincipal(principal)) return payload;
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  return {
    ...payload,
    bindings: bindings.filter((binding: Record<string, any> = {}) => bindingVisibleToPrincipal(binding, principal)),
  };
}

function bindingSkipped(binding: Record<string, any> = {}) {
  return binding.enabled === false || binding.routeEligible === false || binding.retired === true || binding.deprecated === true;
}

function activeBindingUsesAccount(binding: Record<string, any> = {}, accountId = "") {
  const id = clean(accountId);
  if (!id || bindingSkipped(binding)) return false;
  const requiredAccountIds = [
    binding.responderConnectorAccountId,
    binding.responderAccountId,
    binding.outboundAccountId,
    binding.targetAccountId,
    binding.accountId,
  ].map((candidate) => clean(candidate)).filter(Boolean);
  return requiredAccountIds.some((candidate) => candidate === id);
}

function accountRequiredByBroker(account: Record<string, any> = {}, bindings: any[] = [], selectedAccountId = "") {
  const accountId = clean(account.accountId || account.id);
  if (!accountId) return false;
  if (selectedAccountId) return true;
  if (account.autostart === true) return true;
  return bindings.some((binding) => activeBindingUsesAccount(binding, accountId));
}

function accountMatches(account: Record<string, any> = {}, accountId = "") {
  const id = clean(accountId);
  if (!id) return false;
  const wanted = id.toLowerCase();
  return (whatsappAccountLookupKeys as any)(account, process.env).some((key: string) => clean(key).toLowerCase() === wanted);
}

function findAccount(accounts: any[] = [], accountId = "") {
  return accounts.find((account) => accountMatches(account, accountId)) || null;
}

function filterStatusAccounts(status: Record<string, any> = {}, visibleAccounts: any[] = []) {
  const visibleIds = new Set(visibleAccounts
    .map((account) => clean(account.accountId || account.id))
    .filter(Boolean));
  const accountEntries: Array<[string, Record<string, any>]> = (Array.isArray(status.accounts) ? status.accounts : [])
    .map((account: Record<string, any> = {}) => [clean(account.accountId || account.id), account] as [string, Record<string, any>])
    .filter(([accountId]) => Boolean(accountId));
  const healthAccountEntries: Array<[string, Record<string, any>]> = (Array.isArray(status.health?.accounts) ? status.health.accounts : [])
    .map((account: Record<string, any> = {}) => [clean(account.accountId || account.id), account] as [string, Record<string, any>])
    .filter(([accountId]) => Boolean(accountId));
  const accountById = new Map(accountEntries);
  const healthAccountById = new Map(healthAccountEntries);
  const accounts = visibleAccounts.map((account: Record<string, any> = {}) => {
    const accountId = clean(account.accountId || account.id);
    return {
      ...(accountById.get(accountId) || {}),
      ...account,
      id: clean(account.id) || accountId,
      accountId,
    };
  });
  const healthAccounts = accounts.map((account: Record<string, any> = {}) => {
    const accountId = clean(account.accountId || account.id);
    return {
      ...(healthAccountById.get(accountId) || {}),
      ...account,
      id: clean(account.id) || accountId,
      accountId,
    };
  });
  const health = status.health && typeof status.health === "object" && !Array.isArray(status.health)
    ? {
        ...status.health,
        accounts: healthAccounts,
      }
    : status.health;
  return { ...status, accounts, health };
}

function assertAccountForPrincipal(account: Record<string, any> | null, principal: any, action: string) {
  if (!account) throw httpError("wa_account_missing", 404);
  assertWhatsAppConnectorAccountAccess(account, principal, action, process.env);
  return account;
}

function responderAccountIdFromBody(body: Record<string, unknown> = {}) {
  return clean(body.replyAccountId || body.bridgeAccountId || body.receivingAccountId || body.responderConnectorAccountId || body.responderAccountId || body.outboundAccountId || body.accountId);
}

function bindingBodyForPrincipal(body: Record<string, unknown> = {}, principal: any = {}) {
  if (isAdminPrincipal(principal)) return body;
  const userId = clean(principal.userId);
  const acl = body.acl && typeof body.acl === "object" && !Array.isArray(body.acl)
    ? body.acl as Record<string, unknown>
    : {};
  return {
    ...body,
    ownerUserId: userId,
    userId,
    acl: {
      ...acl,
      read: { mode: "owner-only" },
      manage: { mode: "owner-only" },
    },
  };
}

async function assertResponderAccountBodyForPrincipal(body: Record<string, unknown> = {}, principal: any, status: Record<string, any>, action: string) {
  const accountId = responderAccountIdFromBody(body);
  if (!accountId) return null;
  const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
  return assertAccountForPrincipal(findAccount(accounts, accountId), principal, action);
}

function assertBindingManageForPrincipal(binding: Record<string, any> | null, principal: any) {
  if (!binding) throw httpError("wa_binding_missing", 404);
  if (isAdminPrincipal(principal)) return binding;
  if ((whatsappBindingAclAllows as any)(binding, "manage", principalContext(principal))) return binding;
  throw httpError("wa_binding_manage_forbidden", 403);
}

function assertAdminRequest(request: any) {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("whatsapp_outbox_admin_required", 403);
}

function whatsappDoctorPayload(accounts: any[] = [], bindings: any[] = [], accountId = "") {
  const selectedAccount = clean(accountId);
  const accountChecks = accounts.map((account) => {
    const id = clean(account.accountId || account.id);
    const pairable = Boolean(account.qrRequired || account.pairingCode || account.state === "pairing_code");
    const ready = Boolean(account.ready || pairable);
    const required = accountRequiredByBroker(account, bindings, selectedAccount);
    const skipped = !ready && !required;
    const ok = ready || skipped;
    return {
      type: "account",
      id,
      ok,
      skipped,
      state: clean(account.state),
      nextAction: clean(account.nextAction),
      reason: skipped ? "account_not_required" : ok ? "ready_or_pairable" : clean(account.error) || "account_not_ready",
    };
  });
  const bindingChecks = bindings.map((binding) => {
    const skipped = bindingSkipped(binding);
    const ok = binding.state === "ready";
    return {
      type: "binding",
      id: clean(binding.id || binding.bindingId),
      ok: skipped || ok,
      skipped,
      state: clean(binding.state),
      nextAction: clean(binding.nextAction),
      reason: skipped ? "binding_not_route_eligible" : ok ? "ready" : clean(binding.reason) || "binding_not_ready",
    };
  });
  const checks = [...accountChecks, ...bindingChecks];
  const errors = checks.filter((check) => !check.ok);
  const warnings = checks.filter((check) => check.skipped);
  return {
    ok: errors.length === 0,
    status: errors.length ? "broken" : "ok",
    summary: errors.length
      ? `${errors.length} WhatsApp account or binding checks need action.`
      : "WhatsApp accounts and bindings are ready.",
    accountId: clean(accountId),
    counts: {
      ok: checks.length - errors.length,
      warnings: warnings.length,
      errors: errors.length,
      accounts: accounts.length,
      bindings: bindings.length,
    },
    checks,
    accounts,
    bindings,
    generatedAt: new Date().toISOString(),
  };
}

function outboxFilters(query: Record<string, unknown> = {}) {
  return {
    connector: "whatsapp",
    state: clean(query.state || query.status),
    tenantId: clean(query.tenantId || query.tenant || query.ownerUserId || query.userId || query.user),
    ownerUserId: clean(query.ownerUserId || query.userId || query.user),
    accountId: clean(query.accountId || query.account),
    chatId: clean(query.chatId || query.chat),
    threadId: clean(query.threadId || query.thread),
    deliveryType: clean(query.deliveryType || query.type),
    limit: Number(query.limit || 0) || 0,
  };
}

function jobIdsFromBody(body: Record<string, unknown> = {}) {
  const raw = Array.isArray(body.jobIds)
    ? body.jobIds
    : Array.isArray(body.ids)
      ? body.ids
      : String(body.jobIds || body.ids || body.jobId || body.id || "").split(/[\s,]+/g);
  return raw.map((item) => clean(item)).filter(Boolean);
}

async function applyWhatsAppOutboxOperatorAction(jobId: string, action: string, body: Record<string, unknown> = {}) {
  try {
    const result = await applyConnectorOutboxJobAction(jobId, action, {
      reason: clean(body.reason),
      operator: clean(body.operator || body.operatorId || "operator"),
      brokerAck: body.brokerAck,
      deliveredAt: clean(body.deliveredAt),
    }, process.env);
    const job = result.job || {};
    const whatsapp = await applyWhatsAppConnectorOutboxAction(job, action, {
      reason: clean(body.reason),
      deliveredAt: clean(body.deliveredAt),
    }, process.env);
    return { ...result, job, whatsapp };
  } catch (error) {
    throw httpError(clean((error as Error)?.message) || "connector_outbox_action_failed", Number((error as any)?.statusCode || (error as any)?.status || 500) || 500);
  }
}

@Controller("api/connectors/whatsapp")
export class WhatsAppDiagnosticsController {
  @Get("accounts")
  async accounts(@Req() request: any) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const visibleAccounts = listWhatsAppConnectorAccountsForPrincipal(accounts, principal, process.env);
    return {
      accounts: visibleAccounts,
      status: filterStatusAccounts(status, visibleAccounts),
    };
  }

  @Post("accounts")
  @HttpCode(201)
  async createAccount(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    const existingAccounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const existing = findAccount(existingAccounts, clean(body.accountId || body.id || body.runtimeAccountId));
    if (existing) assertAccountForPrincipal(existing, principal, "wa_account_update");
    const account = await upsertWhatsAppConnectorAccountForPrincipal(body, principal, process.env);
    const nextStatus = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status: nextStatus });
    const visibleAccounts = listWhatsAppConnectorAccountsForPrincipal(accounts, principal, process.env);
    return {
      ok: true,
      account: findAccount(visibleAccounts, account.accountId) || account,
      status: filterStatusAccounts(nextStatus, visibleAccounts),
    };
  }

  @Get("accounts/:accountId/status")
  async accountStatus(@Req() request: any, @Param("accountId") accountId: string) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const account = assertAccountForPrincipal(findAccount(accounts, accountId), principal, "wa_account_read");
    return { account, status: filterStatusAccounts(status, [account]) };
  }

  @Get("accounts/:accountId/qr.svg")
  async accountQrSvg(@Req() request: any, @Param("accountId") accountId: string, @Res() response: any) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    assertAccountForPrincipal(findAccount(accounts, accountId), principal, "wa_account_read");
    const svg = await getLocalWhatsAppQrSvg(accountId, process.env);
    if (!svg) {
      return response
        .status(404)
        .header("cache-control", "no-store")
        .type("application/json; charset=utf-8")
        .send({ error: "whatsapp_qr_not_available" });
    }
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("image/svg+xml; charset=utf-8")
      .send(svg);
  }

  @Put("accounts/:accountId")
  async updateAccount(@Req() request: any, @Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const account = await updateWhatsAppConnectorAccountForPrincipal(accountId, body, principal, process.env);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const visibleAccounts = listWhatsAppConnectorAccountsForPrincipal(accounts, principal, process.env);
    return {
      ok: true,
      account: findAccount(visibleAccounts, account.accountId) || account,
      status: filterStatusAccounts(status, visibleAccounts),
    };
  }

  @Delete("accounts/:accountId")
  async deleteAccount(@Req() request: any, @Param("accountId") accountId: string) {
    const principal = requestPrincipal(request);
    return { ok: true, account: await deleteWhatsAppConnectorAccountForPrincipal(accountId, principal, process.env) };
  }

  @Post("accounts/:accountId/pairing-session")
  @HttpCode(202)
  async accountPairingSession(@Req() request: any, @Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    assertAccountForPrincipal(findAccount(await listPersistentWhatsAppConnectorAccounts({ status }), accountId), principal, "wa_account_pair");
    if (!localStatusMode(status)) throw httpError("wa_account_pairing_not_supported_for_external_bridge", 400);
    await startLocalWhatsAppAccount(accountId, process.env, {
      phoneNumber: clean(body.phoneNumber || body.phone),
      showNotification: body.showNotification !== false,
      intervalMs: Number(body.intervalMs || 0) || undefined,
      authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
    });
    const nextStatus = await getWhatsAppStatus();
    const account = assertAccountForPrincipal(findAccount(await listPersistentWhatsAppConnectorAccounts({ status: nextStatus }), accountId), principal, "wa_account_read");
    return {
      ok: true,
      account,
      pairing: {
        state: account.state,
        qrRequired: account.qrRequired,
        qrAvailable: account.qrAvailable,
        qrUrl: account.qrUrl || `${localWhatsAppBridgeBasePath}/qr.svg?accountId=${encodeURIComponent(account.accountId)}`,
        pairingCode: account.pairingCode || "",
        pairingCodeUpdatedAt: account.pairingCodeUpdatedAt || null,
        pairingPhoneNumber: account.pairingPhoneNumber || "",
        nextAction: account.nextAction,
      },
    };
  }

  @Post("accounts/:accountId/reconnect")
  @HttpCode(202)
  async accountReconnect(@Req() request: any, @Param("accountId") accountId: string) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    assertAccountForPrincipal(findAccount(await listPersistentWhatsAppConnectorAccounts({ status }), accountId), principal, "wa_account_reconnect");
    if (!localStatusMode(status)) throw httpError("wa_account_reconnect_not_supported_for_external_bridge", 400);
    await startLocalWhatsAppAccount(accountId, process.env, { showNotification: true });
    const nextStatus = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status: nextStatus });
    const account = assertAccountForPrincipal(findAccount(accounts, accountId), principal, "wa_account_read");
    return { ok: true, account, status: filterStatusAccounts(nextStatus, [account]) };
  }

  @Post("accounts/:accountId/disconnect")
  @HttpCode(200)
  async accountDisconnect(@Req() request: any, @Param("accountId") accountId: string) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    assertAccountForPrincipal(findAccount(await listPersistentWhatsAppConnectorAccounts({ status }), accountId), principal, "wa_account_disconnect");
    if (!localStatusMode(status)) throw httpError("wa_account_disconnect_not_supported_for_external_bridge", 400);
    await logoutLocalWhatsAppAccount(accountId, process.env);
    const nextStatus = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status: nextStatus });
    const account = assertAccountForPrincipal(findAccount(accounts, accountId), principal, "wa_account_read");
    return { ok: true, account, status: filterStatusAccounts(nextStatus, [account]) };
  }

  @Get("doctor")
  async doctor(@Query("account") account = "", @Query("accountId") accountId = "") {
    const selectedAccount = clean(account || accountId);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const bindingPayload = await listWhatsAppBindingStatuses({ status });
    const visibleAccounts = selectedAccount
      ? accounts.filter((item) => item.accountId === selectedAccount || item.id === selectedAccount)
      : accounts;
    const visibleBindings = selectedAccount
      ? (bindingPayload.bindings || []).filter((binding: Record<string, any> = {}) =>
        Array.isArray(binding.accountIds) && binding.accountIds.includes(selectedAccount))
      : bindingPayload.bindings || [];
    return whatsappDoctorPayload(visibleAccounts, visibleBindings, selectedAccount);
  }

  @Post("migrate")
  @HttpCode(200)
  async migrate(@Body() body: Record<string, unknown> = {}) {
    const status = await getWhatsAppStatus();
    return migrateWhatsAppBrokerConfig({ dryRun: body.dryRun === true, status }, process.env);
  }

  @Get("bindings")
  async bindings(@Req() request: any, @Query("user") user = "", @Query("userId") userId = "", @Query("thread") thread = "", @Query("threadId") threadId = "", @Query("chat") chat = "", @Query("chatId") chatId = "") {
    const status = await getWhatsAppStatus();
    const principal = requestPrincipal(request);
    return filterBindings(filterBindingsForPrincipal(await listWhatsAppBindingStatuses({ status }), principal), { user, userId, thread, threadId, chat, chatId });
  }

  @Get("outbox")
  async outbox(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return listConnectorOutboxJobs(outboxFilters(query), process.env);
  }

  @Post("outbox/actions")
  @HttpCode(202)
  async outboxBulkAction(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const action = normalizeConnectorOutboxAction(clean(body.action));
    if (!action) throw httpError("connector_outbox_action_invalid", 400);
    const jobIds = jobIdsFromBody(body);
    if (!jobIds.length) throw httpError("connector_outbox_job_ids_required", 400);
    const results: any[] = [];
    for (const jobId of jobIds) {
      results.push(await applyWhatsAppOutboxOperatorAction(jobId, action, body));
    }
    return {
      ok: true,
      action,
      count: results.length,
      results,
    };
  }

  @Post("outbox/:jobId/:action")
  @HttpCode(202)
  async outboxAction(@Req() request: any, @Param("jobId") jobId: string, @Param("action") rawAction: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const action = normalizeConnectorOutboxAction(rawAction);
    if (!action) throw httpError("connector_outbox_action_invalid", 400);
    return applyWhatsAppOutboxOperatorAction(jobId, action, body);
  }

  @Post("bindings")
  @HttpCode(201)
  async createBinding(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    await assertResponderAccountBodyForPrincipal(body, principal, status, "wa_account_bind");
    const result = await upsertWhatsAppThreadBinding(bindingBodyForPrincipal(body, principal), process.env);
    const refreshed = await getWhatsAppBindingStatus(result.binding.id || result.binding.threadId, { status });
    return {
      ok: true,
      thread: result.thread,
      binding: refreshed.binding,
    };
  }

  @Get("bindings/resolve")
  async resolveBinding(@Query("thread") thread = "", @Query("chatId") chatId = "", @Query("accountId") accountId = "") {
    const status = await getWhatsAppStatus();
    return resolveWhatsAppBinding({ thread, chatId, accountId }, { status });
  }

  @Get("bindings/:bindingId/status")
  async bindingStatus(@Req() request: any, @Param("bindingId") bindingId: string) {
    const status = await getWhatsAppStatus();
    const payload = await getWhatsAppBindingStatus(bindingId, { status });
    if (!bindingVisibleToPrincipal(payload.binding, requestPrincipal(request))) throw httpError("wa_binding_read_forbidden", 403);
    return payload;
  }

  @Put("bindings/:bindingId")
  async updateBinding(@Req() request: any, @Param("bindingId") bindingId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const status = await getWhatsAppStatus();
    const existing = await getWhatsAppBindingStatus(bindingId, { status });
    assertBindingManageForPrincipal(existing.binding, principal);
    await assertResponderAccountBodyForPrincipal(body, principal, status, "wa_account_bind");
    const result = await updateWhatsAppThreadBinding(bindingId, bindingBodyForPrincipal(body, principal), process.env);
    const refreshed = await getWhatsAppBindingStatus(result.binding.id || result.binding.threadId, { status });
    return {
      ok: true,
      thread: result.thread,
      binding: refreshed.binding,
    };
  }

  @Delete("bindings/:bindingId")
  async deleteBinding(@Req() request: any, @Param("bindingId") bindingId: string) {
    const status = await getWhatsAppStatus();
    const existing = await getWhatsAppBindingStatus(bindingId, { status });
    assertBindingManageForPrincipal(existing.binding, requestPrincipal(request));
    const result = await retireWhatsAppThreadBinding(bindingId, process.env);
    const refreshed = await getWhatsAppBindingStatus(result.binding.id || result.binding.threadId, { status });
    return {
      ok: true,
      thread: result.thread,
      binding: refreshed.binding,
    };
  }

  @Get("codex/status")
  async codexStatus(@Query("thread") thread = "", @Query("chatId") chatId = "", @Query("accountId") accountId = "") {
    const status = await getWhatsAppStatus();
    const resolution = await resolveWhatsAppBinding({ thread, chatId, accountId }, { status });
    return {
      ok: resolution.ok,
      thread: clean(thread) || resolution.selected?.threadId || "",
      resolution,
    };
  }

  @Post("codex/connect")
  @HttpCode(201)
  async codexConnect(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const thread = clean(body.thread || body.threadId);
    const accountId = clean(body.account || body.accountId || body.responderAccountId || body.responderConnectorAccountId);
    if (!thread) throw httpError("thread_id_required", 400);
    if (!accountId) throw httpError("wa_responder_account_required", 400);
    const status = await getWhatsAppStatus();
    await assertResponderAccountBodyForPrincipal({
      ...body,
      responderConnectorAccountId: accountId,
    }, principal, status, "wa_account_bind");
    const safeBody = bindingBodyForPrincipal(body, principal);
    const result = await upsertWhatsAppThreadBinding({
      ...safeBody,
      level: "thread",
      threadId: thread,
      chatId: clean(body.chat || body.chatId),
      responderConnectorAccountId: accountId,
      responderAccountId: accountId,
      outboundAccountId: accountId,
      acl: safeBody.acl,
    }, process.env);
    const refreshed = await getWhatsAppBindingStatus(result.binding.id || result.binding.threadId || thread, { status });
    const resolution = await resolveWhatsAppBinding({
      thread,
      chatId: refreshed.binding?.chatId || clean(body.chat || body.chatId),
      accountId,
    }, { status });
    return {
      ok: resolution.ok,
      thread: result.thread,
      binding: refreshed.binding,
      resolution,
    };
  }
}
