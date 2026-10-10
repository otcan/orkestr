import { Module } from "@nestjs/common";
import { AgentJobsController } from "./agent-jobs.controller.js";
import { JobsController } from "./jobs.controller.js";
import { MailDraftsController } from "./mail-drafts.controller.js";

@Module({
  controllers: [AgentJobsController, JobsController, MailDraftsController],
})
export class JobsModule {}
