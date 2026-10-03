import { Module } from "@nestjs/common";
import { BrowsersController } from "./browsers.controller.js";
import { DesktopShareOwnerController } from "./desktop-share-owner.controller.js";

@Module({
  controllers: [BrowsersController, DesktopShareOwnerController],
})
export class BrowsersModule {}
