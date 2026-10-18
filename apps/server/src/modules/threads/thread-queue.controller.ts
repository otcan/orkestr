import { listThreadWatches, restoreThreadWatch } from "../../../../../packages/core/src/thread-watches.js";
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { consolidateThreadQueue, rollbackThreadQueue, setThreadQueueHold, threadQueueSnapshot } from "../../../../../packages/core/src/thread-queue-control.js";
import { requestThreadInputDelivery } from "../../../../../packages/core/src/runtime-leases.js";
import { httpError } from "../../common/http.js";
import { ThreadActionSanitizerService } from "./thread-application.services.js";

@Controller("api/threads")
export class ThreadQueueController {
  constructor(private readonly sanitizer: ThreadActionSanitizerService) {}
  private async authorize(request: any, id: string, action: string, body: any = {}) {
    const principal = requestPrincipal(request);
    if (!isAdminPrincipal(principal)) throw httpError("queue_operator_required", 403);
    const thread = await getThreadForPrincipal(id, principal);
    if (action !== "inspect") await this.sanitizer.assertAllowed(`thread.queue.${action}`, principal, thread, body);
    return { thread, principal };
  }
  @Get(":threadId/queue")
  async inspect(@Req() request: any, @Param("threadId") id: string) {
    const { thread } = await this.authorize(request, id, "inspect");
    return threadQueueSnapshot(thread.id);
  }
  @Post(":threadId/queue/hold")
  async hold(@Req() request: any, @Param("threadId") id: string, @Body() body: any) {
    const { thread, principal } = await this.authorize(request, id, "hold", body);
    const result = await setThreadQueueHold(thread.id, { paused: body.paused, reason: body.reason, actor: principal.userId });
    if (!body.paused) requestThreadInputDelivery(thread.id);
    return result;
  }
  @Post(":threadId/queue/consolidate")
  async consolidate(@Req() request: any, @Param("threadId") id: string, @Body() body: any) {
    const { thread } = await this.authorize(request, id, "consolidate", body);
    return consolidateThreadQueue(thread.id, body);
  }
  @Post(":threadId/queue/restore-watch")
  async restoreWatch(@Req() request: any, @Param("threadId") id: string, @Body() body: any) {
    const { thread } = await this.authorize(request, id, "restore-watch", body);
    const watches = await listThreadWatches({ threadId: thread.id, includeClosed: true });
    if (!watches.some(w => w.id === body.watchId && w.watcherThreadId === thread.id)) throw httpError("thread_watch_not_found", 404);
    return { watch: await restoreThreadWatch(body.watchId) };
  }
  @Post(":threadId/queue/rollback")
  async rollback(@Req() request: any, @Param("threadId") id: string, @Body() body: any) {
    const { thread } = await this.authorize(request, id, "rollback", body);
    return rollbackThreadQueue(thread.id, body.operationId);
  }
}
