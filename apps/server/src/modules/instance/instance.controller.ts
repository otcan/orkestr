import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import {
  getLocalInstanceConfig,
  getLocalInstanceContext,
  observeLocalInstanceConfig,
  patchLocalInstanceConfig,
} from "../../../../../packages/core/src/instance-config-service.js";
import {
  createInstanceFolder,
  downloadInstanceFile,
  listInstanceFiles,
  previewInstanceFile,
  uploadInstanceFiles,
} from "../../../../../packages/core/src/instance-virtual-files.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import {
  canonicalInstanceAppSessionCookiePath,
  deriveInstanceSecuritySession,
  sessionCookieHeader,
} from "../../../../../packages/core/src/security.js";
import {
  instanceAccountByPublicRef,
  instanceAccountSwitcherEnabled,
  listInstanceAccounts,
  publicInstanceAccount,
} from "../../instance-account-switcher.js";

function assertInstanceControlAccess(request: any): void {
  const principal = requestPrincipal(request);
  const tenantBoundary = Boolean(
    String(process.env.ORKESTR_TENANT_VM_ID || process.env.ORKESTR_TENANT_SLICE_ID || "").trim() ||
    String(process.env.ORKESTR_TENANT_BOUNDARY || "").trim() === "tenant-vm"
  );
  if (isAdminPrincipal(principal) || tenantBoundary) return;
  throw Object.assign(new Error("instance_control_scope_denied"), { statusCode: 403 });
}

function assertInstanceAccountAccess(request: any): void {
  if (!instanceAccountSwitcherEnabled(process.env)) {
    throw Object.assign(new Error("instance_accounts_not_found"), { statusCode: 404 });
  }
  if (!isAdminPrincipal(requestPrincipal(request))) {
    throw Object.assign(new Error("admin_required"), { statusCode: 403 });
  }
  if (!request?.orkestrSecuritySession?.id || request.orkestrSecuritySession.shareId) {
    throw Object.assign(new Error("browser_session_required"), { statusCode: 401 });
  }
}

function requestAddress(request: any): string {
  const forwarded = String(request?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || String(request?.ip || request?.socket?.remoteAddress || "")).replace(/^::ffff:/, "");
}

function expectedGeneration(ifMatch: string | undefined, body: Record<string, unknown>): number {
  const raw = String(ifMatch || body.expectedGeneration || "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error("instance_config_if_match_required"), { statusCode: 428 });
  }
  return parsed;
}

@Controller("api/instance")
export class InstanceController {
  @Get("context")
  async context(@Req() request: any) {
    return {
      ok: true,
      instance: {
        ...(await getLocalInstanceContext(process.env)),
        ...(instanceAccountSwitcherEnabled(process.env) &&
          isAdminPrincipal(requestPrincipal(request)) &&
          Boolean(request?.orkestrSecuritySession?.id) &&
          !request?.orkestrSecuritySession?.shareId
          ? { accountSwitcherEnabled: true }
          : {}),
      },
    };
  }

  @Get("accounts")
  async accounts(@Req() request: any) {
    assertInstanceAccountAccess(request);
    return {
      ok: true,
      accounts: (await listInstanceAccounts(process.env)).map(publicInstanceAccount),
    };
  }

