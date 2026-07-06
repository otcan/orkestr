import { Module } from "@nestjs/common";
import { SharedAppsController } from "./shared-apps.controller.js";

@Module({
  controllers: [SharedAppsController],
})
export class SharedAppsModule {}
