import { Module } from "@nestjs/common";
import {
  ThreadActionSanitizerService,
  ThreadBindingService,
  ThreadInputService,
  ThreadRepoService,
  ThreadRuntimeService,
  ThreadWorkerService,
} from "./thread-application.services.js";
import { ThreadTimersController } from "./thread-timers.controller.js";
import { ThreadWorkersController } from "./thread-workers.controller.js";
import { ThreadMessagesController } from "./thread-messages.controller.js";
import { ThreadsController } from "./threads.controller.js";

@Module({
  controllers: [ThreadsController, ThreadWorkersController, ThreadTimersController, ThreadMessagesController],
  providers: [
    ThreadBindingService,
    ThreadActionSanitizerService,
    ThreadInputService,
    ThreadRepoService,
    ThreadRuntimeService,
    ThreadWorkerService,
  ],
})
export class ThreadsModule {}
