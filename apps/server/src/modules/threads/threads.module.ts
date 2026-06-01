import { Module } from "@nestjs/common";
import {
  ThreadBindingService,
  ThreadInputService,
  ThreadRepoService,
  ThreadRuntimeService,
  ThreadWorkerService,
} from "./thread-application.services.js";
import { ThreadTimersController } from "./thread-timers.controller.js";
import { ThreadWorkersController } from "./thread-workers.controller.js";
import { ThreadsController } from "./threads.controller.js";

@Module({
  controllers: [ThreadsController, ThreadWorkersController, ThreadTimersController],
  providers: [
    ThreadBindingService,
    ThreadInputService,
    ThreadRepoService,
    ThreadRuntimeService,
    ThreadWorkerService,
  ],
})
export class ThreadsModule {}
