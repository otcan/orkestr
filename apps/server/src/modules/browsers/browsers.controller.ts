import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import {
  cleanupVirtualBrowser,
  listBrowserSessions,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  redactDesktopSession,
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
  desktopShareEnforcementPreflight,
  desktopShareFailureResponse,
  desktopShareRenewalHint,
  desktopShareStatus,
  desktopShareSubdomainFromHost,
  listDesktopShares,
  openDesktopShare,
  revokeDesktopShare,
} from "../../../../../packages/core/src/desktop-shares.js";
import { assertDesktopActionSanitized } from "../../../../../packages/core/src/desktop-action-sanitizer.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal, resourceOwnerUserId } from "../../../../../packages/core/src/policy.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import {
  assertDesktopAccess,
  advanceDesktopResourceGeneration,
  backfillThreadDesktopGrants,
  listThreadDesktopGrants,
  setThreadDesktopGrants,
} from "../../../../../packages/core/src/desktop-access.js";
import {
  consumeDesktopCapability,
  desktopCapabilityRequired,
  issueDesktopCapability,
  resolveExactDesktopGrant,
} from "../../../../../packages/browsers/src/desktop-capability-broker.js";
import { httpError } from "../../common/http.js";
import {
  desktopAttemptId,
  desktopOperationWarnings,
  desktopShareNotReadyReason,
  desktopShareReady,
  desktopStoppedLeaseRecoveryOptions,
} from "./desktop-warning-response.js";

@Controller("api")
export class BrowsersController {
  @Get("browsers")
  async browsers(@Req() request: any, @Query("threadId") threadId = "", @Query("inventory") inventory = "", @Query("breakGlass") breakGlass = "", @Query("reason") reason = "", @Query("changeRef") changeRef = "") {
    const principal = requestPrincipal(request);
    const ownerInventory = String(inventory || "").trim() === "owner";
    if (ownerInventory && !isAdminPrincipal(principal)) throw httpError("desktop_owner_inventory_admin_required", 403);
    const payload = await listBrowserSessions(process.env, {
      principal,
      threadId: String(threadId || "").trim(),
      ownerInventory,
      publicProjection: true,
      ...this.breakGlassInputs(principal, { breakGlass, breakGlassReason: reason, breakGlassChangeRef: changeRef }),
    });
    return { ...payload, browsers: payload.sessions };
  }

  @Get("browser-sessions")
  async browserSessions(@Req() request: any, @Query("threadId") threadId = "", @Query("inventory") inventory = "", @Query("breakGlass") breakGlass = "", @Query("reason") reason = "", @Query("changeRef") changeRef = "") {
    const principal = requestPrincipal(request);
    const ownerInventory = String(inventory || "").trim() === "owner";
    if (ownerInventory && !isAdminPrincipal(principal)) throw httpError("desktop_owner_inventory_admin_required", 403);
    return listBrowserSessions(process.env, {
      principal,
      threadId: String(threadId || "").trim(),
      ownerInventory,
      publicProjection: true,
      ...this.breakGlassInputs(principal, { breakGlass, breakGlassReason: reason, breakGlassChangeRef: changeRef }),
    });
  }

