import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import {
  beginKeycloakLogin,
  completeKeycloakLogin,
  consumeKeycloakBackchannelLogout,
  keycloakOidcEnabled,
} from "../../../../../packages/core/src/keycloak-oidc.js";
import { oidcSecurityCookieName, sessionCookieHeader } from "../../../../../packages/core/src/security.js";
import { httpError } from "../../common/http.js";

function assertEnabled(): void {
  if (keycloakOidcEnabled(process.env)) return;
  throw httpError("oidc_login_unavailable", 404);
}

function requestHost(request: any): string {
  return String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "");
}

function requestIp(request: any): string {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

@Controller("auth")
export class KeycloakOidcController {
  @Get("login")
  async login(@Query("return") returnTo = "", @Query("idp") idp = "", @Res() response: any) {
    assertEnabled();
    const result = await beginKeycloakLogin({ returnTo, loginHint: idp });
    return response
      .status(302)
      .header("cache-control", "no-store")
      .header("location", result.authorizationUrl)
      .send("Redirecting to sign in.");
  }

  @Get("callback")
  async callback(
    @Req() request: any,
    @Query("code") code = "",
    @Query("state") state = "",
    @Query("error") providerError = "",
    @Res() response: any,
  ) {
    assertEnabled();
    if (String(providerError || "").trim()) throw httpError("oidc_provider_denied", 401);
    const result = await completeKeycloakLogin({
      code,
      state,
      userAgent: String(request?.headers?.["user-agent"] || ""),
      ip: requestIp(request),
    });
    response.setHeader("set-cookie", sessionCookieHeader(result.token, process.env, {
      name: oidcSecurityCookieName(),
      hostOnly: true,
      requestHost: requestHost(request),
    }));
    return response
      .status(302)
      .header("cache-control", "no-store")
      .header("location", result.redirectPath || "/apps")
      .send("Signed in.");
  }

  @Post("backchannel-logout")
  @HttpCode(200)
  async backchannelLogout(@Body() body: Record<string, unknown> = {}) {
    assertEnabled();
    return consumeKeycloakBackchannelLogout({ logoutToken: String(body.logout_token || "") });
  }
}
