import { Module } from "@nestjs/common";
import { BrowsersController } from "./browsers.controller.js";

@Module({
  controllers: [BrowsersController],
})
export class BrowsersModule {}
