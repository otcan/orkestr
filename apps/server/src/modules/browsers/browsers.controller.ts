import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import {
  cleanupVirtualBrowser,
  listBrowserSessions,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  restartVirtualBrowser,
  stopVirtualBrowser,
} from "../../../../../packages/browsers/src/browsers.js";
import {
  acquireDesktopLease,
  activeDesktopLeaseStatus,
  heartbeatDesktopLease,
  normalizeDesktopSlug,
  publicDesktopLeases,
  releaseDesktopLease,
} from "../../../../../packages/browsers/src/desktop-leases.js";
import {
  createDesktopShare,
  desktopShareCookieHeader,
  desktopShareStatus,
  desktopShareSubdomainFromHost,
  openDesktopShare,
} from "../../../../../packages/core/src/desktop-shares.js";
import { assertSanitizedAction } from "../../../../../packages/core/src/llm-sanitizer.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal, resourceOwnerUserId } from "../../../../../packages/core/src/policy.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { httpError } from "../../common/http.js";

@Controller("api")
export class BrowsersController {
  @Get("browsers")
  async browsers(@Req() request: any) {
    const principal = requestPrincipal(request);
    const payload = await listBrowserSessions(process.env, { principal });
    return { ...payload, browsers: payload.sessions };
  }

  @Get("browser-sessions")
  async browserSessions(@Req() request: any) {
    return listBrowserSessions(process.env, { principal: requestPrincipal(request) });
  }

  @Get("desktops/leases")
  async desktopLeases(@Req() request: any, @Query("include") include = "") {
    const principal = requestPrincipal(request);
    return {
      ok: true,
      desktopLeases: await publicDesktopLeases({ includeReleased: include === "released", principal }),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("desktops/:slug/lease")
  async desktopLease(@Req() request: any, @Param("slug") slug: string) {
    const principal = requestPrincipal(request);
    return {
      ok: true,
      desktopSlug: normalizeDesktopSlug(slug),
      lease: await activeDesktopLeaseStatus(slug, process.env, { principal }),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post("desktops/:slug/acquire")
  @HttpCode(201)
  async acquireDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const ownerUserId = await this.ownerUserIdFromLeaseBody(body, principal);
    await this.assertDesktopSanitized("acquire", principal, slug, { ...body, ownerUserId });
    const result = await acquireDesktopLease(slug, { ...body, ownerUserId }, process.env, { principal });
    if (!result.ok) throw httpError("desktop_leased", 409);
    return result;
  }

  @Post("desktops/:slug/lease")
  @HttpCode(201)
  async leaseDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    return this.acquireDesktop(request, slug, body);
  }

  @Post("desktops/:slug/heartbeat")
  @HttpCode(200)
  async heartbeatDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const threadId = String(body.threadId || "").trim();
    if (!threadId) throw httpError("threadId_required", 400);
    const ownerUserId = await this.ownerUserIdFromLeaseBody(body, principal);
    const result = await heartbeatDesktopLease(slug, threadId, process.env, { principal, ownerUserId });
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("desktops/:slug/release")
  @HttpCode(200)
  async releaseDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const force = body.force === true;
    const threadId = String(body.threadId || "").trim();
    if (!threadId && !force) throw httpError("threadId_required_unless_force", 400);
    const ownerUserId = threadId ? await this.ownerUserIdFromLeaseBody(body, principal) : String(body.ownerUserId || body.userId || "").trim();
    const result = await releaseDesktopLease(slug, {
      threadId,
      ownerUserId,
      principal,
      force,
      reason: String(body.reason || (force ? "force_released" : "released")).trim(),
    });
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("desktops/:slug/share")
  @HttpCode(201)
  async shareDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    await this.assertDesktopSanitized("share", principal, slug, body);
    const browser = body.start === false
      ? null
      : await openVirtualBrowser(slug, process.env, "", { principal }).catch(() => null);
    return createDesktopShare({
      desktopSlug: slug,
      principal,
      label: String(browser?.label || body.label || "").trim(),
      env: process.env,
    });
  }

  @Get("desktop-shares/:shareId/open")
  async openDesktopShareRequest(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    const browserToken = this.desktopShareBrowserToken(request);
    const result = await openDesktopShare({
      shareId,
      key,
      browserToken,
      subdomain: String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim(),
      request,
      env: process.env,
    });
    response.setHeader("set-cookie", result.cookie.header || desktopShareCookieHeader(result.cookie.value, process.env));
    return result;
  }

  @Get("desktop-shares/:shareId/status")
  async desktopShareStatusRequest(
    @Req() request: any,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    return desktopShareStatus({
      shareId,
      key,
      browserToken: this.desktopShareBrowserToken(request),
      subdomain: String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim(),
      env: process.env,
    });
  }

  @Post("browsers/:slug/:action")
  @HttpCode(200)
  async browserAction(@Req() request: any, @Param("slug") slug: string, @Param("action") action: string, @Body() body: Record<string, unknown> = {}) {
    return this.runAction(request, slug, action, body);
  }

  @Post("browser-sessions/:slug/:action")
  @HttpCode(200)
  async browserSessionAction(@Req() request: any, @Param("slug") slug: string, @Param("action") action: string, @Body() body: Record<string, unknown> = {}) {
    return this.runAction(request, slug, action, body);
  }

  private async ownerUserIdFromLeaseBody(body: Record<string, unknown>, principal: any) {
    const threadId = String(body.threadId || body.ownerThreadId || "").trim();
    if (!threadId) return String(body.ownerUserId || body.userId || "").trim();
    const thread = await getThreadForPrincipal(threadId, principal);
    if (!thread) throw httpError("thread_not_found", 404);
    return resourceOwnerUserId(thread);
  }

  private desktopShareBrowserToken(request: any): string {
    const raw = String(request?.headers?.cookie || "");
    const pair = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith("orkestr_desktop_share="));
    const value = pair ? decodeURIComponent(pair.split("=").slice(1).join("=") || "") : "";
    return String(value.split(":")[1] || "").trim();
  }

