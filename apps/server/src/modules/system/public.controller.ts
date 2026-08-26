import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { resolveBrokerConnectInstance } from "../../../../../packages/core/src/broker-instance-registry.js";
import { submitWaitlistEntry } from "../../../../../packages/core/src/user-waitlist.js";
import { submitWorkflowLead } from "../../../../../packages/core/src/workflow-leads.js";
import { recordPublicSiteEvent } from "../../../../../packages/core/src/public-site-events.js";
import { httpError } from "../../common/http.js";
import { instanceSetupPairingRedirectPath, normalizeInstanceId } from "../../instance-connect-setup.js";

const waitlistSubmitAttempts = new Map<string, number[]>();
const workflowSubmitAttempts = new Map<string, number[]>();
const analyticsSubmitAttempts = new Map<string, number[]>();

function requestIp(request: any): string {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

function assertSubmitRate(request: any, attemptsByIp: Map<string, number[]>, maximum: number, error: string): void {
  const key = requestIp(request) || "unknown";
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const attempts = (attemptsByIp.get(key) || []).filter((item) => now - item < windowMs);
  attempts.push(now);
  attemptsByIp.set(key, attempts);
  if (attempts.length > maximum) throw httpError(error, 429);
}

@Controller("api/public")
export class PublicController {
  @Post("waitlist")
  @HttpCode(200)
  async submitWaitlist(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertSubmitRate(request, waitlistSubmitAttempts, 8, "waitlist_rate_limited");
    return submitWaitlistEntry({
      ...body,
      sourceIp: requestIp(request),
      userAgent: String(request?.headers?.["user-agent"] || "").trim(),
    });
  }

  @Post("workflow-leads")
  @HttpCode(200)
  async submitWorkflowLead(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertSubmitRate(request, workflowSubmitAttempts, 6, "workflow_submit_rate_limited");
    const result = await submitWorkflowLead(body, process.env);
    return { ...result, schedulingUrl: result.lead?.schedulingUrl };
  }

  @Post("events")
  @HttpCode(202)
  async publicEvent(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertSubmitRate(request, analyticsSubmitAttempts, 80, "public_event_rate_limited");
    return recordPublicSiteEvent(body, process.env);
  }
}

@Controller("i")
export class InstanceConnectController {
  @Get(":instanceId/setup")
  async instanceSetup(
    @Param("instanceId") rawInstanceId: string,
    @Query("return") returnTo = "",
    @Query("connector") connector = "",
    @Res() response: any,
  ) {
    const instanceId = normalizeInstanceId(rawInstanceId);
    if (!instanceId) throw httpError("instance_id_required", 400);
    try {
      await resolveBrokerConnectInstance(instanceId, process.env);
    } catch (error: any) {
      throw httpError(String(error?.message || "broker_instance_unavailable"), Number(error?.statusCode || 404));
    }
    return response
      .status(302)
      .header("cache-control", "no-store")
      .header("location", instanceSetupPairingRedirectPath(instanceId, returnTo, connector))
      .send("Redirecting to Orkestr app access.");
  }
}
