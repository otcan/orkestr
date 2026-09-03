import { Module } from "@nestjs/common";
import { MobileController } from "./mobile.controller.js";

@Module({
  controllers: [MobileController],
})
export class MobileModule {}
