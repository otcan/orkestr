import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  createAppShare,
  createSharedApp,
  ensureSharedApp,
  listAppShares,
  listSharedApps,
  revokeAppShare,
  runSharedAppAction,
  sharedAppData,
} from "../../../../../packages/core/src/shared-apps.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function assertAdmin(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("shared_app_admin_required", 403);
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
  ) {
    return sharedAppData(instanceId, appSlug, shareToken, { session: request?.orkestrSecuritySession || null });
  }

  @Get("shared-apps/i/:instanceId/a/:appSlug/s/:shareToken/data")
  async data(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Param("appSlug") appSlug: string,
    @Param("shareToken") shareToken: string,
  ) {
    return sharedAppData(instanceId, appSlug, shareToken, { session: request?.orkestrSecuritySession || null });
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
