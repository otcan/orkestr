import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res } from "@nestjs/common";
import { hushMobileDeviceContext } from "../../../../../packages/core/src/hush-voice.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import {
  mobileLiveActivityTokenSchema,
  mobilePushTokenSchema,
  mobileRealtimeCallParamsSchema,
  mobileRealtimeCallSchema,
  mobileRealtimeTurnSchema,
} from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { MobileRealtimeService } from "./mobile-realtime.service.js";

function cursor(value: unknown): number {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw httpError("mobile_realtime_event_id_invalid", 400);
  return parsed;
}

function sseFrame(event: Record<string, unknown>): string {
  return `id: ${event.eventId}\nevent: ${event.type || "progress"}\ndata: ${JSON.stringify(event)}\n\n`;
}

function terminal(status: unknown): boolean {
  return ["ended", "failed"].includes(String(status || "").trim().toLowerCase());
}

@Controller("api/mobile")
export class MobileRealtimeController {
  constructor(private readonly realtime: MobileRealtimeService) {}

  @Get("realtime")
  capability(@Req() request: any) {
    return this.realtime.capability({ device: hushMobileDeviceContext(request) });
  }

  @Post("realtime/calls")
  @HttpCode(200)
  create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobileRealtimeCallSchema, { body });
    return this.realtime.create({
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
      clientCallId: body.clientCallId,
      offerSdp: body.offerSdp,
    });
  }

  @Get("realtime/calls/:callId")
  get(@Req() request: any, @Param("callId") callId: string) {
    validateRequestSchema(mobileRealtimeCallParamsSchema, { params: { callId } });
    return this.realtime.get(callId, {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
    });
  }

  @Post("realtime/calls/:callId/turns")
  @HttpCode(202)
  submitTurn(
    @Req() request: any,
    @Param("callId") callId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    validateRequestSchema(mobileRealtimeTurnSchema, { params: { callId }, body });
    return this.realtime.submitTurn(callId, {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
      clientTurnId: body.clientTurnId,
      text: body.text,
      locale: body.locale,
    });
  }

  @Delete("realtime/calls/:callId")
  end(@Req() request: any, @Param("callId") callId: string) {
    validateRequestSchema(mobileRealtimeCallParamsSchema, { params: { callId } });
    return this.realtime.end(callId, {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
    });
  }

  @Get("realtime/calls/:callId/events")
  stream(@Req() request: any, @Res() response: any, @Param("callId") callId: string) {
    validateRequestSchema(mobileRealtimeCallParamsSchema, { params: { callId } });
    const input = {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
    };
    let afterEventId = cursor(request?.headers?.["last-event-id"]);
    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    let lastHeartbeatAt = Date.now();
    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const writePending = async () => {
      if (closed || response.writableEnded) return;
      try {
        if (!(await this.realtime.deviceActive(input.device))) throw new Error("mobile_device_revoked");
        const current = await this.realtime.get(callId, input);
        const events = await this.realtime.events(callId, afterEventId, input);
        for (const event of events) {
          if (closed || response.writableEnded) return;
          response.write(sseFrame(event));
          afterEventId = Number(event.eventId || afterEventId);
        }
        if (terminal((current as any).status)) {
          close();
          response.end();
          return;
        }
      } catch {
        if (!closed && !response.writableEnded) {
          response.write("event: failed\ndata: {\"error\":{\"code\":\"mobile_realtime_stream_unavailable\",\"retryable\":true,\"message\":\"The call update stream ended. Reconnect to continue.\"}}\n\n");
        }
        close();
        response.end();
        return;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        response.write(": hush realtime keep-alive\n\n");
        lastHeartbeatAt = Date.now();
      }
      if (!closed && !response.writableEnded) timer = setTimeout(() => void writePending(), this.realtime.pollIntervalMs());
    };
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders?.();
    response.write(": hush realtime connected\n\n");
    request.on("close", close);
    request.on("aborted", close);
    void writePending();
  }

  @Put("push-token")
  pushToken(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobilePushTokenSchema, { body });
    return this.realtime.pushToken({
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
      token: body.token,
      environment: body.environment,
      operation: body.operation,
    });
  }

  @Put("live-activity-token")
  liveActivityToken(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobileLiveActivityTokenSchema, { body });
    return this.realtime.liveActivityToken({
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
      activityId: body.activityId,
      token: body.token,
      environment: body.environment,
      operation: body.operation,
    });
  }
}
