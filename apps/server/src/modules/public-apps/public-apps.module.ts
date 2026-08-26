import { Module } from "@nestjs/common";
import { PublicAppsController } from "./public-apps.controller.js";

@Module({
  controllers: [PublicAppsController],
})
export class PublicAppsModule {}
