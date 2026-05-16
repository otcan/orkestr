import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const runningThreadIds = new Set();

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function normalizeThreadId(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function messagesPath(threadId, env) {
  const paths = await ensureDataDirs(env);
  return path.join(paths.threadMessages, `${safeThreadId(threadId)}.json`);
}

export async function listThreads(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.threads, []);
}

export async function getThread(threadId, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  return threads.find((thread) => thread.id === id || thread.name === id || thread.bindingName === id) || null;
}

async function saveThreads(threads, env) {
  const paths = await ensureDataDirs(env);
  await writeJson(paths.threads, threads);
  return threads;
}

export async function createThread(input = {}, env = process.env) {
  const threads = await listThreads(env);
  const requestedId = normalizeThreadId(input.id || input.threadId);
  const name = String(input.name || input.displayName || requestedId || "New Thread").trim();
  const existing = requestedId
    ? threads.find((thread) => thread.id === requestedId || thread.name === requestedId || thread.bindingName === requestedId)
    : threads.find((thread) => thread.name === name);
  if (existing) return existing;

  const thread = {
    id: requestedId || randomUUID(),
    name,
    title: String(input.title || name).trim(),
    state: String(input.state || "sleeping").trim(),
    wakePolicy: String(input.wakePolicy || "wake-on-message").trim(),
    cwd: String(input.cwd || input.projectRoot || input.workspace || "").trim(),
    workspace: String(input.workspace || input.cwd || input.projectRoot || "").trim(),
    command: String(input.cmd || input.command || "").trim(),
    runtime: input.runtime && typeof input.runtime === "object" ? { ...input.runtime } : null,
    executor: {
      id: String(input.executorId || input.executor?.id || "").trim(),
      type: String(input.executor?.type || "generic").trim(),
      codexThreadId: String(input.codexThreadId || input.executor?.codexThreadId || "").trim(),
      metadata: input.executor?.metadata && typeof input.executor.metadata === "object" ? input.executor.metadata : {},
    },
    binding: input.binding && typeof input.binding === "object" ? { ...input.binding } : null,
    bindingName: String(input.bindingName || input.binding?.displayName || "").trim(),
    codexMode: input.codexMode || input.desiredCodexMode || null,
    desiredCodexMode: input.desiredCodexMode || input.codexMode || null,
    codexModel: input.codexModel || input.executor?.metadata?.codexModel || null,
    codexModelProvider: input.codexModelProvider || input.executor?.metadata?.codexModelProvider || null,
    codexReasoningEffort: input.codexReasoningEffort || input.executor?.metadata?.codexReasoningEffort || null,
    codexContextWindow: input.codexContextWindow || input.executor?.metadata?.codexContextWindow || null,
    codexTokenUsage: input.codexTokenUsage || input.executor?.metadata?.codexTokenUsage || null,
    codexRateLimits: input.codexRateLimits || input.executor?.metadata?.codexRateLimits || null,
    parentThreadId: String(input.parentThreadId || "").trim() || null,
    rootThreadId: String(input.rootThreadId || input.parentThreadId || "").trim() || null,
    workerIndex: Number(input.workerIndex || 0) || null,
    workerLabel: String(input.workerLabel || "").trim() || null,
    workerStatus: String(input.workerStatus || "").trim() || null,
    repoPath: String(input.repoPath || input.projectRoot || "").trim() || null,
    baseBranch: String(input.baseBranch || "").trim() || null,
    branchName: String(input.branchName || "").trim() || null,
    baseCommit: String(input.baseCommit || "").trim() || null,
    worktreePath: String(input.worktreePath || "").trim() || null,
    sourceDirty: Boolean(input.sourceDirty),
    forkedFromCodexThreadId: String(input.forkedFromCodexThreadId || "").trim() || null,
    forkedFromMessageCursor: Number(input.forkedFromMessageCursor || 0) || null,
    handoffPrompt: String(input.handoffPrompt || "").trim() || null,
    handoffMessageId: String(input.handoffMessageId || "").trim() || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  threads.push(thread);
  await saveThreads(threads, env);
  await appendEvent({ type: "thread_created", threadId: thread.id, name: thread.name }, env);
  return thread;
}

export async function updateThread(threadId, patch = {}, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  let updated = null;
  const next = threads.map((thread) => {
    if (thread.id !== id && thread.name !== id && thread.bindingName !== id) return thread;
    updated = {
      ...thread,
      ...patch,
      executor: patch.executor ? { ...(thread.executor || {}), ...patch.executor } : thread.executor,
      binding: patch.binding ? { ...(thread.binding || {}), ...patch.binding } : thread.binding,
      updatedAt: nowIso(),
    };
    return updated;
  });
  if (!updated) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  await saveThreads(next, env);
  return updated;
}

export async function listThreadMessages(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  const id = thread?.id || normalizeThreadId(threadId);
  return readJson(await messagesPath(id, env), []);
}

export async function appendThreadMessage(threadId, input, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messages = await listThreadMessages(thread.id, env);
  const cursor =
    Number(input.cursor || 0) ||
    Math.max(0, ...messages.map((message) => Number(message.cursor || 0)).filter(Number.isFinite)) + 1;
  const message = {
    id: randomUUID(),
    role: String(input.role || "assistant"),
    source: String(input.source || "manual"),
    text: String(input.text || "").trim(),
    promptFile: String(input.promptFile || "").trim(),
    parentMessageId: String(input.parentMessageId || "").trim() || null,
    executionId: String(input.executionId || "").trim() || null,
    createdAt: String(input.timestamp || input.createdAt || "").trim() || nowIso(),
    cursor,
    state: String(input.state || "completed"),
  };
  for (const key of ["connector", "externalId", "chatId", "from", "accountId", "phase", "eventId", "deliveryState", "observedVia", "runtimeLeaseId", "deliveredAt", "error"]) {
    const value = String(input[key] || "").trim();
    if (value) message[key] = value;
  }
  if (Array.isArray(input.attachments) && input.attachments.length) {
    message.attachments = input.attachments.map((attachment) => ({ ...attachment }));
  }
  if (!message.text && !message.promptFile) {
    const error = new Error("message_text_required");
    error.statusCode = 400;
    throw error;
  }
  messages.push(message);
  await writeJson(await messagesPath(thread.id, env), messages);
  const activeInputStates = new Set(["queued", "pending_delivery", "running"]);
  await updateThread(thread.id, { state: activeInputStates.has(message.state) ? message.state : thread.state }, env);
  await appendEvent({ type: `thread_message_${message.state}`, threadId: thread.id, messageId: message.id, source: message.source, role: message.role }, env);
  return message;
}

export async function enqueueThreadInput(threadId, input, env = process.env) {
  return appendThreadMessage(threadId, {
    ...input,
    role: "user",
    state: "queued",
  }, env);
}

export async function updateThreadMessage(threadId, messageId, patch, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const filePath = await messagesPath(thread.id, env);
  const messages = await listThreadMessages(thread.id, env);
  let updated = null;
  const next = messages.map((message) => {
    if (message.id !== messageId) return message;
    updated = {
      ...message,
      ...patch,
      updatedAt: nowIso(),
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

export async function nextQueuedThreadMessage(threadId, env = process.env) {
  const messages = await listThreadMessages(threadId, env);
  return messages.find((message) => message.role === "user" && message.state === "queued") || null;
}

export async function withThreadLock(threadId, fn) {
  const id = normalizeThreadId(threadId);
  if (runningThreadIds.has(id)) {
    const error = new Error("thread_already_running");
    error.statusCode = 409;
    throw error;
  }
  runningThreadIds.add(id);
  try {
    return await fn();
  } finally {
    runningThreadIds.delete(id);
  }
}
