import { Injectable } from "@nestjs/common";
import {
  createHushVoiceTurn,
  getHushVoiceTurn,
  hushVoiceEventPollIntervalMs,
  listHushVoiceTurnEvents,
} from "../../../../../packages/core/src/hush-voice.js";

@Injectable()
export class MobileVoiceService {
  create(input: Record<string, unknown>) {
    return createHushVoiceTurn(input);
  }

  get(turnId: string, input: Record<string, unknown>) {
    return getHushVoiceTurn(turnId, input);
  }

  events(turnId: string, afterEventId: number, input: Record<string, unknown>) {
    return listHushVoiceTurnEvents(turnId, afterEventId, input);
  }

  pollIntervalMs() {
    return hushVoiceEventPollIntervalMs();
  }
}
