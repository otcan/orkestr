import { Module } from "@nestjs/common";
import {
  ThreadActionSanitizerService,
  ThreadBindingService,
  ThreadInputService,
  ThreadRepoService,
  ThreadRuntimeService,
  ThreadStandingMissionService,
  ThreadTaskAgentService,
  ThreadWorkerService,
} from "./thread-application.services.js";
import { ThreadTimersController } from "./thread-timers.controller.js";
import { ThreadWorkersController } from "./thread-workers.controller.js";
import { ThreadMessagesController } from "./thread-messages.controller.js";
import { ThreadRuntimeController } from "./thread-runtime.controller.js";
import { ThreadBindingController } from "./thread-binding.controller.js";
import { ThreadsController } from "./threads.controller.js";
import { ThreadTaskAgentsController } from "./thread-task-agents.controller.js";
import { ThreadResourceController } from "./thread-resource.controller.js";
import { ThreadStandingMissionController } from "./thread-standing-mission.controller.js";

@Module({
  controllers: [ThreadsController, ThreadRuntimeController, ThreadBindingController, ThreadWorkersController, ThreadTaskAgentsController, ThreadTimersController, ThreadMessagesController, ThreadResourceController, ThreadStandingMissionController],
  providers: [
    ThreadBindingService,
    ThreadActionSanitizerService,
    ThreadInputService,
    ThreadRepoService,
    ThreadRuntimeService,
    ThreadStandingMissionService,
    ThreadTaskAgentService,
    ThreadWorkerService,
  ],
})
export class ThreadsModule {}
