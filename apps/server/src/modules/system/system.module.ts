import { Module } from "@nestjs/common";
import { PublicController } from "./public.controller.js";
import { ModelsController, SystemController } from "./system.controller.js";

@Module({
  controllers: [SystemController, ModelsController, PublicController],
})
export class SystemModule {}
