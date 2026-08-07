import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { backfillExplicitThreadResources } from "../../../../../packages/core/src/thread-resource-backfill.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { consumeApprovedPairingChallengeForAction, createPairingChallenge } from "../../../../../packages/core/src/security.js";
import { httpError } from "../../common/http.js";

const backfillAction = "thread_resource_backfill:oxrm_mailbox";

function approvalChallenge(payload: any) {
  return {
    id: payload.challengeId,
    approve_code: payload.challenge?.approveCode || "",
    status: "pending",
    expires_at: payload.expiresAt,
    approve_command: `orkestr security approve ${payload.challenge?.approveCode || payload.challengeId}`,
  };
}

@Controller("api/thread-resources")
export class ThreadResourceController {
  @Post("backfill")
  @HttpCode(200)
  async backfill(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("thread_resource_backfill_admin_required", 403);
    const dryRun = body.dryRun !== false;
    if (dryRun) return backfillExplicitThreadResources({ principal, dryRun: true }, process.env);

    const authIntent = { action: backfillAction, resourceTypes: "oxrm,mailbox", dryRun: "false" };
    const approval = String(body.approval || "").trim();
    if (approval) {
      await consumeApprovedPairingChallengeForAction(approval, {
        env: process.env,
        action: backfillAction,
        authIntent,
        consumedBy: `api-thread-resource-backfill:${principal.userId || "admin"}`,
      } as any);
    } else {
      const created = await createPairingChallenge({
        request,
        env: process.env,
        userId: String(principal.userId || ""),
        role: "admin",
        requestedPath: "/api/thread-resources/backfill",
        allowedActions: [backfillAction],
        authIntent,
      } as any);
      return { ok: true, status: "approval_required", challenge: approvalChallenge(created) };
    }
    return backfillExplicitThreadResources({ principal, dryRun: false }, process.env);
  }
}
