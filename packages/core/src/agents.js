import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { createThread } from "./threads.js";

export const templates = [
  {
    id: "coding-agent",
    name: "Coding Agent",
    tagline: "Runs a local Codex-backed coding thread with optional WhatsApp and virtual desktop control.",
    connectors: ["codex", "whatsapp", "browsers", "timers"],
    defaultTimer: {
      label: "Daily repo check",
      cadence: "daily",
      time: "09:00",
      prompt:
        "Inspect the configured repository for important changes, blockers, or follow-up work. Summarize the result without making changes unless explicitly asked.",
    },
    systemPrompt:
      "You are a local coding agent. Work inside the configured repository, explain changes clearly, and do not use private credentials or host-specific assumptions.",
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
