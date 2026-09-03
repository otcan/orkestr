import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { hushMobileDeviceContext } from "../../../../../packages/core/src/hush-voice.js";
import { mobileVoiceTurnParamsSchema, mobileVoiceTurnSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { MobileVoiceService } from "./mobile-voice.service.js";

function lastEventId(value: unknown): number {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw httpError("mobile_voice_event_id_invalid", 400);
  return parsed;
}

function sseFrame(event: Record<string, unknown>): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseStreamFailureFrame(): string {
  // The stream may fail due to a transport, storage, or runtime condition.
  // None of those details are safe to reflect to a mobile device.
  return "event: failed\ndata: {\"error\":{\"code\":\"mobile_voice_stream_unavailable\",\"retryable\":true,\"message\":\"The Hush connection ended. Reconnect to continue.\"}}\n\n";
}

function terminalTurn(event: Record<string, any>): boolean {
  const status = String(event?.turn?.status || "").trim().toLowerCase();
  return status === "final" || status === "failed";
}

@Controller("api/mobile")
export class MobileVoiceController {
  constructor(private readonly mobileVoice: MobileVoiceService) {}

  @Post("voice-turns")
  @HttpCode(202)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobileVoiceTurnSchema, { body });
    return this.mobileVoice.create({
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
      clientTurnId: body.clientTurnId,
      transcript: body.transcript,
      locale: body.locale,
    });
  }

  @Get("voice-turns/:turnId")
  async get(@Req() request: any, @Param("turnId") turnId: string) {
    validateRequestSchema(mobileVoiceTurnParamsSchema, { params: { turnId } });
    return this.mobileVoice.get(turnId, {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
    });
  }

  @Get("voice-turns/:turnId/events")
  async stream(
    @Req() request: any,
    @Res() response: any,
    @Param("turnId") turnId: string,
  ) {
    validateRequestSchema(mobileVoiceTurnParamsSchema, { params: { turnId } });
    const input = {
      device: hushMobileDeviceContext(request),
      principal: requestPrincipal(request),
    };
    let afterEventId = lastEventId(request?.headers?.["last-event-id"]);
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
        const current = await this.mobileVoice.get(turnId, input);
        const events = await this.mobileVoice.events(turnId, afterEventId, input);
        for (const event of events) {
          if (closed || response.writableEnded) return;
          response.write(sseFrame(event));
          afterEventId = Number(event.eventId || afterEventId);
          if (terminalTurn(event)) {
            close();
            response.end();
            return;
          }
        }
        // A reconnect may already have acknowledged the terminal event via
        // Last-Event-ID. There is nothing else to stream in that case.
        if (terminalTurn({ turn: current })) {
          close();
          response.end();
          return;
        }
      } catch {
        if (!closed && !response.writableEnded) {
          response.write(sseStreamFailureFrame());
        }
        close();
        response.end();
        return;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        response.write(": hush keep-alive\n\n");
        lastHeartbeatAt = Date.now();
      }
      if (!closed && !response.writableEnded) timer = setTimeout(() => void writePending(), this.mobileVoice.pollIntervalMs());
    };
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders?.();
    // A comment is harmless to EventSource clients and forces buffered reverse
    // proxies to establish the foreground stream without waiting for a turn.
    response.write(": hush connected\n\n");
    request.on("close", close);
    request.on("aborted", close);
    void writePending();
  }
}
