import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { createThread } from "./threads.js";

export const templates = [
  {
    id: "job-search-assistant",
    name: "Job Search Assistant",
    tagline: "Checks Gmail and LinkedIn for recruiting messages and sends WhatsApp summaries.",
    connectors: ["gmail", "linkedin", "whatsapp", "browsers", "timers"],
    defaultTimer: {
      label: "Weekday recruiting scan",
      cadence: "daily",
      time: "09:00",
      prompt:
        "Check Gmail and LinkedIn for recruiting/recruiter messages. Summarize anything important and draft replies where useful. Send the summary to WhatsApp.",
    },
    systemPrompt:
      "You are a personal job-search assistant. Use Gmail and LinkedIn through user-owned connectors. Never send messages without explicit approval unless the user configured that behavior.",
  },
];

export async function listAgents(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.agents, []);
}

export async function createAgentFromTemplate(templateId, env = process.env) {
  const template = templates.find((entry) => entry.id === templateId);
  if (!template) {
    const error = new Error("unknown_template");
    error.statusCode = 404;
    throw error;
  }
  const paths = await ensureDataDirs(env);
  const agents = await listAgents(env);
  const existing = agents.find((agent) => agent.templateId === templateId);
  if (existing) return existing;
  const agent = {
    id: templateId,
    templateId,
    name: template.name,
    threadId: templateId,
    state: "draft",
    connectors: template.connectors,
    systemPrompt: template.systemPrompt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  agents.push(agent);
  await writeJson(paths.agents, agents);
  await createThread(
    {
      id: templateId,
      name: template.name,
      title: template.name,
      bindingName: templateId,
      executorId: "",
      state: "ready",
    },
    env,
  );
  await appendEvent({ type: "agent_created", agentId: agent.id, templateId }, env);
  return agent;
}
