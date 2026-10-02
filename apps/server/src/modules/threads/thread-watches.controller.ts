import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { getThreadForPrincipal, getThreadMessage, listThreadMessageCandidates } from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { cancelThreadWatch, createThreadWatch, listThreadWatches } from "../../../../../packages/core/src/thread-watches.js";
import { runThreadWatchPump } from "../../../../../packages/core/src/thread-watch-pump.js";
import { httpError } from "../../common/http.js";

// `:threadId` is the watcher for create, and either side for list.
@Controller("api/threads")
export class ThreadWatchesController {
  @Get(":threadId/watches")
  async list(@Req() request: any, @Param("threadId") threadId: string, @Query("all") all = "") {
    const principal = requestPrincipal(request);
    const thread = await getThreadForPrincipal(threadId, principal);
    const watches = await listThreadWatches({ threadId: thread.id, principal, includeClosed: all === "1" || all === "true" });
    return { threadId: thread.id, watches };
  }

  @Post(":threadId/watches")
  async create(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const target = String(body.target || body.targetThreadId || "").trim();
    if (!target) throw httpError("thread_watch_target_required", 400);
    const watch = await createThreadWatch({
      watcherThreadId: threadId,
      targetThreadId: target,
      principal: requestPrincipal(request),
      mode: body.mode,
      on: body.on,
      payload: body.payload,
      reply: body.reply,
      wake: body.wake,
      match: body.match,
      expires: body.expires,
    });
    return { watch };
  }

  @Delete(":threadId/watches/:watchId")
  async cancel(@Req() request: any, @Param("threadId") threadId: string, @Param("watchId") watchId: string) {
    const principal = requestPrincipal(request);
    await getThreadForPrincipal(threadId, principal);
    return { watch: await cancelThreadWatch(watchId, { principal }) };
  }

  @Post(":threadId/watches/run")
  @HttpCode(200)
  async run(@Req() request: any, @Param("threadId") threadId: string) {
    await getThreadForPrincipal(threadId, requestPrincipal(request));
    return await runThreadWatchPump();
  }

  // Full text of a watched message (or the latest final answer), for
  // notification-only and truncated watch payloads.
  @Get(":threadId/watch-message")
  async read(@Req() request: any, @Param("threadId") threadId: string, @Query("messageId") messageId = "") {
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    const id = String(messageId || "").trim();
    const message = id
      ? await getThreadMessage(thread.id, id)
      : [...await listThreadMessageCandidates(thread.id, { tailLimit: 200 })].reverse()
        .find((entry: any) => entry?.role === "assistant" && entry?.phase === "final_answer" && entry?.state === "completed") || null;
    if (!message) throw httpError("thread_message_not_found", 404);
    const { id: foundId, role, phase, state, source, createdAt, text, attachments } = message as any;
    return { threadId: thread.id, message: { id: foundId, role, phase, state, source, createdAt, text, attachments: attachments || [] } };
  }
}
