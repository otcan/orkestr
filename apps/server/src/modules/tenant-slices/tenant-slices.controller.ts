import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  createTenantSlice,
  deleteTenantSlice,
  getTenantSlice,
  listTenantSlices,
  publicTenantSlice,
  setTenantSliceStatus,
  updateTenantSlice,
} from "../../../../../packages/core/src/tenant-slices.js";
import {
  provisionTenantSlice,
  tenantSliceRuntimeStatus,
} from "../../../../../packages/core/src/tenant-slice-provisioning.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("control_plane_admin_required", 403);
}

function listValue(value: unknown): unknown {
  return Array.isArray(value) ? value : String(value || "").split(",");
}

function tenantSliceBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const key of ["id", "tenantSliceId", "ownerUserId", "userId", "displayName", "name", "status", "lastError", "error"]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  for (const key of ["system", "paths", "portBlock", "resources", "budget", "openaiBudget", "connectors", "oxrm", "lifecycle", "labels", "vm", "tenantVm", "controlPlane", "sharedControlPlane"]) {
    if (body[key] && typeof body[key] === "object" && !Array.isArray(body[key])) output[key] = body[key];
  }
  if (body.capabilities !== undefined) output.capabilities = listValue(body.capabilities);
  return output;
}

function provisionBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const key of [
    "imageUrl",
    "storageClass",
    "repoUrl",
    "gitRef",
    "bootstrapUrl",
    "domain",
    "acmeEmail",
    "email",
    "namespace",
    "vmName",
    "tenantVmId",
    "vmId",
    "vmDisplayName",
    "kubeconfig",
    "publicIp",
    "publicIpPorts",
    "ports",
    "channel",
    "baseUrl",
    "url",
    "brokerBaseUrl",
    "whatsappBrokerBaseUrl",
    "routeBrokerBaseUrl",
    "controlPlaneBaseUrl",
    "connectPublicBaseUrl",
    "publicConnectBaseUrl",
    "connectPublicSetupUrl",
    "publicSetupUrl",
    "targetBaseUrl",
    "whatsappTargetBaseUrl",
    "firstThreadName",
    "firstThreadId",
    "tenantBootstrapProfilePath",
    "bootstrapProfilePath",
    "port",
    "orkestrPort",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.execute !== undefined) output.execute = body.execute === true || body.execute === "true";
  if (body.dryRun !== undefined) output.dryRun = body.dryRun !== false && body.dryRun !== "false";
  if (body.sshPublicKeys !== undefined || body.sshKeys !== undefined) {
    const values = body.sshPublicKeys ?? body.sshKeys;
    output.sshPublicKeys = Array.isArray(values) ? values : String(values || "").split("\n");
  }
  if (body.withWhatsapp !== undefined) output.withWhatsapp = body.withWhatsapp === true || body.withWhatsapp === "true";
  if (body.noTailscale !== undefined) output.noTailscale = body.noTailscale !== false && body.noTailscale !== "false";
  for (const key of ["runtimeEnv", "bootstrap", "controlPlane", "sharedControlPlane"]) {
    if (body[key] && typeof body[key] === "object" && !Array.isArray(body[key])) output[key] = body[key];
  }
  if (body.systemdUnitDir !== undefined) output.systemdUnitDir = String(body.systemdUnitDir || "").trim();
  return output;
}

@Controller("api/tenant-slices")
export class TenantSlicesController {
  @Get()
  async list(@Req() request: any) {
    assertAdminRequest(request);
    return {
      tenantSlices: (await listTenantSlices()).map(publicTenantSlice),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantSlice = await createTenantSlice(tenantSliceBody(body));
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Get(":tenantSliceId")
  async get(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string) {
    assertAdminRequest(request);
    const tenantSlice = await getTenantSlice(tenantSliceId);
    if (!tenantSlice) throw httpError("tenant_slice_not_found", 404);
    return { tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Patch(":tenantSliceId")
  async update(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantSlice = await updateTenantSlice(tenantSliceId, tenantSliceBody(body));
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Post(":tenantSliceId/status")
  @HttpCode(200)
  async status(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantSlice = await setTenantSliceStatus(
      tenantSliceId,
      String(body.status || ""),
      { lastError: String(body.lastError || body.error || "").trim(), reason: String(body.reason || "").trim() },
    );
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Get(":tenantSliceId/runtime-status")
  async runtimeStatus(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string) {
    assertAdminRequest(request);
    return tenantSliceRuntimeStatus(tenantSliceId);
  }

  @Post(":tenantSliceId/provision")
  @HttpCode(200)
  async provision(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return provisionTenantSlice(tenantSliceId, provisionBody(body));
  }

  @Post(":tenantSliceId/wake")
  @HttpCode(200)
  async wake(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantSlice = await setTenantSliceStatus(tenantSliceId, "warming", { wakeReason: String(body.reason || "operator") });
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Post(":tenantSliceId/stop")
  @HttpCode(200)
  async stop(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string) {
    assertAdminRequest(request);
    const tenantSlice = await setTenantSliceStatus(tenantSliceId, "stopped");
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }

  @Delete(":tenantSliceId")
  async delete(@Req() request: any, @Param("tenantSliceId") tenantSliceId: string) {
    assertAdminRequest(request);
    const tenantSlice = await deleteTenantSlice(tenantSliceId);
    return { ok: true, tenantSlice: publicTenantSlice(tenantSlice) };
  }
}
