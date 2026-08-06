import { Module } from "@nestjs/common";
import { MailboxesController } from "./mailboxes.controller.js";

@Module({
  controllers: [MailboxesController],
})
export class MailboxesModule {}
