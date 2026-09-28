import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import {
  executorSwitchReplyText,
  normalizeExecutorTarget,
  switchThreadExecutor,
  threadExecutorSummary,
} from "../../../../../packages/core/src/thread-executor-switch.js";
import { threadExecutorUpdateSchema } from "../../../../../packages/shared/src/thread-executor-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { ThreadActionSanitizerService } from "./thread-application.services.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function switchHttpError(error: any) {
  const code = clean(error?.code || error?.message) || "executor_switch_failed";
  const extra: Record<string, unknown> = {};
  for (const key of ["cause", "rolledBack", "retryAfterMs", "hint", "allowedModels"]) {
    if (error?.[key] !== undefined) extra[key] = error[key];
  }
  return httpError(code, Number(error?.statusCode) || 400, extra);
}

// One thread, one active executor. Owners (and admins) read and switch it;
// switching to Claude Code stays admin-only, as for thread creation.
@Controller("api/threads")
export class ThreadExecutorController {
  constructor(private readonly threadActionSanitizer: ThreadActionSanitizerService) {}

  private async accessibleThread(request: any, threadId: string) {
    const principal = requestPrincipal(request);
    let thread: any = null;
    try {
      thread = await getThreadForPrincipal(threadId, principal);
    } catch (error: any) {
      throw httpError(error?.message || "thread_access_denied", error?.statusCode || 403);
    }
    if (!thread) throw httpError("thread_not_found", 404);
    return { principal, thread };
  }

  @Get(":threadId/executor")
  async get(@Req() request: any, @Param("threadId") threadId: string) {
    const { thread } = await this.accessibleThread(request, threadId);
    return { ok: true, executor: threadExecutorSummary(thread) };
  }

  @Put(":threadId/executor")
  async set(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(threadExecutorUpdateSchema, { params: { threadId }, body });
    const { principal, thread } = await this.accessibleThread(request, threadId);
    await this.threadActionSanitizer.assertAllowed("thread.model-settings", principal, thread, { executor: body.executor });
    const target = normalizeExecutorTarget(clean(body.executor));
    if (!target) throw httpError("executor_target_invalid", 400);
    if (target === "claude-code" && !isAdminPrincipal(principal)) throw httpError("claude_code_admin_runtime_required", 403);
    try {
      const result: any = await switchThreadExecutor(thread.id, target, {
        model: clean(body.model),
        effort: clean(body.effort),
        profileId: clean(body.profileId),
        when: clean(body.when),
        reason: clean(body.reason),
        actor: clean(body.actor) === "self" ? "self" : "owner",
        principal,
      });
      return {
        ok: true,
        changed: Boolean(result.changed),
        deferred: Boolean(result.deferred),
        from: result.from,
        to: result.to,
        handoffPath: result.handoffPath || null,
        executor: result.executor,
        replyText: executorSwitchReplyText(result),
      };
    } catch (error: any) {
      throw switchHttpError(error);
    }
  }
}
