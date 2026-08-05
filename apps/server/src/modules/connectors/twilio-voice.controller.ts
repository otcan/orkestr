import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import {
  createTwilioVoiceSummaryDraft,
  twilioVoiceIncomingResponse,
  verifyTwilioVoiceWebhookToken,
} from "../../../../../packages/connectors/src/twilio-voice-assistant.js";

function requestOptions(request: any): Record<string, unknown> {
  return {
    headers: request?.headers || {},
    protocol: String(request?.protocol || request?.headers?.["x-forwarded-proto"] || "https"),
    host: String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || ""),
  };
}

function sendTwiMl(response: any, statusCode: number, twiml: string): void {
  response.status(statusCode).type("text/xml; charset=utf-8").send(twiml);
}

@Controller("api/connectors/twilio/voice")
export class TwilioVoiceController {
  @Post(":token/incoming")
  @HttpCode(200)
  async incoming(@Req() request: any, @Res() response: any, @Param("token") token: string, @Body() body: Record<string, unknown> = {}) {
    const result = await twilioVoiceIncomingResponse(token, { ...requestOptions(request), body });
    sendTwiMl(response, result.ok ? 200 : Number(result.statusCode || 503), result.twiml || "");
  }

  @Post(":token/gather")
  @HttpCode(200)
  async gather(@Req() request: any, @Res() response: any, @Param("token") token: string, @Body() body: Record<string, unknown> = {}) {
    const verified = await verifyTwilioVoiceWebhookToken(token, requestOptions(request));
    if (!verified.ok) {
      const denied = await twilioVoiceIncomingResponse(token, requestOptions(request));
      return sendTwiMl(response, Number(verified.statusCode || 403), denied.twiml || "");
    }
    const result = await createTwilioVoiceSummaryDraft(body, {
      ...requestOptions(request),
      ownerUserId: verified.config.ownerUserId,
      webhookToken: verified.config.webhookToken,
      publicBaseUrl: verified.config.publicBaseUrl,
      summaryTo: verified.config.summaryTo,
      assistantLabel: verified.config.assistantLabel,
      language: verified.config.language,
    });
    sendTwiMl(response, result.ok ? 200 : 503, result.twiml || "");
  }
}
