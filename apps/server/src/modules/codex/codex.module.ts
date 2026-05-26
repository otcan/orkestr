import { Module } from "@nestjs/common";
import { CodexController } from "./codex.controller.js";

@Module({
  controllers: [CodexController],
})
export class CodexModule {}

