import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { createTimerForPrincipal, deleteTimerForPrincipal, listTimersForPrincipal } from "../../../../../packages/core/src/timers.js";
import { getThread } from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { timerCreateSchema } from "../../../../../packages/shared/src/api-schemas.js";

@Controller("api/threads")
export class ThreadTimersController {
  @Get(":threadId/timers")
  async timers(@Req() request: any, @Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const timers = (await listTimersForPrincipal(requestPrincipal(request))).filter((timer) => timer.targetType === "thread" && timer.target === thread.id);
    return { thread, timers };
  }

  @Post(":threadId/timers")
  async createTimer(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(timerCreateSchema, { body });
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const timer = await createTimerForPrincipal({ ...body, targetType: "thread", target: thread.id }, requestPrincipal(request));
    return { timer };
  }

  @Delete(":threadId/timers/:timerId")
  async deleteTimer(@Req() request: any, @Param("threadId") threadId: string, @Param("timerId") timerId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { ok: await deleteTimerForPrincipal(timerId, requestPrincipal(request)) };
  }
}
