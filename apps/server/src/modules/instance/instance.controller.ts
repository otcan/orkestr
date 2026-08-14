import { Body, Controller, Get, Headers, HttpCode, Patch, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
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

function assertInstanceControlAccess(request: any): void {
  const principal = requestPrincipal(request);
  const tenantBoundary = Boolean(
    String(process.env.ORKESTR_TENANT_VM_ID || process.env.ORKESTR_TENANT_SLICE_ID || "").trim() ||
    String(process.env.ORKESTR_TENANT_BOUNDARY || "").trim() === "tenant-vm"
  );
  if (isAdminPrincipal(principal) || tenantBoundary) return;
  throw Object.assign(new Error("instance_control_scope_denied"), { statusCode: 403 });
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
  async context() {
    return { ok: true, instance: await getLocalInstanceContext(process.env) };
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