  @Post("accounts/:publicRef/session")
  @HttpCode(200)
  async openAccount(
    @Req() request: any,
    @Param("publicRef") publicRef: string,
    @Res({ passthrough: true }) response: any,
  ) {
    assertInstanceAccountAccess(request);
    const account = await instanceAccountByPublicRef(publicRef, process.env);
    if (!account) throw Object.assign(new Error("instance_account_not_found"), { statusCode: 404 });
    const derived = await deriveInstanceSecuritySession({
      sourceSession: request.orkestrSecuritySession,
      instanceId: account.internalInstanceId,
      userAgent: String(request?.headers?.["user-agent"] || ""),
      ip: requestAddress(request),
      env: process.env,
    });
    const requestHost = String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "");
    response.setHeader("set-cookie", sessionCookieHeader(derived.token, process.env, {
      requestHost,
      path: canonicalInstanceAppSessionCookiePath(account.publicRef),
    }));
    return { ok: true, account: publicInstanceAccount(account), url: account.canonicalPath };
  }

  @Get("config")
  async config(@Req() request: any, @Res({ passthrough: true }) response: any) {
    assertInstanceControlAccess(request);
    const result = await getLocalInstanceConfig(process.env);
    response?.setHeader?.("etag", `"${result.config.generation}"`);
    return {
      ok: true,
      instance: {
        publicRef: result.identity.publicRef || "",
        canonicalPath: result.identity.publicRef ? `/instance/${encodeURIComponent(result.identity.publicRef)}/` : "",
      },
      config: result.config,
    };
  }

  @Get("status")
  async status(@Req() request: any, @Res({ passthrough: true }) response: any) {
    assertInstanceControlAccess(request);
    const result = await observeLocalInstanceConfig(process.env);
    response?.setHeader?.("etag", `"${result.config.generation}"`);
    return {
      ok: true,
      instance: {
        publicRef: result.identity.publicRef || "",
        canonicalPath: result.identity.publicRef ? `/instance/${encodeURIComponent(result.identity.publicRef)}/` : "",
      },
      config: result.config,
      status: result.status,
    };
  }

  @Get("files")
  async files(@Req() request: any, @Query("mount") mountId = "", @Query("path") filePath = "") {
    return listInstanceFiles({ mountId, path: filePath }, requestPrincipal(request), process.env);
  }

  @Get("files/preview")
  async previewFile(@Req() request: any, @Query("mount") mountId = "", @Query("path") filePath = "") {
    return previewInstanceFile({ mountId, path: filePath }, requestPrincipal(request), process.env);
  }

  @Get("files/download")
  async downloadFile(
    @Req() request: any,
    @Query("mount") mountId = "",
    @Query("path") filePath = "",
    @Res() response: any,
  ) {
    const file = await downloadInstanceFile({ mountId, path: filePath }, requestPrincipal(request), process.env);
    response
      .status(200)
      .header("cache-control", "no-store")
      .header("content-type", file.contentType)
      .header("content-length", String(file.size))
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(file.buffer);
  }

  @Post("files/folders")
  @HttpCode(200)
  async createFolder(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createInstanceFolder({
      mountId: String(body.mount || body.mountId || ""),
      path: String(body.path || ""),
      name: String(body.name || ""),
    }, requestPrincipal(request), process.env);
  }

  @Post("files/uploads")
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 5 } }))
  async uploadFiles(@Req() request: any, @UploadedFiles() uploadedFiles: any[] = [], @Body() body: Record<string, unknown> = {}) {
    return uploadInstanceFiles({
      mountId: String(body.mount || body.mountId || ""),
      path: String(body.path || ""),
      files: uploadedFiles,
    }, requestPrincipal(request), process.env);
  }

  @Patch("config")
  async patchConfig(
    @Req() request: any,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) response: any,
  ) {
    assertInstanceControlAccess(request);
    const { expectedGeneration: _expectedGeneration, patch: bodyPatch, ...directPatch } = body;
    const result = await patchLocalInstanceConfig({
      expectedGeneration: expectedGeneration(ifMatch, body),
      patch: bodyPatch && typeof bodyPatch === "object" ? bodyPatch : directPatch,
      actor: requestPrincipal(request),
      requestId: String(request?.headers?.["x-request-id"] || ""),
    }, process.env);
    response?.setHeader?.("etag", `"${result.config.generation}"`);
    return {
      ok: !result.reconciliationError,
      instance: {
        publicRef: result.identity.publicRef || "",
        canonicalPath: result.identity.publicRef ? `/instance/${encodeURIComponent(result.identity.publicRef)}/` : "",
      },
      config: result.config,
      status: result.status,
      ...(result.reconciliationError ? { error: "instance_reconciliation_failed" } : {}),
    };
  }
}
