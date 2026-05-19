import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { listThreadRecords, saveThreadRecords } from "../../storage/src/thread-registry.js";

const runningThreadIds = new Set();
const activeInputStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const whatsappSources = new Set(["whatsapp", "whatsapp_inbound", "whatsapp_client"]);

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function normalizeThreadId(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function messagesPath(threadId, env) {
  const paths = await ensureDataDirs(env);
  return path.join(paths.threadMessages, `${safeThreadId(threadId)}.json`);
}

export async function listThreads(env = process.env) {
  return listThreadRecords(env);
}

export async function getThread(threadId, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  return threads.find((thread) => thread.id === id || thread.name === id || thread.bindingName === id) || null;
}

async function saveThreads(threads, env) {
  return saveThreadRecords(threads, env);
}

export async function createThread(input = {}, env = process.env) {
  const threads = await listThreads(env);
  const requestedId = normalizeThreadId(input.id || input.threadId);
  const name = String(input.name || input.displayName || requestedId || "New Thread").trim();
  const existingByRequestedId = requestedId
    ? threads.find((thread) => thread.id === requestedId || thread.name === requestedId || thread.bindingName === requestedId)
    : null;
  const existingByName = name
    ? threads.find((thread) => thread.name === name || thread.bindingName === name)
    : null;
  const existing = existingByRequestedId || existingByName;
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
    repoRemoteUrl: String(input.repoRemoteUrl || input.remoteUrl || input.gitRemoteUrl || "").trim() || null,
    remoteBranch: String(input.remoteBranch || input.gitRemoteBranch || input.upstreamBranch || "").trim() || null,
    baseBranch: String(input.baseBranch || "").trim() || null,
    branchName: String(input.branchName || "").trim() || null,
    baseCommit: String(input.baseCommit || "").trim() || null,
    gitAhead: optionalNumber(input.gitAhead),
    gitBehind: optionalNumber(input.gitBehind),
    gitParentHead: String(input.gitParentHead || "").trim() || null,
    gitParentAhead: optionalNumber(input.gitParentAhead),
    gitParentBehind: optionalNumber(input.gitParentBehind),
    gitParentChangedFiles: optionalNumber(input.gitParentChangedFiles),
    gitRemoteAhead: optionalNumber(input.gitRemoteAhead),
    gitRemoteBehind: optionalNumber(input.gitRemoteBehind),
    gitRemoteChangedFiles: optionalNumber(input.gitRemoteChangedFiles),
    gitRemoteBranchExists: input.gitRemoteBranchExists === undefined ? null : Boolean(input.gitRemoteBranchExists),
    gitRemoteMissing: input.gitRemoteMissing === undefined ? null : Boolean(input.gitRemoteMissing),
    worktreePath: String(input.worktreePath || "").trim() || null,
    workFolder: String(input.workFolder || input.workdirRelativePath || "").trim() || null,
    workspaceGenerated: input.workspaceGenerated === undefined ? null : Boolean(input.workspaceGenerated),
    workspaceFolderName: String(input.workspaceFolderName || "").trim() || null,
    workspaceSource: String(input.workspaceSource || "").trim() || null,
    localGitInitialized: input.localGitInitialized === undefined ? null : Boolean(input.localGitInitialized),
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

function descendantThreadIds(threads, rootIds) {
  const deleted = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      const parentId = String(thread.parentThreadId || "").trim();
      const rootThreadId = String(thread.rootThreadId || "").trim();
      if (!deleted.has(thread.id) && (deleted.has(parentId) || deleted.has(rootThreadId))) {
        deleted.add(thread.id);
        changed = true;
      }
    }
  }
  return deleted;
}

export async function deleteThread(threadId, options = {}, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  const target = threads.find((thread) => thread.id === id || thread.name === id || thread.bindingName === id);
  if (!target) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const childThreads = threads.filter((thread) => thread.parentThreadId === target.id || thread.rootThreadId === target.id);
  if (childThreads.length && options.deleteWorkers !== true) {
    const error = new Error("thread_has_workers");
    error.statusCode = 409;
    error.workerCount = childThreads.length;
    throw error;
  }
  const deletedIds = descendantThreadIds(threads, [target.id]);
  const next = threads.filter((thread) => !deletedIds.has(thread.id));
  await saveThreads(next, env);
  const paths = await ensureDataDirs(env);
  for (const deletedId of deletedIds) {
    await fs.rm(await messagesPath(deletedId, env), { force: true }).catch(() => {});
    await fs.rm(path.join(paths.home, "uploads", deletedId), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(paths.home, "uploads", safeThreadId(deletedId)), { recursive: true, force: true }).catch(() => {});
    await appendEvent({ type: "thread_deleted", threadId: deletedId, parentThreadId: target.id === deletedId ? null : target.id }, env);
  }
  return {
    ok: true,
    deletedThreads: [...deletedIds],
    deletedCount: deletedIds.size,
  };
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
  await updateThread(thread.id, { state: activeInputStates.has(message.state) ? message.state : thread.state }, env);
  await appendEvent({ type: `thread_message_${message.state}`, threadId: thread.id, messageId: message.id, source: message.source, role: message.role }, env);
  return message;
}

function compactInputText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function whatsappOrigin(input = {}) {
  return String(input.connector || "").trim().toLowerCase() === "whatsapp" ||
    whatsappSources.has(String(input.source || "").trim().toLowerCase());
}

function sameOptionalMessageField(existing, input, key) {
  const left = String(existing?.[key] || "").trim();
  const right = String(input?.[key] || "").trim();
  return !left || !right || left === right;
}

async function activeDuplicateThreadInput(threadId, input, env = process.env) {
  if (!whatsappOrigin(input)) return null;
  const text = compactInputText(input.text);
  const promptFile = String(input.promptFile || "").trim();
  if (!text && !promptFile) return null;
  const messages = await listThreadMessages(threadId, env);
  return [...messages].reverse().find((message) =>
    message.role === "user" &&
    activeInputStates.has(message.state) &&
    whatsappOrigin(message) &&
    compactInputText(message.text) === text &&
    String(message.promptFile || "").trim() === promptFile &&
    sameOptionalMessageField(message, input, "chatId") &&
    sameOptionalMessageField(message, input, "from") &&
    sameOptionalMessageField(message, input, "accountId")
  ) || null;
}

export async function enqueueThreadInput(threadId, input, env = process.env) {
  const duplicate = await activeDuplicateThreadInput(threadId, input, env);
  if (duplicate) {
    await appendEvent({
      type: "thread_input_duplicate_suppressed",
      threadId,
      messageId: duplicate.id,
      source: input.source || "",
      connector: input.connector || "",
    }, env);
    return { ...duplicate, duplicate: true, duplicateReason: "active_input" };
  }
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
