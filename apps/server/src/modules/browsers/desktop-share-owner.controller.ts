import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { approveDesktopShareAsOwner, verifyDesktopShareOwnerSession } from "../../../../../packages/core/src/desktop-share-owner-approval.js";
import { desktopSharePageOrigin, parseDesktopShareCookie } from "../../../../../packages/core/src/desktop-share-http.js";
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
      subdomain: shareSubdomain(request, subdomain),
      principal: requestPrincipal(request),
      securitySession: request?.orkestrSecuritySession,
      env: process.env,
    });
  }

  // Read-only and approves nothing. A share page on the link host (a host of
  // its own, e.g. connect.<domain>) never receives the app host's session
  // cookie, so it asks here, with a credentialed same-site fetch, whether
  // this browser is signed in as the link's owner. Only then does it continue
  // on the app host, where approve-as-owner above (same-origin POST) opens
  // the desktop without a click. Only the configured link host may read the
  // answer (ORK-793).
  @Get("desktop-shares/:shareId/owner-session")
  async ownerSession(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Param("shareId") shareId: string,
    @Query("key") key = "",
    @Query("subdomain") subdomain = "",
  ) {
    response.vary?.("Origin");
    const pageOrigin = desktopSharePageOrigin(request?.headers?.origin, process.env);
    if (pageOrigin) {
      response.setHeader("access-control-allow-origin", pageOrigin);
      response.setHeader("access-control-allow-credentials", "true");
    }
    await verifyDesktopShareOwnerSession({
      shareId,
      key,
      subdomain: shareSubdomain(request, subdomain),
      principal: requestPrincipal(request),
      securitySession: request?.orkestrSecuritySession,
      env: process.env,
    });
    return { ok: true, owner: true };
  }
}

function shareSubdomain(request: any, subdomain = ""): string {
  return String(subdomain || desktopShareSubdomainFromHost(request?.headers?.host || "", process.env)).trim();
}

// A malformed cookie reads as an empty token (parseDesktopShareCookie never throws).
export function desktopShareBrowserToken(request: any): string {
  return parseDesktopShareCookie(request?.headers?.cookie).token;
}
