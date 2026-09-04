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
import { listLauncherApps } from "../../../../../packages/core/src/app-launcher.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { publicUrlConfig } from "../../../../../packages/core/src/public-url-config.js";
import { listInstanceAccounts, publicInstanceAccount } from "../../instance-account-switcher.js";
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
  @Get("me/launcher")
  async launcher(@Req() request: any) {
    assertEnabled();
    assertOidcSession(request);
    const principal = requestPrincipal(request);
    const appUrl = String(publicUrlConfig(process.env).appUrl || "").replace(/\/+$/, "");
    const granted = await listPublicAppsForSession({
      principal,
      session: request?.orkestrSecuritySession || null,
    });
    if (!isAdminPrincipal(principal)) {
      return {
        ok: true,
        appUrl,
        workspaces: [],
        apps: granted.apps.map((app: any) => ({
          id: app.id,
          slug: app.slug,
          label: app.title,
          description: app.description,
          type: app.type,
          category: "applications",
          url: app.url || app.path,
          external: false,
          target: "_self",
          tags: [app.role],
        })),
        counts: { total: granted.apps.length },
        generatedAt: new Date().toISOString(),
      };
    }
    const [launcher, accounts] = await Promise.all([
      listLauncherApps({ principal, includeHealth: true }),
      listInstanceAccounts(process.env),
    ]);
    const primaryLabel = String(process.env.ORKESTR_LAUNCHER_PRIMARY_LABEL || "This Orkestr").trim().slice(0, 80) || "This Orkestr";
    const absoluteAppUrl = (value = "") => {
      try { return new URL(value || "/", `${appUrl}/`).toString(); } catch { return appUrl; }
    };
    const launcherAppUrl = (app: any) => {
      const value = String(app?.url || "/");
      if (!value.startsWith("/") || value.startsWith("//")) return absoluteAppUrl(value);
      return `${appUrl}/auth/login?${new URLSearchParams({ return: value }).toString()}`;
    };
    return {
      ok: true,
      appUrl,
      workspaces: [
        ...(appUrl ? [{ id: "primary", displayName: primaryLabel, url: appUrl, current: true }] : []),
        ...accounts.map((account) => ({
          ...publicInstanceAccount(account),
          id: account.publicRef,
          url: absoluteAppUrl(account.canonicalPath),
        })),
      ],
      apps: launcher.apps.map((app: any) => ({
        ...app,
        url: launcherAppUrl(app),
      })),
      counts: launcher.counts,
      generatedAt: launcher.generatedAt,
    };
  }

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
