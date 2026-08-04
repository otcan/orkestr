import { Module } from "@nestjs/common";
import { JobsController } from "./jobs.controller.js";
import { MailDraftsController } from "./mail-drafts.controller.js";

@Module({
  controllers: [JobsController, MailDraftsController],
})
export class JobsModule {}
