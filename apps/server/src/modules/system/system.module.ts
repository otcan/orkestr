import { Module } from "@nestjs/common";
import { CodexAuthController } from "./codex-auth.controller.js";
import { InstanceConnectController, PublicController } from "./public.controller.js";
import { ModelsController, SystemController } from "./system.controller.js";

@Module({
  controllers: [CodexAuthController, SystemController, ModelsController, PublicController, InstanceConnectController],
})
export class SystemModule {}
