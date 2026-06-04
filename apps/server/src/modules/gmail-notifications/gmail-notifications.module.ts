import { Module } from "@nestjs/common";
import { GmailNotificationsController } from "./gmail-notifications.controller.js";

@Module({
  controllers: [GmailNotificationsController],
})
export class GmailNotificationsModule {}
