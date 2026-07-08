import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import {
  createAppShare,
  createSharedApp,
  ensureSharedApp,
  listAppShares,
  listSharedApps,
  revokeAppShare,
  resolveSharedAppShare,
  runSharedAppAction,
  sharedAppData,
  sharedAppPersonMessages,
} from "../../../../../packages/core/src/shared-apps.js";
import {
  createPairingChallenge,
  getPairingChallenge,
  pairBrowser,
  securityStatus,
  sessionCookieHeader,
} from "../../../../../packages/core/src/security.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function assertAdmin(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("shared_app_admin_required", 403);
}

function safeDecode(value = ""): string {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function encodeSharedSegment(value = ""): string {
  return encodeURIComponent(String(value || ""));
}

function canonicalSharedAppPath(instanceId: string, appSlug: string, shareToken: string): string {
  return `/i/${encodeSharedSegment(instanceId)}/a/${encodeSharedSegment(appSlug)}/s/${encodeSharedSegment(shareToken)}`;
}

function requestedSharedAppPath(body: Record<string, unknown> = {}, instanceId: string, appSlug: string, shareToken: string): string {
  const canonical = canonicalSharedAppPath(instanceId, appSlug, shareToken);
  const raw = String(body.requestedPath || body.return || body.returnTo || "").trim().slice(0, 1000);
  if (!raw) return canonical;
  try {
    const parsed = new URL(raw, "http://localhost");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length >= 6 &&
      parts[0] === "i" &&
      parts[2] === "a" &&
      parts[4] === "s" &&
      safeDecode(parts[1]) === instanceId &&
      safeDecode(parts[3]) === appSlug &&
      safeDecode(parts[5]) === shareToken
    ) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Fall back to the canonical share path.
  }
  return canonical;
}

function assertChallengeForShare(challenge: any, share: any): void {
  if (String(challenge?.instanceId || "") !== String(share?.instanceId || "")) throw httpError("shared_app_challenge_scope_denied", 403);
  if (String(challenge?.appSlug || "") !== String(share?.appSlug || "")) throw httpError("shared_app_challenge_scope_denied", 403);
  if (String(challenge?.shareId || "") !== String(share?.id || "")) throw httpError("shared_app_challenge_scope_denied", 403);
}

@Controller("api")
export class SharedAppsController {
  @Get("shared-apps")
  async listApps(@Req() request: any) {
    assertAdmin(request);
    return listSharedApps({ principal: requestPrincipal(request) });
  }

  @Post("shared-apps")
  @HttpCode(201)
  async createApp(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertAdmin(request);
    return createSharedApp(body, { principal: requestPrincipal(request) });
  }

  @Post("instances/:instanceId/apps/:appSlug")
  @HttpCode(201)
  async ensureApp(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    assertAdmin(request);
    return ensureSharedApp({ ...body, instanceId, appSlug }, { principal: requestPrincipal(request) });
  }

  @Post("instances/:instanceId/apps/:appSlug/shares")
  @HttpCode(201)
  async createShare(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    assertAdmin(request);
    return createAppShare(instanceId, appSlug, body, { principal: requestPrincipal(request) });
  }

  @Get("instances/:instanceId/apps/:appSlug/shares")
  async listShares(@Req() request: any, @Param("instanceId") instanceId: string, @Param("appSlug") appSlug: string) {
    assertAdmin(request);
    return listAppShares(instanceId, appSlug, { principal: requestPrincipal(request) });
  }

  @Delete("instances/:instanceId/apps/:appSlug/shares/:shareId")
  async revokeShare(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareId") shareId: string,
  ) {
    assertAdmin(request);
    return revokeAppShare(instanceId, appSlug, shareId, { principal: requestPrincipal(request) });
  }

  @Get("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken")
  async resolve(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    return sharedAppData(instanceId, appSlug, shareToken, { session: request?.orkestrSecuritySession || null, query });
  }

  @Post("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/challenge")
  @HttpCode(200)
  async createShareChallenge(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { share } = await resolveSharedAppShare(instanceId, appSlug, shareToken);
    return createPairingChallenge({
      request,
      instanceId: share.instanceId,
      shareId: share.id,
      appSlug: share.appSlug,
      requestedPath: requestedSharedAppPath(body, instanceId, appSlug, shareToken),
      allowedActions: share.allowedActionsJson || [],
      reusePending: true,
    } as any);
  }

  @Get("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/challenges/:challengeId")
  async shareChallengeStatus(
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Param("challengeId") challengeId: string,
  ) {
    const { share } = await resolveSharedAppShare(instanceId, appSlug, shareToken);
    const challenge = await getPairingChallenge(challengeId, { allowApproveCode: false } as any);
    assertChallengeForShare(challenge, share);
    return { ok: true, challenge };
  }

  @Post("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/pair")
  @HttpCode(200)
  async pairShareBrowser(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { share } = await resolveSharedAppShare(instanceId, appSlug, shareToken);
    const challengeId = String(body.challengeId || "");
    const challenge = await getPairingChallenge(challengeId, { allowApproveCode: false } as any);
    assertChallengeForShare(challenge, share);
    const result = await pairBrowser({
      challengeId,
      userAgent: String(request?.headers?.["user-agent"] || ""),
      ip: String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, ""),
      allowApproveCode: false,
    } as any);
    response.setHeader("set-cookie", sessionCookieHeader(result.token, process.env, {
      requestHost: String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || ""),
    }));
    return {
      ok: true,
      session: result.session,
      redirectPath: result.redirectPath || "",
      security: await securityStatus(),
    };
  }

  @Get("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/data")
  async data(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    return sharedAppData(instanceId, appSlug, shareToken, { session: request?.orkestrSecuritySession || null, query });
  }

  @Get("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/people/:personId/messages")
  async messages(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Param("personId") personId: string,
  ) {
    return sharedAppPersonMessages(instanceId, appSlug, shareToken, personId, { session: request?.orkestrSecuritySession || null });
  }

  @Post("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/actions/:action")
  @HttpCode(200)
  async action(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
    @Param("action") action: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return runSharedAppAction(instanceId, appSlug, shareToken, action, body, { session: request?.orkestrSecuritySession || null });
  }
}
