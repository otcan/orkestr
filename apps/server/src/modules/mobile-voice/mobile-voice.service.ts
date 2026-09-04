import { Injectable } from "@nestjs/common";
import {
  createHushVoiceTurn,
  getHushVoiceTurn,
  hushVoiceEventPollIntervalMs,
  listHushVoiceTurnEvents,
} from "../../../../../packages/core/src/hush-voice.js";
import { mobileDeviceContextIsActive } from "../../../../../packages/core/src/mobile-devices.js";

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

  deviceActive(device: Record<string, unknown>) {
    return mobileDeviceContextIsActive(device);
  }

  pollIntervalMs() {
    return hushVoiceEventPollIntervalMs();
  }
}
