import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  createPublicApp,
  createPublicAppGrant,
  listPublicApps,
  listPublicAppsForSession,
  publicAppsEnabled,
  resolvePublicAppForSession,
  revokePublicAppGrant,
  updatePublicApp,
} from "../../../../../packages/core/src/public-apps.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { keycloakOidcEnabled } from "../../../../../packages/core/src/keycloak-oidc.js";
import { httpError } from "../../common/http.js";

function assertEnabled(): void {
  if (publicAppsEnabled(process.env) && keycloakOidcEnabled(process.env)) return;
  throw httpError("public_app_gateway_disabled", 404);
}

function assertOidcSession(request: any): void {
  if (request?.orkestrSecuritySession?.authProvider === "oidc") return;
  throw httpError("public_app_not_found", 404);
}

@Controller("api")
export class PublicAppsController {
  @Get("me/apps")
  async mine(@Req() request: any) {
    assertEnabled();
    assertOidcSession(request);
    return listPublicAppsForSession({
      principal: requestPrincipal(request),
      session: request?.orkestrSecuritySession || null,
    });
  }

  @Get("apps/:slug")
  async resolve(@Req() request: any, @Param("slug") slug: string) {
    assertEnabled();
    assertOidcSession(request);
    const resolved = await resolvePublicAppForSession(slug, {
      principal: requestPrincipal(request),
      session: request?.orkestrSecuritySession || null,
    });
    return { ok: true, app: resolved.projection };
  }

  @Get("public-apps")
  async list(@Req() request: any) {
    return listPublicApps({ principal: requestPrincipal(request) });
  }

  @Post("public-apps")
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createPublicApp(body, { principal: requestPrincipal(request) });
  }

  @Patch("public-apps/:appId")
  async update(@Req() request: any, @Param("appId") appId: string, @Body() body: Record<string, unknown> = {}) {
    return updatePublicApp(appId, body, { principal: requestPrincipal(request) });
  }

  @Post("public-apps/:appId/grants")
  @HttpCode(201)
  async createGrant(@Req() request: any, @Param("appId") appId: string, @Body() body: Record<string, unknown> = {}) {
    return createPublicAppGrant(appId, body, { principal: requestPrincipal(request) });
  }

  @Delete("public-apps/:appId/grants/:grantId")
  async revokeGrant(@Req() request: any, @Param("appId") appId: string, @Param("grantId") grantId: string) {
    return revokePublicAppGrant(appId, grantId, { principal: requestPrincipal(request) });
  }
}
