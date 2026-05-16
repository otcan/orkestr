import { Module } from "@nestjs/common";
import { ModelsController, SystemController } from "./system.controller.js";

@Module({
  controllers: [SystemController, ModelsController],
})
export class SystemModule {}
