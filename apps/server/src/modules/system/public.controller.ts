import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { submitWaitlistEntry } from "../../../../../packages/core/src/user-waitlist.js";
import { httpError } from "../../common/http.js";

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
