import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import {
  approvePairingChallenge,
  createPairingChallenge,
  pairBrowser,
  sessionCookieHeader,
} from "../../../../../packages/core/src/security.js";
import {
  googleWorkspaceReviewEnvironmentIdentity,
  verifyGoogleWorkspaceReviewPassword,
} from "../../../../../packages/connectors/src/google-workspace-review-environment.js";
import { googleWorkspaceReviewLoginPageHtml } from "./google-workspace-review-page.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function reviewerResponseHeaders(response: any) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
}

function requestIp(request: any): string {
  return clean(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress).replace(/^::ffff:/, "");
}

@Controller("review/google")
export class GoogleWorkspaceReviewController {
  @Get()
  entry(@Req() request: any, @Res() response: any) {
    reviewerResponseHeaders(response);
    if (request?.orkestrSecuritySession) return response.redirect(302, "/connectors/gmail");
    return response.status(200).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml());
  }

  @Post("session")
  async createSession(@Body() body: Record<string, unknown> = {}, @Req() request: any, @Res() response: any) {
    reviewerResponseHeaders(response);
    if (!verifyGoogleWorkspaceReviewPassword(clean(body.password), process.env)) {
      return response.status(403).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml({ error: "Unable to sign in." }));
    }
    try {
      const identity = googleWorkspaceReviewEnvironmentIdentity(process.env);
      // This route is enabled only on a disposable reviewer VM. A normal Orkestr
      // installation continues to use browser pairing and cannot use this password.
      const challenge = await createPairingChallenge({
        request,
        userId: identity.userId,
        role: "admin",
        requestedPath: "/connectors/gmail",
      } as any);
      await approvePairingChallenge(challenge.challengeId, { approvedBy: "google_review_password" });
      const paired = await pairBrowser({
        challengeId: challenge.challengeId,
        userAgent: clean(request?.headers?.["user-agent"]),
        ip: requestIp(request),
        allowApproveCode: false,
      } as any);
      response.setHeader("set-cookie", sessionCookieHeader(paired.token, process.env, {
        requestHost: clean(request?.headers?.["x-forwarded-host"] || request?.headers?.host),
        path: "/",
      }));
      return response.redirect(303, "/connectors/gmail");
    } catch {
      return response.status(503).type("text/html; charset=utf-8").send(googleWorkspaceReviewLoginPageHtml({
        error: "Unable to open the reviewer environment. Try again shortly.",
      }));
    }
  }

  @Get("session")
  oldSession(@Res() response: any) {
    reviewerResponseHeaders(response);
    return response.redirect(302, "/review/google");
  }

  @Get(":legacy")
  oldTicket(@Param("legacy") _legacy: string, @Res() response: any) {
    reviewerResponseHeaders(response);
    return response.redirect(302, "/review/google");
  }
}
