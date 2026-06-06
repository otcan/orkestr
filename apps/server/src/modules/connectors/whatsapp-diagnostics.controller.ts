import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  getWhatsAppBindingStatus,
  listWhatsAppBindingStatuses,
  listWhatsAppConnectorAccounts,
  resolveWhatsAppBinding,
} from "../../../../../packages/connectors/src/whatsapp-account-bindings.js";
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
      accounts: listWhatsAppConnectorAccounts({ status }),
      status,
    };
  }

  @Get("accounts/:accountId/status")
  async accountStatus(@Param("accountId") accountId: string) {
    const status = await getWhatsAppStatus();
    const accounts = listWhatsAppConnectorAccounts({ status });
    const account = accounts.find((item) => item.accountId === accountId || item.id === accountId);
    if (!account) throw httpError("wa_account_missing", 404);
    return { account, status };
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
    const account = listWhatsAppConnectorAccounts({ status: nextStatus }).find((item) => item.accountId === accountId || item.id === accountId);
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
    const account = listWhatsAppConnectorAccounts({ status: nextStatus }).find((item) => item.accountId === accountId || item.id === accountId);
    if (!account) throw httpError("wa_account_missing", 404);
    return { ok: true, account };
  }

  @Get("bindings")
  async bindings() {
    const status = await getWhatsAppStatus();
    return listWhatsAppBindingStatuses({ status });
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
