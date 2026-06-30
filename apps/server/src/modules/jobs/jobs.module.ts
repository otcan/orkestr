import { Module } from "@nestjs/common";
import { JobsController } from "./jobs.controller.js";

@Module({
  controllers: [JobsController],
})
export class JobsModule {}
