import { createAgentFromTemplate, listAgents, templates } from "../../../../packages/core/src/agents.js";
import { listExecutions, listExecutorAdapters, loadOverlayExecutorAdapters, runNextAgentMessage } from "../../../../packages/core/src/executors.js";
import { enqueueAgentMessage, listAgentMessages } from "../../../../packages/core/src/messages.js";
import { deliverWhatsAppReplies } from "../../../../packages/connectors/src/whatsapp.js";
import { json } from "../http.js";

export async function registerAgentRoutes(app) {
  app.get("/api/agents/templates", async (_request, reply) => {
    return json(reply, 200, { templates });
  });

  app.post("/api/agents/templates/:templateId", async (request, reply) => {
    return json(reply, 201, { agent: await createAgentFromTemplate(request.params.templateId) });
  });

  app.get("/api/agents", async (_request, reply) => {
    return json(reply, 200, { agents: await listAgents() });
  });

  app.get("/api/executors", async (_request, reply) => {
    await loadOverlayExecutorAdapters();
    return json(reply, 200, { executors: listExecutorAdapters() });
  });

  app.get("/api/executions", async (_request, reply) => {
    return json(reply, 200, { executions: await listExecutions() });
  });

  app.get("/api/agents/:agentId/messages", async (request, reply) => {
    return json(reply, 200, { messages: await listAgentMessages(request.params.agentId) });
  });

  app.post("/api/agents/:agentId/messages", async (request, reply) => {
    return json(reply, 201, { message: await enqueueAgentMessage(request.params.agentId, request.body || {}) });
  });

  app.post("/api/agents/:agentId/run-next", async (request, reply) => {
    const execution = await runNextAgentMessage(request.params.agentId, request.body || {});
    const whatsappDelivery = await deliverWhatsAppReplies().catch((error) => ({ error: error.message || String(error) }));
    return json(reply, 200, { execution, whatsappDelivery });
  });
}
