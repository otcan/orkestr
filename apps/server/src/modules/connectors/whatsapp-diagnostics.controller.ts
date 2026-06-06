import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
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
  deleteWhatsAppConnectorAccount,
  updateWhatsAppConnectorAccount,
  upsertWhatsAppConnectorAccount,
} from "../../../../../packages/connectors/src/whatsapp-account-registry.js";
import { getWhatsAppStatus } from "../../../../../packages/connectors/src/whatsapp.js";
import {
  localWhatsAppBridgeBasePath,
  startLocalWhatsAppAccount,
} from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { httpError } from "../../common/http.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function localStatusMode(status: Record<string, any> = {}): boolean {
  return clean(status.mode) === "local" || clean(status.bridgeUrl) === localWhatsAppBridgeBasePath;
}

@Controller("api/connectors/whatsapp")
export class WhatsAppDiagnosticsController {
  @Get("accounts")
  async accounts() {
    const status = await getWhatsAppStatus();
    return {
      accounts: await listPersistentWhatsAppConnectorAccounts({ status }),
      status,
    };
  }

  @Post("accounts")
  @HttpCode(201)
  async createAccount(@Body() body: Record<string, unknown> = {}) {
    const account = await upsertWhatsAppConnectorAccount(body, process.env);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    return {
      ok: true,
      account: accounts.find((item) => item.accountId === account.accountId) || account,
      status,
    };
  }

  @Get("accounts/:accountId/status")
  async accountStatus(@Param("accountId") accountId: string) {
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    const account = accounts.find((item) => item.accountId === accountId || item.id === accountId);
    if (!account) throw httpError("wa_account_missing", 404);
    return { account, status };
  }

  @Put("accounts/:accountId")
  async updateAccount(@Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    const account = await updateWhatsAppConnectorAccount(accountId, body, process.env);
    const status = await getWhatsAppStatus();
    const accounts = await listPersistentWhatsAppConnectorAccounts({ status });
    return {
      ok: true,
      account: accounts.find((item) => item.accountId === account.accountId) || account,
      status,
    };
  }

  @Delete("accounts/:accountId")
  async deleteAccount(@Param("accountId") accountId: string) {
    return { ok: true, account: await deleteWhatsAppConnectorAccount(accountId, process.env) };
  }

  @Post("accounts/:accountId/pairing-session")
  @HttpCode(202)
  async accountPairingSession(@Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    const status = await getWhatsAppStatus();
    if (!localStatusMode(status)) throw httpError("wa_account_pairing_not_supported_for_external_bridge", 400);
    await startLocalWhatsAppAccount(accountId, process.env, {
      phoneNumber: clean(body.phoneNumber || body.phone),
      showNotification: body.showNotification !== false,
      intervalMs: Number(body.intervalMs || 0) || undefined,
      authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
    });
    const nextStatus = await getWhatsAppStatus();
    const account = (await listPersistentWhatsAppConnectorAccounts({ status: nextStatus })).find((item) => item.accountId === accountId || item.id === accountId);
    if (!account) throw httpError("wa_account_missing", 404);
    return {
      ok: true,
      account,
      pairing: {
        state: account.state,
        qrRequired: account.qrRequired,
        qrAvailable: account.qrAvailable,
        qrUrl: account.qrUrl || `${localWhatsAppBridgeBasePath}/qr.svg?accountId=${encodeURIComponent(account.accountId)}`,
        nextAction: account.nextAction,
      },
    };
  }

  @Post("accounts/:accountId/reconnect")
  @HttpCode(202)
  async accountReconnect(@Param("accountId") accountId: string) {
    const status = await getWhatsAppStatus();
    if (!localStatusMode(status)) throw httpError("wa_account_reconnect_not_supported_for_external_bridge", 400);
    await startLocalWhatsAppAccount(accountId, process.env, { showNotification: true });
    const nextStatus = await getWhatsAppStatus();
    const account = (await listPersistentWhatsAppConnectorAccounts({ status: nextStatus })).find((item) => item.accountId === accountId || item.id === accountId);
    if (!account) throw httpError("wa_account_missing", 404);
    return { ok: true, account };
  }

  @Get("bindings")
  async bindings() {
    const status = await getWhatsAppStatus();
    return listWhatsAppBindingStatuses({ status });
  }

  @Post("bindings")
  @HttpCode(201)
  async createBinding(@Body() body: Record<string, unknown> = {}) {
    const result = await upsertWhatsAppThreadBinding(body, process.env);
    const status = await getWhatsAppStatus();
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
  async bindingStatus(@Param("bindingId") bindingId: string) {
    const status = await getWhatsAppStatus();
    return getWhatsAppBindingStatus(bindingId, { status });
  }

  @Put("bindings/:bindingId")
  async updateBinding(@Param("bindingId") bindingId: string, @Body() body: Record<string, unknown> = {}) {
    const result = await updateWhatsAppThreadBinding(bindingId, body, process.env);
    const status = await getWhatsAppStatus();
    const refreshed = await getWhatsAppBindingStatus(result.binding.id || result.binding.threadId, { status });
    return {
      ok: true,
      thread: result.thread,
      binding: refreshed.binding,
    };
  }

  @Delete("bindings/:bindingId")
  async deleteBinding(@Param("bindingId") bindingId: string) {
    const result = await retireWhatsAppThreadBinding(bindingId, process.env);
    const status = await getWhatsAppStatus();
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
}