  @Get("desktops/leases")
  async desktopLeases(@Req() request: any, @Query("include") include = "", @Query("threadId") threadId = "", @Query("breakGlass") breakGlass = "", @Query("reason") reason = "", @Query("changeRef") changeRef = "") {
    const principal = requestPrincipal(request);
    return {
      ok: true,
      desktopLeases: await publicDesktopLeases({
        includeReleased: include === "released",
        principal,
        threadId: String(threadId || "").trim(),
        ...this.breakGlassInputs(principal, { breakGlass, breakGlassReason: reason, breakGlassChangeRef: changeRef }),
      }),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("desktops/:slug/lease")
  async desktopLease(@Req() request: any, @Param("slug") slug: string, @Query("threadId") threadId = "") {
    const principal = requestPrincipal(request);
    await assertDesktopAccess({ principal, threadId, desktopSlug: slug, permission: "discover" }, process.env);
    return {
      ok: true,
      desktopSlug: normalizeDesktopSlug(slug),
      lease: await activeDesktopLeaseStatus(slug, process.env, { principal, threadId }),
      staleAfterMs: Number(process.env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000),
      generatedAt: new Date().toISOString(),
    };
  }

  @Post("desktops/:slug/acquire")
  @HttpCode(201)
  async acquireDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const ownerUserId = await this.ownerUserIdFromLeaseBody(body, principal);
    const breakGlassOptions = this.breakGlassInputs(principal, body);
    if (desktopCapabilityRequired(process.env, { threadId: String(body.threadId || body.ownerThreadId || "").trim(), desktopSlug: slug }) && !breakGlassOptions.breakGlass) {
      const resolved = await resolveExactDesktopGrant({ principal, threadId: String(body.threadId || body.ownerThreadId || "").trim(), permission: "acquire", scope: "lifecycle", audience: "server-browser-action" }, process.env);
      if (resolved.selection.resource.resourceKey !== normalizeDesktopSlug(slug)) throw httpError("desktop_server_resolved_target_mismatch", 403);
    }
    if (body.force === true && !isAdminPrincipal(principal)) throw httpError("desktop_force_acquire_admin_required", 403);
    await this.assertDesktopSanitized("acquire", principal, slug, { ...body, ownerUserId });
    const attemptId = desktopAttemptId(request, body);
    const threadId = String(body.threadId || body.ownerThreadId || "").trim();
    const recoveryOptions = await desktopStoppedLeaseRecoveryOptions({ slug, threadId, principal });
    const result = await acquireDesktopLease(slug, { ...body, ownerUserId, attemptId }, process.env, { principal, ...breakGlassOptions, ...recoveryOptions });
    if (!result.ok) throw httpError("desktop_leased", 409, { attemptId, warnings: result.warnings, lease: result.lease });
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
    const result = await heartbeatDesktopLease(slug, threadId, process.env, {
      principal,
      ownerUserId,
      fencingToken: String(body.fencingToken || "").trim(),
    });
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("desktops/:slug/release")
  @HttpCode(200)
  async releaseDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const force = body.force === true;
    if (force && !isAdminPrincipal(principal)) throw httpError("lease_not_found", 404);
    const threadId = String(body.threadId || "").trim();
    if (!threadId && !force) throw httpError("threadId_required_unless_force", 400);
    const ownerUserId = threadId ? await this.ownerUserIdFromLeaseBody(body, principal) : String(body.ownerUserId || body.userId || "").trim();
    const result = await releaseDesktopLease(slug, {
      threadId,
      ownerUserId,
      principal,
      force,
      fencingToken: String(body.fencingToken || "").trim(),
      reason: String(body.reason || (force ? "force_released" : "released")).trim(),
    });
    if (!result.ok) throw httpError(result.reason || "lease_not_found", result.reason === "lease_owned_by_other_thread" ? 409 : 404);
    return { ok: true, lease: result.lease };
  }

  @Post("desktops/:slug/share")
  @HttpCode(201)
  async shareDesktop(@Req() request: any, @Param("slug") slug: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const breakGlassOptions = this.breakGlassInputs(principal, body);
    const threadId = String(body.threadId || body.ownerThreadId || "").trim();
    const attemptId = desktopAttemptId(request, body);
    const ownerUserId = threadId ? await this.ownerUserIdFromLeaseBody(body, principal) : String(body.ownerUserId || "").trim();
    if (desktopCapabilityRequired(process.env, { threadId, desktopSlug: slug }) && !breakGlassOptions.breakGlass) {
      const resolved = await resolveExactDesktopGrant({ principal, threadId, permission: "share", scope: "visible_interaction", audience: "desktop-share" }, process.env);
      if (resolved.selection.resource.resourceKey !== normalizeDesktopSlug(slug)) throw httpError("desktop_server_resolved_target_mismatch", 403);
    }
    await this.assertDesktopSanitized("share", principal, slug, body);
    const accessDecision = await assertDesktopAccess({
      principal,
      threadId,
      desktopSlug: slug,
      ownerUserId,
      permission: "share",
      ...breakGlassOptions,
    }, process.env);
    const warnings = await desktopOperationWarnings({ slug, threadId, ownerUserId, operation: "share", attemptId, principal, breakGlassOptions, decision: accessDecision });
    let browser: any = null;
    let startError = "";
    const startRequested = body.start !== false;
    if (startRequested) {
      try {
        browser = await openVirtualBrowser(slug, process.env, "", {
          principal,
          threadId,
          ownerUserId,
          fencingToken: String(body.fencingToken || "").trim(),
          ...breakGlassOptions,
        });
      } catch (error) {
        startError = String((error as Error)?.message || error || "desktop_start_failed");
      }
      if (startError) throw httpError(startError, 503, { attemptId, warnings });
      if (!desktopShareReady(browser)) throw httpError(desktopShareNotReadyReason(browser), 503, { attemptId, warnings });
    }
    const share = await createDesktopShare({
      desktopSlug: slug,
      principal,
      threadId,
      ownerUserId,
      ...breakGlassOptions,
      label: String(browser?.label || body.label || "").trim(),
      env: process.env,
    });
    return {
      ...share,
      attemptId,
      warnings,
      browser: redactDesktopSession(browser),
      desktopStart: {
        requested: startRequested,
        ok: Boolean(browser),
        error: startError,
      },
    };
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
    const shareSubdomain = String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim();
    let result: any;
    try {
      result = await openDesktopShare({
        shareId,
        key,
        browserToken,
        subdomain: shareSubdomain,
        request,
        env: process.env,
      });
    } catch (error) {
      const failure = await this.desktopShareFailure(error, response, shareId, key, shareSubdomain);
      if (failure) return failure;
      throw error;
    }
    response.setHeader("set-cookie", result.cookie.header || desktopShareCookieHeader(result.cookie.value, process.env));
    return result;
  }

  @Get("desktop-shares/:shareId/status")
  async desktopShareStatusRequest(
    @Res({ passthrough: true }) response: any,
    @Req() request: any,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    const shareSubdomain = String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim();
    try {
      return await desktopShareStatus({
        shareId,
        key,
        browserToken: this.desktopShareBrowserToken(request),
        subdomain: shareSubdomain,
        env: process.env,
      });
    } catch (error) {
      const failure = await this.desktopShareFailure(error, response, shareId, key, shareSubdomain);
      if (failure) return failure;
      throw error;
    }
  }

  @Get("desktop-shares")
  async desktopShares(@Req() request: any, @Query("includeTerminal") includeTerminal = "1", @Query("threadId") threadId = "", @Query("desktopSlug") desktopSlug = "") {
    const principal = requestPrincipal(request);
    return listDesktopShares({
      ownerUserId: isAdminPrincipal(principal) ? "" : principal.userId,
      threadId,
      desktopSlug,
      includeTerminal: !["0", "false", "no"].includes(String(includeTerminal || "").toLowerCase()),
      env: process.env,
    });
  }

  @Get("desktop-shares-enforcement-preflight")
  async desktopSharesEnforcementPreflight(@Req() request: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("desktop_share_admin_required", 403);
    return desktopShareEnforcementPreflight(process.env);
  }

  @Post("desktop-shares/:shareId/revoke")
  @HttpCode(200)
  async revokeDesktopShareRequest(@Req() request: any, @Param("shareId") shareId: string, @Body() body: Record<string, unknown> = {}) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("desktop_share_admin_required", 403);
    return revokeDesktopShare(shareId, { reason: String(body.reason || "operator_revoked"), env: process.env });
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

  @Post("threads/:threadId/desktop-capabilities")
  @HttpCode(201)
  async issueDesktopCapability(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return issueDesktopCapability({
      principal,
      threadId,
      fencingToken: String(body.fencingToken || "").trim(),
      audience: "server-browser-action",
      scope: String(body.scope || "lifecycle").trim(),
      ttlMs: body.ttlMs,
    }, process.env);
  }

  @Get("threads/:threadId/desktop-grants")
  async threadDesktopGrants(@Req() request: any, @Param("threadId") threadId: string) {
    return listThreadDesktopGrants(threadId, requestPrincipal(request), process.env);
  }

  @Post("threads/:threadId/desktop-grants")
  @HttpCode(200)
  async replaceThreadDesktopGrants(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const grants = Array.isArray(body.grants)
      ? body.grants
      : Array.isArray(body.desktops)
        ? body.desktops
        : [];
    return setThreadDesktopGrants(threadId, grants, {
      principal,
      reason: String(body.reason || "").trim(),
      source: "api",
    }, process.env);
  }

  @Post("desktop-grants/backfill")
  @HttpCode(200)
  async backfillDesktopGrants(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return backfillThreadDesktopGrants({
      principal: requestPrincipal(request),
      dryRun: body.dryRun !== false,
    }, process.env);
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

  private async desktopShareFailure(error: any, response: any, shareId: string, key: string, subdomain: string) {
    if (String(error?.message || "") === "desktop_share_expired") {
      const renewal = await desktopShareRenewalHint({ shareId, key, subdomain, env: process.env });
      if (!renewal) return null;
      response.status(410);
      return { ok: false, error: "desktop_share_expired", renewal };
    }
    const lifecycle = await desktopShareFailureResponse({ shareId, key, subdomain, env: process.env });
    if (!lifecycle) return null;
    response.status(lifecycle.statusCode);
    return lifecycle;
  }

  private async runAction(request: any, slug: string, action: string, body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const threadId = String(body.threadId || body.ownerThreadId || "").trim();
    const attemptId = desktopAttemptId(request, body);
    let ownerUserId = String(body.ownerUserId || "").trim();
    let breakGlassOptions: any = {};
    let warnings: any[] = [];
    try {
      const normalized = String(action || "").trim().toLowerCase();
      ownerUserId = threadId ? await this.ownerUserIdFromLeaseBody(body, principal) : ownerUserId;
      breakGlassOptions = this.breakGlassInputs(principal, body);
      if (desktopCapabilityRequired(process.env, { threadId, desktopSlug: slug }) && !breakGlassOptions.breakGlass) {
        const consumed = await consumeDesktopCapability({
          capability: String(body.desktopCapability || "").trim(),
          principal,
          desktopSlug: normalizeDesktopSlug(slug),
          threadId,
          audience: "server-browser-action",
          scope: "lifecycle",
        }, process.env);
        if (consumed.desktop?.slug !== normalizeDesktopSlug(slug) || consumed.desktop?.threadId !== threadId) throw httpError("desktop_server_resolved_target_mismatch", 403);
      }
      const desktopOptions = {
        principal,
        threadId,
        ownerUserId,
        fencingToken: String(body.fencingToken || "").trim(),
        ...breakGlassOptions,
      };
      await this.assertDesktopSanitized(normalized || "action", principal, slug, body);
      warnings = await desktopOperationWarnings({ slug, threadId, ownerUserId, operation: normalized, attemptId, principal, breakGlassOptions });
      if (normalized === "prepare") return { browser: redactDesktopSession(await prepareVirtualBrowser(slug, process.env, desktopOptions)), attemptId, warnings };
      if (normalized === "start" || normalized === "open") return { browser: redactDesktopSession(await openVirtualBrowser(slug, process.env, "", desktopOptions)), attemptId, warnings };
      if (normalized === "open-url" || normalized === "openurl" || normalized === "navigate") {
        return { browser: redactDesktopSession(await openUrlInVirtualBrowser(slug, String(body.url || body.href || ""), process.env, desktopOptions)), attemptId, warnings };
      }
      if (normalized === "stop") return { browser: redactDesktopSession(await stopVirtualBrowser(slug, process.env, desktopOptions)), attemptId, warnings };
      if (normalized === "restart") {
        const browser = await restartVirtualBrowser(slug, process.env, desktopOptions);
        await advanceDesktopResourceGeneration(slug, ownerUserId, { reason: "desktop_restarted" }, process.env);
        return { browser: redactDesktopSession(browser), attemptId, warnings };
      }
      if (normalized === "cleanup") {
        const browser = await cleanupVirtualBrowser(slug, process.env, desktopOptions);
        await advanceDesktopResourceGeneration(slug, ownerUserId, { reason: "desktop_cleaned" }, process.env);
        return { browser: redactDesktopSession(browser), attemptId, warnings };
      }
      throw httpError("unknown_browser_action", 404);
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode) {
        const errorCode = String((error as Error)?.message || "browser_action_failed");
        const errorWarnings = await desktopOperationWarnings({ slug, threadId, ownerUserId, operation: action, attemptId, principal, breakGlassOptions, errorCode });
        warnings = [...new Map([...warnings, ...errorWarnings].map((warning) => [warning.code, warning])).values()];
        throw httpError(errorCode, statusCode, { attemptId, warnings });
      }
      throw error;
    }
  }

  private async assertDesktopSanitized(action: string, principal: any, slug: string, input: Record<string, unknown> = {}) {
    return assertDesktopActionSanitized({
      action,
      principal,
      desktopSlug: normalizeDesktopSlug(slug),
      input,
    }, process.env);
  }

  private breakGlassInputs(principal: any, input: Record<string, unknown> = {}) {
    const breakGlass = input.breakGlass === true || ["1", "true", "yes"].includes(String(input.breakGlass || "").toLowerCase());
    return {
      breakGlass,
      breakGlassReason: String(input.breakGlassReason || input.reason || "").trim(),
      breakGlassChangeRef: String(input.breakGlassChangeRef || input.changeRef || input.changeReference || "").trim(),
      // Never trust a query/body timestamp; authentication middleware supplies
      // this only from the verified browser security session.
      recentAuthAt: String(principal?.recentAuthAt || principal?.authenticatedAt || "").trim(),
    };
  }
}
