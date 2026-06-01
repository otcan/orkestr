import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import {
  requestThreadInputDelivery,
  requestThreadWake,
} from "../../../../../packages/core/src/runtime-leases.js";
import {
  getThread,
  listThreadMessages,
} from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { threadRuntimeSummary } from "../../thread-summary.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import {
  threadRepoUpdateSchema,
  threadWorkerCreateSchema,
} from "../../../../../packages/shared/src/api-schemas.js";
import {
  ThreadRepoService,
  ThreadRuntimeService,
  ThreadWorkerService,
} from "./thread-application.services.js";
import { assertThreadAdminOnly, threadIsActive } from "./thread-route-helpers.js";

@Controller("api/threads")
export class ThreadWorkersController {
  constructor(
    private readonly threadRepoService: ThreadRepoService,
    private readonly threadRuntimeService: ThreadRuntimeService,
    private readonly threadWorkerService: ThreadWorkerService,
  ) {}

  @Get(":threadId/workers")
  async workers(@Req() request: any, @Param("threadId") threadId: string) {
    assertThreadAdminOnly("thread.workers", requestPrincipal(request));
    const parent = await getThread(threadId);
    if (!parent) throw httpError("thread_not_found", 404);
    const workers = await this.threadWorkerService.list(parent.id);
    return {
      thread: await threadRuntimeSummary(parent, await listThreadMessages(parent.id)),
      workers: await Promise.all(workers.map(async (worker: any) => threadRuntimeSummary(worker, await listThreadMessages(worker.id)))),
    };
  }

  @Post(":threadId/workers")
  @HttpCode(201)
  async createWorker(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadWorkerCreateSchema, { params: { threadId }, body });
    assertThreadAdminOnly("thread.worker.create", requestPrincipal(request));
    const result: any = await this.threadWorkerService.create(threadId, body);
    if (body.wake !== false) {
      if (body.autoRun !== false && result.message) requestThreadInputDelivery(result.worker.id);
      else requestThreadWake(result.worker.id, { reason: "worker_created" });
    }
    return {
      ...result,
      worker: await threadRuntimeSummary(result.worker, await listThreadMessages(result.worker.id)),
    };
  }

  @Put(":threadId/repo")
  async updateRepo(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadRepoUpdateSchema, { params: { threadId }, body });
    assertThreadAdminOnly("thread.repo.update", requestPrincipal(request));
    const result: any = await this.threadRepoService.update(threadId, body);
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/repo/detect")
  @HttpCode(200)
  async detectRepo(@Req() request: any, @Param("threadId") threadId: string) {
    assertThreadAdminOnly("thread.repo.detect", requestPrincipal(request));
    const detected = await this.threadRepoService.detect(threadId);
    const result: any = await this.threadRepoService.update(threadId, detected);
    return {
      ...result,
      detected,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/sync-parent")
  @HttpCode(200)
  async syncParent(@Req() request: any, @Param("threadId") threadId: string) {
    assertThreadAdminOnly("thread.sync-parent", requestPrincipal(request));
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const refreshed: any = await this.threadWorkerService.refreshGitState(thread.id).catch(() => null);
    const currentThread = refreshed?.thread || thread;
    const refreshedParentBehind = Number(refreshed?.gitState?.gitParentBehind ?? NaN);
    if (Number.isFinite(refreshedParentBehind) && refreshedParentBehind <= 0) {
      return {
        synced: false,
        reason: "already_synced",
        gitState: refreshed.gitState,
        thread: await threadRuntimeSummary(currentThread, await listThreadMessages(currentThread.id)),
      };
    }
    const status = await this.threadRuntimeService.status(thread.id).catch(() => null);
    if (threadIsActive(status)) throw httpError("thread_is_active", 409);
    const result: any = await this.threadWorkerService.syncParent(currentThread.id);
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }
}
