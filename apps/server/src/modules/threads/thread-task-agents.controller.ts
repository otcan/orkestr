import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { interruptCodexAppServerThread } from "../../../../../packages/core/src/codex-app-server.js";
import { requestThreadInputDelivery } from "../../../../../packages/core/src/runtime-leases.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { listTaskAgentProfiles } from "../../../../../packages/core/src/task-agent-profiles.js";
import { taskAgentCreateSchema } from "../../../../../packages/shared/src/api-schemas.js";
import { httpError, validateRequestSchema } from "../../common/http.js";
import { ThreadActionSanitizerService, ThreadTaskAgentService } from "./thread-application.services.js";

@Controller("api")
export class ThreadTaskAgentsController {
  constructor(
    private readonly taskAgents: ThreadTaskAgentService,
    private readonly threadActionSanitizer: ThreadActionSanitizerService,
  ) {}

  @Get("task-agent-profiles")
  profiles() {
    return { profiles: listTaskAgentProfiles() };
  }

  @Get("threads/:threadId/task-agents")
  async list(@Req() request: any, @Param("threadId") threadId: string) {
    const principal = requestPrincipal(request);
    const parent = await getThreadForPrincipal(threadId, principal);
    if (!parent) throw httpError("thread_not_found", 404);
    return { taskAgents: await this.taskAgents.list(parent.id) };
  }

  @Post("threads/:threadId/task-agents")
  @HttpCode(201)
  async create(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(taskAgentCreateSchema, { params: { threadId }, body });
    const principal = requestPrincipal(request);
    const parent = await getThreadForPrincipal(threadId, principal);
    if (!parent) throw httpError("thread_not_found", 404);
    await this.threadActionSanitizer.assertAllowed("thread.task-agent.create", principal, parent, body);
    const result: any = await this.taskAgents.create(parent.id, body);
    if (body.autoRun !== false) requestThreadInputDelivery(result.taskAgent.id);
    return { ...result, taskAgent: await this.taskAgents.summary(result.taskAgent) };
  }

  @Get("task-agents/:taskAgentId")
  async status(@Req() request: any, @Param("taskAgentId") taskAgentId: string) {
    const principal = requestPrincipal(request);
    const thread = await getThreadForPrincipal(taskAgentId, principal);
    if (!thread) throw httpError("task_agent_not_found", 404);
    return { taskAgent: await this.taskAgents.summary(thread) };
  }

  @Post("task-agents/:taskAgentId/cancel")
  @HttpCode(200)
  async cancel(@Req() request: any, @Param("taskAgentId") taskAgentId: string) {
    const principal = requestPrincipal(request);
    const thread = await getThreadForPrincipal(taskAgentId, principal);
    if (!thread) throw httpError("task_agent_not_found", 404);
    await this.threadActionSanitizer.assertAllowed("thread.task-agent.cancel", principal, thread, {});
    const taskAgent = await this.taskAgents.cancel(thread.id);
    await interruptCodexAppServerThread(thread).catch(() => null);
    return { taskAgent };
  }
}
