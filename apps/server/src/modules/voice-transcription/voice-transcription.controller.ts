import { Controller, Get, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { voiceTranscriptionStatus } from "../../../../../packages/core/src/voice-transcription-status.js";
import { httpError } from "../../common/http.js";

// Voice-note transcription health for `orkestr doctor voice`: settings, key
// presence (never the key), spend against the daily budget and outcome
// counters. Admin only.
@Controller("api/voice-transcription")
export class VoiceTranscriptionController {
  @Get("status")
  async status(@Req() request: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError("forbidden", 403);
    return voiceTranscriptionStatus(process.env);
  }
}
