import { Module } from "@nestjs/common";
import { CodexAuthController } from "./codex-auth.controller.js";
import { OwnerLoginController } from "./owner-login.controller.js";
import { InstanceConnectController, PublicController } from "./public.controller.js";
import { ModelsController, SystemController } from "./system.controller.js";

@Module({
  controllers: [CodexAuthController, OwnerLoginController, SystemController, ModelsController, PublicController, InstanceConnectController],
})
export class SystemModule {}
