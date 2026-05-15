import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { appendAgentMessage, listAgentMessages, updateAgentMessage } from "./messages.js";
import { readOverlay } from "./overlay.js";

const adapters = new Map();
const loadedOverlayModules = new Set();

export function registerExecutorAdapter(adapter) {
  if (!adapter?.id || typeof adapter.run !== "function") {
    throw new Error("invalid_executor_adapter");
  }
  adapters.set(adapter.id, {
    label: adapter.label || adapter.id,
    description: adapter.description || "",
    ...adapter,
  });
}

export function listExecutorAdapters() {
  return [...adapters.values()].map(({ run, ...adapter }) => adapter);
}

export function getExecutorAdapter(id = "noop") {
  return adapters.get(id) || adapters.get("noop");
}

async function registerModuleExports(module, env) {
  if (typeof module.register === "function") {
    await module.register({ registerExecutorAdapter, env });
  }
  if (module.executorAdapter) {
    registerExecutorAdapter(module.executorAdapter);
  }
  if (Array.isArray(module.executorAdapters)) {
    for (const adapter of module.executorAdapters) {
      registerExecutorAdapter(adapter);
    }
  }
}

export async function loadOverlayExecutorAdapters(env = process.env) {
  const overlay = await readOverlay(env);
  const modules = Array.isArray(overlay.executors?.modules) ? overlay.executors.modules : [];
  const loaded = [];
  const failed = [];
  for (const entry of modules) {
    const modulePath = path.resolve(path.dirname(overlay.path), String(entry));
    if (loadedOverlayModules.has(modulePath)) {
      loaded.push(modulePath);
      continue;
    }
    try {
      const module = await import(pathToFileURL(modulePath).href);
      await registerModuleExports(module, env);
      loadedOverlayModules.add(modulePath);
      loaded.push(modulePath);
      await appendEvent({ type: "executor_module_loaded", modulePath }, env);
    } catch (error) {
      failed.push({ modulePath, error: error.message || String(error) });
      await appendEvent({ type: "executor_module_failed", modulePath, error: error.message || String(error) }, env);
    }
  }
  return { loaded, failed };
}

async function executionPath(env) {
  const paths = await ensureDataDirs(env);
  return path.join(paths.home, "executions.json");
}

export async function listExecutions(env = process.env) {
  return readJson(await executionPath(env), []);
}

async function saveExecution(execution, env) {
  const filePath = await executionPath(env);
  const executions = await listExecutions(env);
  const next = executions.filter((item) => item.id !== execution.id);
  next.push(execution);
  await writeJson(filePath, next);
  return execution;
}

export async function defaultExecutorId(env = process.env) {
  const overlay = await readOverlay(env);
  return String(overlay.executors?.default || "noop");
}

export async function runNextAgentMessage(agentId, options = {}, env = process.env) {
  await loadOverlayExecutorAdapters(env);
  const executorId = options.executorId || (await defaultExecutorId(env));
  const adapter = getExecutorAdapter(executorId);
  if (!adapter) {
    const error = new Error("executor_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messages = await listAgentMessages(agentId, env);
  const message = messages.find((entry) => entry.state === "queued");
  if (!message) {
    const error = new Error("no_queued_messages");
    error.statusCode = 404;
    throw error;
  }

  await updateAgentMessage(agentId, message.id, { state: "running", executorId: adapter.id }, env);
  const execution = await saveExecution(
    {
      id: randomUUID(),
      agentId,
      messageId: message.id,
      executorId: adapter.id,
      state: "running",
      startedAt: new Date().toISOString(),
    },
    env,
  );
  await appendEvent({ type: "executor_started", executionId: execution.id, agentId, messageId: message.id, executorId: adapter.id }, env);

  try {
    const result = await adapter.run({ agentId, message, env });
    const finished = {
      ...execution,
      state: "completed",
      finishedAt: new Date().toISOString(),
      result: result || {},
    };
    await updateAgentMessage(agentId, message.id, { state: "completed", result: result || {} }, env);
    const assistant = await appendAgentMessage(
      agentId,
      {
        role: "assistant",
        source: `executor:${adapter.id}`,
        text: String(result?.output || result?.text || "Executor completed without text output."),
        parentMessageId: message.id,
        executionId: execution.id,
        state: "completed",
      },
      env,
    );
    finished.assistantMessageId = assistant.id;
    await saveExecution(finished, env);
    await appendEvent({ type: "executor_completed", executionId: execution.id, agentId, messageId: message.id, executorId: adapter.id }, env);
    return finished;
  } catch (error) {
    const failed = {
      ...execution,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: error.message || String(error),
    };
    await updateAgentMessage(agentId, message.id, { state: "failed", error: failed.error }, env);
    await saveExecution(failed, env);
    await appendEvent({ type: "executor_failed", executionId: execution.id, agentId, messageId: message.id, executorId: adapter.id }, env);
    throw error;
  }
}

registerExecutorAdapter({
  id: "noop",
  label: "No-op executor",
  description: "Marks queued messages as completed without running an external process.",
  async run({ message }) {
    return {
      output: message.promptFile
        ? `No-op executor received prompt file ${message.promptFile}.`
        : `No-op executor received ${message.text.length} characters.`,
    };
  },
});

registerExecutorAdapter({
  id: "codex",
  label: "Codex CLI",
  description: "Generic adapter slot for Codex CLI. Private overlays provide host-specific launch/session behavior.",
  async run() {
    const error = new Error("codex_executor_not_configured");
    error.statusCode = 501;
    throw error;
  },
});
