import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { resolveBrokerConnectInstance } from "../../../../../packages/core/src/broker-instance-registry.js";
import { submitWaitlistEntry } from "../../../../../packages/core/src/user-waitlist.js";
import { httpError } from "../../common/http.js";
import { instanceSetupPairingRedirectPath, normalizeInstanceId } from "../../instance-connect-setup.js";

const waitlistSubmitAttempts = new Map<string, number[]>();

function requestIp(request: any): string {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

function assertWaitlistSubmitRate(request: any): void {
  const key = requestIp(request) || "unknown";
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const attempts = (waitlistSubmitAttempts.get(key) || []).filter((item) => now - item < windowMs);
  attempts.push(now);
  waitlistSubmitAttempts.set(key, attempts);
  if (attempts.length > 8) throw httpError("waitlist_rate_limited", 429);
}

@Controller("api/public")
export class PublicController {
  @Post("waitlist")
  @HttpCode(200)
  async submitWaitlist(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertWaitlistSubmitRate(request);
    return submitWaitlistEntry({
      ...body,
      sourceIp: requestIp(request),
      userAgent: String(request?.headers?.["user-agent"] || "").trim(),
    });
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
