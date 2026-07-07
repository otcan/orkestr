import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { deliverWhatsAppReplies } from "../../../../../packages/connectors/src/whatsapp.js";
import { createAgentFromTemplate, listAgents, templates } from "../../../../../packages/core/src/agents.js";
import {
  listExecutions,
  listExecutorAdapters,
  loadOverlayExecutorAdapters,
  runNextAgentMessage,
} from "../../../../../packages/core/src/executors.js";
import { enqueueAgentMessage, listAgentMessages } from "../../../../../packages/core/src/messages.js";
import { ensureAttachmentsArray } from "../../common/http.js";

@Controller("api")
export class AgentsController {
  @Get("agents/templates")
  templates() {
    return { templates };
  }

  @Post("agents/templates/:templateId")
  async createFromTemplate(@Param("templateId") templateId: string) {
    return { agent: await createAgentFromTemplate(templateId) };
  }

  @Get("agents")
  async listAgents() {
    return { agents: await listAgents() };
  }

  @Get("executors")
  async executors() {
    await loadOverlayExecutorAdapters();
    return { executors: listExecutorAdapters() };
  }

  @Get("executions")
  async executions() {
    return { executions: await listExecutions() };
  }

  @Get("agents/:agentId/messages")
  async messages(@Param("agentId") agentId: string) {
    return { messages: await listAgentMessages(agentId) };
  }

  @Post("agents/:agentId/messages")
  async enqueue(@Param("agentId") agentId: string, @Body() body: Record<string, unknown> = {}) {
    ensureAttachmentsArray(body);
    return { message: await enqueueAgentMessage(agentId, body) };
  }

  @Post("agents/:agentId/run-next")
  @HttpCode(200)
  async runNext(@Param("agentId") agentId: string, @Body() body: Record<string, unknown> = {}) {
    const env = { ...process.env };
    const execution = await runNextAgentMessage(agentId, body, env);
    const whatsappDelivery = await deliverWhatsAppReplies(env).catch((error) => ({ error: error.message || String(error) }));
    return { execution, whatsappDelivery };
  }
}
