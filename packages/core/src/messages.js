import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

function safeAgentId(agentId) {
  return String(agentId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

export async function listAgentMessages(agentId, env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(path.join(paths.messages, `${safeAgentId(agentId)}.json`), []);
}

export async function enqueueAgentMessage(agentId, input, env = process.env) {
  const paths = await ensureDataDirs(env);
  const messages = await listAgentMessages(agentId, env);
  const message = {
    id: randomUUID(),
    role: String(input.role || "user"),
    source: String(input.source || "manual"),
    text: String(input.text || "").trim(),
    promptFile: String(input.promptFile || "").trim(),
    createdAt: new Date().toISOString(),
    state: "queued",
  };
  if (!message.text && !message.promptFile) {
    const error = new Error("message_text_required");
    error.statusCode = 400;
    throw error;
  }
  messages.push(message);
  await writeJson(path.join(paths.messages, `${safeAgentId(agentId)}.json`), messages);
  await appendEvent({ type: "agent_message_queued", agentId, messageId: message.id, source: message.source }, env);
  return message;
}

export async function updateAgentMessage(agentId, messageId, patch, env = process.env) {
  const paths = await ensureDataDirs(env);
  const filePath = path.join(paths.messages, `${safeAgentId(agentId)}.json`);
  const messages = await listAgentMessages(agentId, env);
  let updated = null;
  const next = messages.map((message) => {
    if (message.id !== messageId) return message;
    updated = {
      ...message,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return updated;
  });
  if (!updated) {
    const error = new Error("message_not_found");
    error.statusCode = 404;
    throw error;
  }
  await writeJson(filePath, next);
  return updated;
}
