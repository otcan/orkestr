import { Module } from "@nestjs/common";
import { AutomationsController } from "./automations.controller.js";

@Module({
  controllers: [AutomationsController],
})
export class AutomationsModule {}
