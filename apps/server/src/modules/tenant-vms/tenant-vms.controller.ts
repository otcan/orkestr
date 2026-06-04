import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  createTenantVm,
  deleteTenantVm,
  getTenantVm,
  listTenantVms,
  publicTenantVm,
  setTenantVmStatus,
  updateTenantVm,
} from "../../../../../packages/core/src/tenant-vm-registry.js";
import { provisionTenantVm } from "../../../../../packages/core/src/tenant-vm-provisioning.js";
import { configureTenantWhatsAppRoute, disableTenantWhatsAppRoute, listTenantWhatsAppRoutes } from "../../../../../packages/core/src/tenant-whatsapp-routing.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

function tenantVmBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  if (body.id !== undefined || body.tenantVmId !== undefined) output.id = String(body.id || body.tenantVmId || "").trim();
  if (body.ownerUserId !== undefined || body.userId !== undefined) output.ownerUserId = String(body.ownerUserId || body.userId || "").trim();
  if (body.displayName !== undefined || body.name !== undefined) output.displayName = String(body.displayName || body.name || "").trim();
  if (body.status !== undefined) output.status = String(body.status || "").trim();
  if (body.resources && typeof body.resources === "object") output.resources = body.resources;
  if (body.endpoint && typeof body.endpoint === "object") output.endpoint = body.endpoint;
  if (body.kubevirt && typeof body.kubevirt === "object") output.kubevirt = body.kubevirt;
  if (body.bootstrap && typeof body.bootstrap === "object") output.bootstrap = body.bootstrap;
  if (body.connectors && typeof body.connectors === "object") output.connectors = body.connectors;
  if (body.capabilities !== undefined) {
    output.capabilities = Array.isArray(body.capabilities) ? body.capabilities : String(body.capabilities || "").split(",");
  }
  if (body.labels && typeof body.labels === "object") output.labels = body.labels;
  if (body.lastError !== undefined || body.error !== undefined) output.lastError = String(body.lastError || body.error || "").trim();
  return output;
}

function tenantVmProvisionBody(body: Record<string, unknown> = {}) {
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
    "kubeconfig",
    "publicIp",
    "publicIpPorts",
    "ports",
    "channel",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.sshPublicKeys !== undefined || body.sshKeys !== undefined) {
    const values = body.sshPublicKeys ?? body.sshKeys;
    output.sshPublicKeys = Array.isArray(values) ? values : String(values || "").split("\n");
  }
  if (body.execute !== undefined) output.execute = body.execute === true || body.execute === "true";
  if (body.dryRun !== undefined) output.dryRun = body.dryRun !== false && body.dryRun !== "false";
  if (body.withWhatsapp !== undefined) output.withWhatsapp = body.withWhatsapp === true || body.withWhatsapp === "true";
  if (body.noTailscale !== undefined) output.noTailscale = body.noTailscale !== false && body.noTailscale !== "false";
  return output;
}

function tenantVmWhatsAppRouteBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const key of [
    "chatId",
    "whatsappChatId",
    "waChatId",
    "chatName",
    "displayName",
    "accountId",
    "whatsappAccountId",
    "token",
    "routeMode",
    "whatsappRouteMode",
    "brokerBaseUrl",
    "whatsappBrokerBaseUrl",
    "controlPlaneBaseUrl",
    "internalBaseUrl",
    "baseUrl",
    "targetBaseUrl",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.enabled !== undefined) output.enabled = body.enabled;
  if (body.resetToken !== undefined) output.resetToken = body.resetToken;
  return output;
}

@Controller("api/tenant-vms")
export class TenantVmsController {
  @Get()
  async list(@Req() request: any) {
    assertAdminRequest(request);
    const tenantVms = await listTenantVms();
    const whatsappRoutes = Object.fromEntries((await listTenantWhatsAppRoutes()).map((route) => [route.tenantVmId, route]));
    return {
      tenantVms: tenantVms.map((vm) => ({
        ...publicTenantVm(vm),
        whatsappRoute: whatsappRoutes[vm.id] || null,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantVm = await createTenantVm(tenantVmBody(body));
    return { ok: true, tenantVm: publicTenantVm(tenantVm) };
  }

  @Get(":tenantVmId")
  async get(@Req() request: any, @Param("tenantVmId") tenantVmId: string) {
    assertAdminRequest(request);
    const tenantVm = await getTenantVm(tenantVmId);
    if (!tenantVm) throw httpError("tenant_vm_not_found", 404);
    return { tenantVm: publicTenantVm(tenantVm) };
  }

  @Patch(":tenantVmId")
  async update(@Req() request: any, @Param("tenantVmId") tenantVmId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantVm = await updateTenantVm(tenantVmId, tenantVmBody(body));
    return { ok: true, tenantVm: publicTenantVm(tenantVm) };
  }

  @Post(":tenantVmId/status")
  @HttpCode(200)
  async status(@Req() request: any, @Param("tenantVmId") tenantVmId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantVm = await setTenantVmStatus(
      tenantVmId,
      String(body.status || ""),
      { lastError: String(body.lastError || body.error || "").trim() },
    );
    return { ok: true, tenantVm: publicTenantVm(tenantVm) };
  }

  @Post(":tenantVmId/provision")
  @HttpCode(200)
  async provision(@Req() request: any, @Param("tenantVmId") tenantVmId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return provisionTenantVm(tenantVmId, tenantVmProvisionBody(body));
  }

  @Post(":tenantVmId/whatsapp-route")
  @HttpCode(200)
  async configureWhatsAppRoute(@Req() request: any, @Param("tenantVmId") tenantVmId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    return configureTenantWhatsAppRoute(tenantVmId, tenantVmWhatsAppRouteBody(body));
  }

  @Delete(":tenantVmId/whatsapp-route")
  async disableWhatsAppRoute(@Req() request: any, @Param("tenantVmId") tenantVmId: string) {
    assertAdminRequest(request);
    return disableTenantWhatsAppRoute(tenantVmId);
  }

  @Delete(":tenantVmId")
  async delete(@Req() request: any, @Param("tenantVmId") tenantVmId: string) {
    assertAdminRequest(request);
    const tenantVm = await deleteTenantVm(tenantVmId);
    return { ok: true, tenantVm: publicTenantVm(tenantVm) };
  }
}
