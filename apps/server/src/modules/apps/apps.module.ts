import { Module } from "@nestjs/common";
import { AppsController } from "./apps.controller.js";

@Module({
  controllers: [AppsController],
})
export class AppsModule {}