  private async runAction(request: any, slug: string, action: string, body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    try {
      const normalized = String(action || "").trim().toLowerCase();
      await this.assertDesktopSanitized(normalized || "action", principal, slug, body);
      if (normalized === "prepare") return { browser: await prepareVirtualBrowser(slug, process.env, { principal }) };
      if (normalized === "start" || normalized === "open") return { browser: await openVirtualBrowser(slug, process.env, "", { principal }) };
      if (normalized === "open-url" || normalized === "openurl" || normalized === "navigate") {
        return { browser: await openUrlInVirtualBrowser(slug, String(body.url || body.href || ""), process.env, { principal }) };
      }
      if (normalized === "stop") return { browser: await stopVirtualBrowser(slug, process.env, { principal }) };
      if (normalized === "restart") return { browser: await restartVirtualBrowser(slug, process.env, { principal }) };
      if (normalized === "cleanup") return { browser: await cleanupVirtualBrowser(slug, process.env, { principal }) };
      throw httpError("unknown_browser_action", 404);
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode) throw httpError(String((error as Error)?.message || "browser_action_failed"), statusCode);
      throw error;
    }
  }

  private async assertDesktopSanitized(action: string, principal: any, slug: string, input: Record<string, unknown> = {}) {
    if (isAdminPrincipal(principal)) return null;
    return assertSanitizedAction({
      action: `desktop.${String(action || "action").trim().toLowerCase() || "action"}`,
      principal,
      resource: {
        type: "desktop",
        id: normalizeDesktopSlug(slug),
        ownerUserId: String(principal?.userId || "").trim(),
      },
      input: {
        slug: normalizeDesktopSlug(slug),
        ...input,
      },
    }, process.env);
  }
}
