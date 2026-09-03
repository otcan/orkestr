import { Module } from "@nestjs/common";
import { MobileVoiceController } from "./mobile-voice.controller.js";
import { MobileVoiceService } from "./mobile-voice.service.js";

@Module({
  controllers: [MobileVoiceController],
  providers: [MobileVoiceService],
})
export class MobileVoiceModule {}
