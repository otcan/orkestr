import { Controller, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { approveDesktopShareAsOwner } from "../../../../../packages/core/src/desktop-share-owner-approval.js";
import { parseDesktopShareCookie } from "../../../../../packages/core/src/desktop-share-http.js";
import { desktopShareSubdomainFromHost } from "../../../../../packages/core/src/desktop-shares.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { sameOriginFormPost } from "../../browser-page-security.js";
import { effectiveRequestOrigin } from "../../host-boundaries.js";
import { httpError } from "../../common/http.js";

// The desktop share page calls this when it is opened in a browser signed in
// to Orkestr: the owner's session approves the page's own pending attempt, so
// the owner never has to copy a challenge into chat (see
// packages/core/src/desktop-share-owner-approval.js). Anyone else keeps the
// chat approval flow.
@Controller("api")
export class DesktopShareOwnerController {
  @Post("desktop-shares/:shareId/approve-as-owner")
  @HttpCode(200)
  async approveAsOwner(@Req() request: any, @Param("shareId") shareId: string, @Query("key") key = "", @Query("subdomain") subdomain = "") {
    if (!sameOriginFormPost(request, [effectiveRequestOrigin(request)])) throw httpError("desktop_share_origin_invalid", 403);
    return approveDesktopShareAsOwner({
      shareId,
      key,
      browserToken: desktopShareBrowserToken(request),
      subdomain: String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim(),
      principal: requestPrincipal(request),
      securitySession: request?.orkestrSecuritySession,
      env: process.env,
    });
  }
}

// A malformed cookie reads as an empty token (parseDesktopShareCookie never throws).
export function desktopShareBrowserToken(request: any): string {
  return parseDesktopShareCookie(request?.headers?.cookie).token;
}
