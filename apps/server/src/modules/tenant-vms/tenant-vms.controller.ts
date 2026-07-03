import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import {
  createTenantVm,
  deleteTenantVm,
  getTenantVm,
  listTenantVms,
  publicTenantVm,
  setTenantVmStatus,
  setTenantVmTrust,
  updateTenantVm,
} from "../../../../../packages/core/src/tenant-vm-registry.js";
import { provisionTenantVm } from "../../../../../packages/core/src/tenant-vm-provisioning.js";
import { configureTenantWhatsAppRoute, disableTenantWhatsAppRoute, listTenantWhatsAppRoutes } from "../../../../../packages/core/src/tenant-whatsapp-routing.js";
import { rewriteTenantDesktopUrl } from "../../../../../packages/core/src/tenant-desktop-share-routing.js";
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
  if (body.desktops && typeof body.desktops === "object") output.desktops = body.desktops;
  if (body.connectors && typeof body.connectors === "object") output.connectors = body.connectors;
  if (body.trust && typeof body.trust === "object") output.trust = body.trust;
  if (body.capabilities !== undefined) {
    output.capabilities = Array.isArray(body.capabilities) ? body.capabilities : String(body.capabilities || "").split(",");
  }
  if (body.labels && typeof body.labels === "object") output.labels = body.labels;
  if (body.lastError !== undefined || body.error !== undefined) output.lastError = String(body.lastError || body.error || "").trim();
  return output;
}

function tenantVmTrustBody(body: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const key of ["action", "mode", "enrollmentStatus", "trustLevel", "fingerprint", "reviewedBy", "reason", "lastReason"]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
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
    "routeBrokerBaseUrl",
    "controlPlaneBaseUrl",
    "internalBaseUrl",
    "baseUrl",
    "targetBaseUrl",
    "whatsappTargetBaseUrl",
  ]) {
    if (body[key] !== undefined) output[key] = String(body[key] || "").trim();
  }
  if (body.enabled !== undefined) output.enabled = body.enabled;
  if (body.resetToken !== undefined) output.resetToken = body.resetToken;
  for (const key of ["allowPending", "prepareOnly", "stageOnly"]) {
    if (body[key] !== undefined) output[key] = body[key];
  }
  return output;
}

function normalizeProxyBaseUrl(value = "") {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function tenantVmProxyBaseUrl(tenantVm: any) {
  return normalizeProxyBaseUrl(tenantVm?.endpoint?.baseUrl || tenantVm?.endpoint?.brokerBaseUrl || tenantVm?.endpoint?.publicIp || "");
}

function forwardedShareHeaders(request: any) {
  const headers: Record<string, string> = {};
  for (const name of ["accept", "user-agent", "cookie"]) {
    const value = request?.headers?.[name];
    if (value) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

function setUpstreamCookies(response: any, upstream: any) {
  const getSetCookie = (upstream.headers as any).getSetCookie;
  const cookies = typeof getSetCookie === "function"
    ? getSetCookie.call(upstream.headers)
    : [upstream.headers.get("set-cookie")].filter(Boolean);
  if (cookies.length) response.setHeader("set-cookie", cookies);
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

  @Post(":tenantVmId/trust")
  @HttpCode(200)
  async trust(@Req() request: any, @Param("tenantVmId") tenantVmId: string, @Body() body: Record<string, unknown> = {}) {
    assertAdminRequest(request);
    const tenantVm = await setTenantVmTrust(tenantVmId, {
      ...tenantVmTrustBody(body),
      reviewedBy: String(requestPrincipal(request)?.userId || requestPrincipal(request)?.id || body.reviewedBy || "admin"),
    });
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

  @Get(":tenantVmId/desktop-shares/:shareId/open")
  async openTenantDesktopShare(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("tenantVmId") tenantVmId: string,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    return this.proxyTenantDesktopShare(request, response, tenantVmId, shareId, "open", key, subdomain);
  }

  @Get(":tenantVmId/desktop-shares/:shareId/status")
  async tenantDesktopShareStatus(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("tenantVmId") tenantVmId: string,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    return this.proxyTenantDesktopShare(request, response, tenantVmId, shareId, "status", key, subdomain);
  }

  @Delete(":tenantVmId")
  async delete(@Req() request: any, @Param("tenantVmId") tenantVmId: string) {
    assertAdminRequest(request);
    const tenantVm = await deleteTenantVm(tenantVmId);
    return { ok: true, tenantVm: publicTenantVm(tenantVm) };
  }

  private async proxyTenantDesktopShare(
    request: any,
    response: any,
    tenantVmId: string,
    shareId: string,
    action: "open" | "status",
    key = "",
    subdomain = "",
  ) {
    const tenantVm = await getTenantVm(tenantVmId);
    if (!tenantVm || tenantVm.deletedAt || tenantVm.status === "deleted") throw httpError("tenant_vm_not_found", 404);
    const baseUrl = tenantVmProxyBaseUrl(tenantVm);
    if (!baseUrl) throw httpError("tenant_vm_endpoint_unavailable", 503);
    const target = new URL(`/api/desktop-shares/${encodeURIComponent(shareId)}/${action}`, baseUrl);
    target.searchParams.set("key", String(key || ""));
    if (String(subdomain || "").trim()) target.searchParams.set("subdomain", String(subdomain || "").trim());

    let upstream: Response;
    try {
      upstream = await fetch(target, { method: "GET", headers: forwardedShareHeaders(request) });
    } catch (error) {
      throw httpError(`tenant_vm_proxy_failed: ${String((error as Error)?.message || error || "fetch_failed")}`, 502);
    }

    setUpstreamCookies(response, upstream);
    response.status(upstream.status);
    const text = await upstream.text();
    let payload: any = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      response.type(upstream.headers.get("content-type") || "text/plain; charset=utf-8");
      return text;
    }
    if (payload?.desktopUrl) payload.desktopUrl = rewriteTenantDesktopUrl(payload.desktopUrl, tenantVm.id);
    return payload;
  }
}
