import { Module } from "@nestjs/common";
import { ThreadsController } from "./threads.controller.js";

@Module({
  controllers: [ThreadsController],
})
export class ThreadsModule {}
