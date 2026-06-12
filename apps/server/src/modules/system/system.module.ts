import { Module } from "@nestjs/common";
import { InstanceConnectController, PublicController } from "./public.controller.js";
import { ModelsController, SystemController } from "./system.controller.js";

@Module({
  controllers: [SystemController, ModelsController, PublicController, InstanceConnectController],
})
export class SystemModule {}
