import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
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
import { httpError } from "../../common/http.js";

@Controller("api")
export class BrowsersController {
  @Get("browsers")
  async browsers() {
    const payload = await listBrowserSessions();
    return { ...payload, browsers: payload.sessions };
  }

  @Get("browser-sessions")
  async browserSessions() {
    return listBrowserSessions();
  }

  @Get("desktops/leases")
  async desktopLeases(@Query("include") include = "") {
    return {
      ok: true,
      desktopLeases: await publicDesktopLeases({ includeReleased: include === "released" }),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("desktops/:slug/lease")
  async desktopLease(@Param("slug") slug: string) {
    return {
      ok: true,
      desktopSlug: normalizeDesktopSlug(slug),
      lease: await activeDesktopLeaseStatus(slug),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post("desktops/:slug/acquire")
  @HttpCode(201)
  async acquireDesktop(@Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const result = await acquireDesktopLease(slug, body);
    if (!result.ok) throw httpError("desktop_leased", 409);
    return result;
  }

  @Post("desktops/:slug/lease")
  @HttpCode(201)
  async leaseDesktop(@Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    return this.acquireDesktop(slug, body);
  }

  @Post("desktops/:slug/heartbeat")
  @HttpCode(200)
  async heartbeatDesktop(@Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const threadId = String(body.threadId || "").trim();
    if (!threadId) throw httpError("threadId_required", 400);
    const result = await heartbeatDesktopLease(slug, threadId);
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("desktops/:slug/release")
  @HttpCode(200)
  async releaseDesktop(@Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const force = body.force === true;
    const threadId = String(body.threadId || "").trim();
    if (!threadId && !force) throw httpError("threadId_required_unless_force", 400);
    const result = await releaseDesktopLease(slug, {
      threadId,
      force,
      reason: String(body.reason || (force ? "force_released" : "released")).trim(),
    });
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("browsers/:slug/:action")
  @HttpCode(200)
  async browserAction(@Param("slug") slug: string, @Param("action") action: string, @Body() body: Record<string, unknown> = {}) {
    return this.runAction(slug, action, body);
  }

  @Post("browser-sessions/:slug/:action")
  @HttpCode(200)
  async browserSessionAction(@Param("slug") slug: string, @Param("action") action: string, @Body() body: Record<string, unknown> = {}) {
    return this.runAction(slug, action, body);
  }

  private async runAction(slug: string, action: string, body: Record<string, unknown> = {}) {
    try {
      const normalized = String(action || "").trim().toLowerCase();
      if (normalized === "prepare") return { browser: await prepareVirtualBrowser(slug) };
      if (normalized === "start" || normalized === "open") return { browser: await openVirtualBrowser(slug) };
      if (normalized === "open-url" || normalized === "openurl" || normalized === "navigate") {
        return { browser: await openUrlInVirtualBrowser(slug, String(body.url || body.href || "")) };
      }
      if (normalized === "stop") return { browser: await stopVirtualBrowser(slug) };
      if (normalized === "restart") return { browser: await restartVirtualBrowser(slug) };
      if (normalized === "cleanup") return { browser: await cleanupVirtualBrowser(slug) };
      throw httpError("unknown_browser_action", 404);
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode) throw httpError(String((error as Error)?.message || "browser_action_failed"), statusCode);
      throw error;
    }
  }
}
