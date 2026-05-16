import { Module } from "@nestjs/common";
import { SystemController } from "./system.controller.js";

@Module({
  controllers: [SystemController],
})
export class SystemModule {}
