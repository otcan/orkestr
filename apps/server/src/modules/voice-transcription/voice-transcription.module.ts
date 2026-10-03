import { Module } from "@nestjs/common";
import { VoiceTranscriptionController } from "./voice-transcription.controller.js";

@Module({
  controllers: [VoiceTranscriptionController],
})
export class VoiceTranscriptionModule {}
