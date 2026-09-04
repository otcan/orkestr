import { Module } from "@nestjs/common";
import { MobileVoiceController } from "../mobile-voice/mobile-voice.controller.js";
import { MobileVoiceService } from "../mobile-voice/mobile-voice.service.js";
import { MobileRealtimeController } from "../mobile-realtime/mobile-realtime.controller.js";
import { MobileRealtimeService } from "../mobile-realtime/mobile-realtime.service.js";
import { MobileController } from "./mobile.controller.js";

@Module({
  controllers: [MobileController, MobileVoiceController, MobileRealtimeController],
  providers: [MobileVoiceService, MobileRealtimeService],
})
export class MobileModule {}
