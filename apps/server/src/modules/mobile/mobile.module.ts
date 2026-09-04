import { Module } from "@nestjs/common";
import { MobileVoiceController } from "../mobile-voice/mobile-voice.controller.js";
import { MobileVoiceService } from "../mobile-voice/mobile-voice.service.js";
import { MobileController } from "./mobile.controller.js";

@Module({
  controllers: [MobileController, MobileVoiceController],
  providers: [MobileVoiceService],
})
export class MobileModule {}
