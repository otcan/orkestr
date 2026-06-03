import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import { runNextThreadMessage } from "../../../../../packages/core/src/executors.js";
import {
  hardResetThreadRuntime,
  requestThreadInputDelivery,
  resetThreadRuntime,
  safeResetThreadRuntime,
  sleepThread,
  wakeThread,
} from "../../../../../packages/core/src/runtime-leases.js";
import {
  getThread,
  getThreadForPrincipal,
  listThreadMessages,
  updateThread,
} from "../../../../../packages/core/src/threads.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import {
  publicTenantCapabilities,
  scopedCapabilitiesForThread,
} from "../../../../../packages/core/src/tenant-api-agent.js";
import {
  compactCodexAppServerThread,
  interruptCodexAppServerThread,
  rollbackCodexAppServerThread,
  threadUsesCodexAppServer,
} from "../../../../../packages/core/src/codex-app-server.js";
import { codexThreadId, threadRuntimeSummary } from "../../thread-summary.js";
import { httpError } from "../../common/http.js";
import {
  ThreadActionSanitizerService,
  ThreadRuntimeService,
} from "./thread-application.services.js";

@Controller("api/threads")
export class ThreadRuntimeController {
  constructor(
    private readonly threadActionSanitizer: ThreadActionSanitizerService,
    private readonly threadRuntimeService: ThreadRuntimeService,
  ) {}

  private async assertThreadSanitized(action: string, principal: any, thread: any, input: Record<string, unknown> = {}) {
    return this.threadActionSanitizer.assertAllowed(action, principal, thread, input);
  }

  @Get(":threadId/runtime-lite")
  async runtimeLite(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    const messages = await listThreadMessages(thread.id);
    const summary = await threadRuntimeSummary(thread, messages);
    return {
      ...summary,
      orkestrThreadId: thread.id,
      threadId: summary.codexThreadId || codexThreadId(thread) || thread.id,
      codexThreadId: summary.codexThreadId || codexThreadId(thread) || null,
    };
  }

  @Get(":threadId/runtime")
  async runtime(@Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    return { thread, runtime: await this.threadRuntimeService.status(thread.id) };
  }

  @Get(":threadId/capabilities")
  async capabilities(@Req() request: any, @Param("threadId") threadId: string) {
    const principal = requestPrincipal(request);
    const thread = await getThreadForPrincipal(threadId, principal);
    if (!thread) throw httpError("thread_not_found", 404);
    const effective = await scopedCapabilitiesForThread(thread);
    return {
      ok: true,
      thread: {
        id: thread.id,
        name: thread.name || thread.title || "",
        ownerUserId: thread.ownerUserId || thread.userId || "",
        runtimeKind: thread.runtimeKind || thread.executor?.metadata?.runtimeKind || "",
        binding: thread.binding || null,
      },
      capabilities: publicTenantCapabilities(effective),
      raw: {
        skillRegistry: effective.skillRegistry || null,
        scopedConnectors: effective.scopedConnectors || {},
        capabilityDecision: effective.capabilityDecision || null,
        enabledSkills: effective.enabledSkills || [],
        disabledSkills: effective.disabledSkills || [],
      },
    };
  }

  @Post(":threadId/wake")
  @HttpCode(200)
  async wake(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.wake", requestPrincipal(request), thread, body);
    const result = await wakeThread(threadId, { reason: body.reason || "manual_wake" });
    if (!result) throw httpError("thread_wake_failed", 500);
    requestThreadInputDelivery(result.thread.id);
    return result;
  }

  @Post(":threadId/sleep")
  @HttpCode(200)
  async sleep(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.sleep", requestPrincipal(request), thread, body);
    if (threadUsesCodexAppServer(thread)) throw httpError("codex_app_server_sleep_unsupported_use_stop", 409);
    return sleepThread(thread.id, {
      reason: body.reason || "manual_sleep",
      kill: body.kill !== false,
    });
  }

  @Post(":threadId/stop")
  @HttpCode(200)
  async stop(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const target = await getThread(threadId);
    if (!target) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.stop", requestPrincipal(request), target, body);
    const result: any = threadUsesCodexAppServer(target)
      ? { thread: target, slept: 0, interrupted: await interruptCodexAppServerThread(target).catch(() => ({ interrupted: false })) }
      : await sleepThread(threadId, { reason: body.reason || "ui_stop", kill: body.kill !== false });
    return {
      ok: true,
      stopped: true,
      interrupted: Boolean(result.interrupted?.interrupted),
      slept: result.slept,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post(":threadId/reset")
  @HttpCode(200)
  async reset(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.reset", requestPrincipal(request), thread, body);
    const result: any = await resetThreadRuntime(thread.id, { reason: body.reason || "manual_reset" });
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/hard-reset")
  @HttpCode(200)
  async hardReset(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.hard-reset", requestPrincipal(request), thread, body);
    const result: any = await hardResetThreadRuntime(thread.id, { reason: body.reason || "manual_hard_reset" });
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/safe-reset")
  @HttpCode(200)
  async safeReset(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.safe-reset", requestPrincipal(request), thread, body);
    const result: any = await safeResetThreadRuntime(thread.id, { reason: body.reason || "manual_safe_reset" });
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/codex/compact")
  @HttpCode(200)
  async codexCompact(@Req() request: any, @Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.codex-compact", requestPrincipal(request), thread, {});
    if (!threadUsesCodexAppServer(thread)) throw httpError("codex_app_server_required", 409);
    const result = await compactCodexAppServerThread(thread);
    return {
      ok: true,
      compacted: true,
      result,
      thread: await threadRuntimeSummary(await getThread(thread.id) || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/codex/rollback")
  @HttpCode(200)
  async codexRollback(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.codex-rollback", requestPrincipal(request), thread, body);
    if (!threadUsesCodexAppServer(thread)) throw httpError("codex_app_server_required", 409);
    const result = await rollbackCodexAppServerThread(thread, Number(body.numTurns || body.turns || 1) || 1);
    return {
      ok: true,
      result,
      thread: await threadRuntimeSummary(await getThread(thread.id) || thread, await listThreadMessages(thread.id)),
    };
  }

  @Post(":threadId/hibernate")
  @HttpCode(200)
  async hibernate(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.hibernate", requestPrincipal(request), thread, body);
    if (threadUsesCodexAppServer(thread)) throw httpError("codex_app_server_hibernate_unsupported_use_stop", 409);
    return sleepThread(thread.id, {
      reason: body.reason || "hibernate",
      kill: body.force !== false,
    });
  }

  @Post(":threadId/resume")
  @HttpCode(200)
  async resume(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.resume", requestPrincipal(request), thread, body);
    return wakeThread(threadId, { reason: body.reason || body.mode || "resume" });
  }

  @Post(":threadId/recover")
  @HttpCode(200)
  async recover(@Req() request: any, @Param("threadId") threadId: string) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.recover", requestPrincipal(request), thread, {});
    return { ok: true, thread: await updateThread(thread.id, { state: "ready", lastError: null }) };
  }

  @Post(":threadId/run-next")
  @HttpCode(200)
  async runNext(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    const thread = await getThread(threadId);
    if (!thread) throw httpError("thread_not_found", 404);
    await this.assertThreadSanitized("thread.run-next", requestPrincipal(request), thread, body);
    const execution = await runNextThreadMessage(threadId, body);
    const whatsappDelivery = await deliverWhatsAppReplies().catch((error) => ({ error: error.message || String(error) }));
    return { execution, whatsappDelivery };
  }
}
