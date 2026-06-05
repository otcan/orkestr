import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { createThreadMessageRepository, createThreadRepository } from "../../storage/src/repositories.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { normalizeNoReplyAssistantMessage } from "./no-reply.js";
import { assertResourceAccess, assertThreadLimit, filterResourcesForPrincipal, isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { resolveThreadAttachments } from "./thread-attachments.js";
import { userScopedCapabilityHints } from "./user-skills.js";
import { adminUserId, getUser, normalizeUserId } from "./users.js";

const runningThreadIds = new Set();
const messageMutationQueues = new Map();
const activeInputStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const whatsappSources = new Set(["whatsapp", "whatsapp_inbound", "whatsapp_client"]);
const messageStringFields = [
  "connector",
  "externalId",
  "chatId",
  "from",
  "accountId",
  "phase",
  "eventId",
  "sourceEventId",
  "routerTraceId",
  "turnId",
  "outboxId",
  "deliveryState",
  "observedVia",
  "runtimeLeaseId",
  "deliveredAt",
  "error",
  "visibility",
  "silentReason",
  "originSurface",
  "originTransport",
  "executorKind",
  "executorTransport",
  "executorThreadId",
  "executorTurnId",
  "executorItemId",
  "executorRequestId",
  "codexThreadId",
  "codexTurnId",
  "codexItemId",
  "codexRequestId",
  "codexModel",
  "codexReasoningEffort",
  "codexModeLive",
  "remoteBackend",
  "remoteThreadId",
  "remoteMessageId",
  "remoteParentMessageId",
  "remoteRoutedAt",
  "remoteSyncedAt",
  "publicThreadId",
  "publicMessageId",
  "forwardedBy",
];

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

function visibleMessageMutationFields(patch = {}) {
  return ["text", "attachments", "deletedAt"]
    .filter((key) => Object.prototype.hasOwnProperty.call(patch || {}, key));
}

function restrictedCodexApprovalPolicy(input = {}) {
  const requested = String(input.codexApprovalPolicy || input.executor?.metadata?.codexApprovalPolicy || "on-request").trim() || "on-request";
  return requested === "never" ? "on-request" : requested;
}

function restrictedCodexSecurityProfile(input = {}) {
  const requested = String(input.securityProfile || input.executor?.metadata?.securityProfile || "").trim();
  if (["demo-isolated", "quarantined-demo", "external-user", "private-user", "generated-whatsapp"].includes(requested.toLowerCase())) return requested;
  return "external-user";
}

async function enqueueMessageMutation(filePath, operation) {
  const previous = messageMutationQueues.get(filePath) || Promise.resolve();
  const next = previous.then(operation, operation);
  messageMutationQueues.set(filePath, next.finally(() => {
    if (messageMutationQueues.get(filePath) === next) messageMutationQueues.delete(filePath);
  }));
  return next;
}

export async function listThreads(env = process.env) {
  return createThreadRepository(env).list();
}

export async function listThreadsForPrincipal(principal, env = process.env) {
  return filterResourcesForPrincipal(await listThreads(env), principal, env);
}

export async function getThread(threadId, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  return threads.find((thread) => thread.id === id) ||
    threads.find((thread) => thread.name === id) ||
    threads.find((thread) => thread.bindingName === id) ||
    null;
}

export async function getThreadForPrincipal(threadId, principal, env = process.env) {
  const id = normalizeThreadId(threadId);
  const matches = (await listThreads(env))
    .filter((thread) => thread.id === id || thread.name === id || thread.bindingName === id)
    .sort((left, right) => Number(right.id === id) - Number(left.id === id));
  if (!matches.length) return null;
  const accessible = matches.find((thread) => {
    try {
      assertResourceAccess(principal, thread, "thread_access", env);
      return true;
    } catch {
      return false;
    }
  });
  if (accessible) return accessible;
  assertResourceAccess(principal, matches[0], "thread_access", env);
  return null;
}

async function saveThreads(threads, env) {
  return createThreadRepository(env).save(threads);
}

export async function createThread(input = {}, env = process.env) {
  const threads = await listThreads(env);
  const requestedId = normalizeThreadId(input.id || input.threadId);
  const name = String(input.name || input.displayName || requestedId || "New Thread").trim();
  const ownerUserId = normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const existingByRequestedId = requestedId
    ? threads.find((thread) =>
        resourceOwnerUserId(thread, env) === ownerUserId &&
        (thread.id === requestedId || thread.name === requestedId || thread.bindingName === requestedId)
      )
    : null;
  const existingByName = name
    ? threads.find((thread) => resourceOwnerUserId(thread, env) === ownerUserId && (thread.name === name || thread.bindingName === name))
    : null;
  const existing = existingByRequestedId || existingByName;
  if (existing) return existing;
  const runtimeKind = String(input.runtimeKind || input.runtime?.runtimeKind || input.executor?.metadata?.runtimeKind || "").trim();
  const codexThreadId = String(input.codexThreadId || input.executor?.codexThreadId || input.executor?.metadata?.codexThreadId || "").trim();
  const codexSessionId = String(input.codexSessionId || input.executor?.codexSessionId || input.executor?.metadata?.codexSessionId || "").trim();

  const thread = {
    id: requestedId || randomUUID(),
    ownerUserId,
    name,
    title: String(input.title || name).trim(),
    state: String(input.state || "sleeping").trim(),
    wakePolicy: String(input.wakePolicy || "wake-on-message").trim(),
    cwd: String(input.cwd || input.projectRoot || input.workspace || "").trim(),
    workspace: String(input.workspace || input.cwd || input.projectRoot || "").trim(),
    command: String(input.cmd || input.command || "").trim(),
    runtime: input.runtime && typeof input.runtime === "object" ? { ...input.runtime } : null,
    runtimeKind: runtimeKind || null,
    codexThreadId: codexThreadId || null,
    codexSessionId: codexSessionId || null,
    executor: {
      id: String(input.executorId || input.executor?.id || "").trim(),
      type: String(input.executor?.type || "generic").trim(),
      codexThreadId,
      codexSessionId,
      metadata: input.executor?.metadata && typeof input.executor.metadata === "object" ? input.executor.metadata : {},
    },
    binding: input.binding && typeof input.binding === "object" ? { ...input.binding } : null,
    bindingName: String(input.bindingName || input.binding?.displayName || "").trim(),
    securityProfile: String(input.securityProfile || input.executor?.metadata?.securityProfile || "").trim() || null,
    codexSandbox: String(input.codexSandbox || input.executor?.metadata?.codexSandbox || "").trim() || null,
    codexApprovalPolicy: String(input.codexApprovalPolicy || input.executor?.metadata?.codexApprovalPolicy || "").trim() || null,
    codexMode: input.codexMode || null,
    desiredCodexMode: input.desiredCodexMode || null,
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
  await appendEvent({ type: "thread_created", threadId: thread.id, name: thread.name, ownerUserId: thread.ownerUserId }, env);
  return thread;
}

export async function createThreadForPrincipal(input = {}, principal, env = process.env) {
  if (!isAdminPrincipal(principal) && !String(principal?.userId || "").trim()) {
    throw policyError("thread_owner_required", 403);
  }
  const ownerUserId = isAdminPrincipal(principal)
    ? normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId)
    : normalizeUserId(principal?.userId);
  const requestedId = normalizeThreadId(input.id || input.threadId);
  const name = String(input.name || input.displayName || requestedId || "New Thread").trim();
  const threads = await listThreads(env);
  const existing = threads.find((thread) =>
    resourceOwnerUserId(thread, env) === ownerUserId &&
    (
      (requestedId && (thread.id === requestedId || thread.name === requestedId || thread.bindingName === requestedId)) ||
      (name && (thread.name === name || thread.bindingName === name))
    )
  );
  if (existing) return existing;
  if (!isAdminPrincipal(principal)) {
    const user = await getUser(principal?.userId, env);
    assertThreadLimit(principal, threads, user, env);
  }
  const restrictedApprovalPolicy = restrictedCodexApprovalPolicy(input);
  const restrictedSecurityProfile = restrictedCodexSecurityProfile(input);
  const restrictedCodexDefaults = isAdminPrincipal(principal) ? {} : {
    securityProfile: restrictedSecurityProfile,
    codexSandbox: "workspace-write",
    codexApprovalPolicy: restrictedApprovalPolicy,
    executor: {
      ...(input.executor || {}),
      metadata: {
        ...(input.executor?.metadata || {}),
        securityProfile: restrictedSecurityProfile,
        codexSandbox: "workspace-write",
        codexApprovalPolicy: restrictedApprovalPolicy,
      },
    },
  };
  return createThread({
    ...input,
    ...restrictedCodexDefaults,
    ownerUserId,
  }, env);
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
  const messageRepository = createThreadMessageRepository(env);
  for (const deletedId of deletedIds) {
    await messageRepository.delete(deletedId).catch(() => {});
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

export async function deleteThreadForPrincipal(threadId, principal, options = {}, env = process.env) {
  const target = await getThreadForPrincipal(threadId, principal, env);
  return deleteThread(target.id, options, env);
}

export async function listThreadMessages(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  const id = thread?.id || normalizeThreadId(threadId);
  return createThreadMessageRepository(env).list(id);
}

export async function listThreadMessagesForPrincipal(threadId, principal, env = process.env) {
  const thread = await getThreadForPrincipal(threadId, principal, env);
  return listThreadMessages(thread.id, env);
}

export async function appendThreadMessage(threadId, input, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messageRepository = createThreadMessageRepository(env);
  const filePath = await messageRepository.pathForThread(thread.id);
  const message = await enqueueMessageMutation(filePath, async () => {
    const messages = await messageRepository.list(thread.id);
    const role = String(input.role || "assistant");
    const source = String(input.source || "manual");
    const externalId = String(input.externalId || "").trim();
    if (role === "user" && externalId && whatsappOrigin({ ...input, role, source })) {
      const duplicate = [...messages].reverse().find((existing) =>
        existing.role === "user" &&
        whatsappOrigin(existing) &&
        String(existing.externalId || "").trim() === externalId &&
        sameOptionalMessageField(existing, input, "chatId") &&
        sameOptionalMessageField(existing, input, "from") &&
        sameOptionalMessageField(existing, input, "accountId")
      );
      if (duplicate) return { ...duplicate, duplicate: true, duplicateReason: "external_id" };
    }
    const cursor =
      Number(input.cursor || 0) ||
      Math.max(0, ...messages.map((item) => Number(item.cursor || 0)).filter(Number.isFinite)) + 1;
    let nextMessage = {
      id: randomUUID(),
      ownerUserId: normalizeUserId(input.ownerUserId || thread.ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
      role,
      source,
      text: String(input.text || "").trim(),
      promptFile: String(input.promptFile || "").trim(),
      parentMessageId: String(input.parentMessageId || "").trim() || null,
      executionId: String(input.executionId || "").trim() || null,
      createdAt: String(input.timestamp || input.createdAt || "").trim() || nowIso(),
      cursor,
      state: String(input.state || "completed"),
    };
    for (const key of messageStringFields) {
      const value = String(input[key] || "").trim();
      if (value) nextMessage[key] = value;
    }
    nextMessage = normalizeNoReplyAssistantMessage(nextMessage);
    if (input.forceDeliveryAfterInterrupt === true) nextMessage.forceDeliveryAfterInterrupt = true;
    if (!nextMessage.text && !nextMessage.promptFile) {
      const error = new Error("message_text_required");
      error.statusCode = 400;
      throw error;
    }
    const resolvedAttachments = await resolveThreadAttachments({
      thread,
      text: nextMessage.text,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      env,
    });
    if (resolvedAttachments.attachments.length) {
      nextMessage.attachments = resolvedAttachments.attachments;
    }
    const next = [...messages, nextMessage];
    await messageRepository.save(thread.id, next);
    return nextMessage;
  });
  if (message.duplicate) {
    await appendEvent({
      type: "thread_input_duplicate_suppressed",
      threadId: thread.id,
      messageId: message.id,
      source: input.source || "",
      connector: input.connector || "",
      duplicateReason: message.duplicateReason || "",
    }, env);
    return message;
  }
  await updateThread(thread.id, { state: activeInputStates.has(message.state) ? message.state : thread.state }, env);
  await appendEvent({ type: `thread_message_${message.state}`, threadId: thread.id, messageId: message.id, source: message.source, role: message.role, ownerUserId: message.ownerUserId }, env);
  return message;
}

function compactInputText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function whatsappOrigin(input = {}) {
  return String(input.connector || "").trim().toLowerCase() === "whatsapp" ||
    whatsappSources.has(String(input.source || "").trim().toLowerCase());
}

function whatsappBindingInputDefaults(thread, input = {}) {
  if (!whatsappOrigin(input)) return input;
  const binding = thread?.binding || {};
  if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return input;
  const chatId = String(input.chatId || binding.chatId || "").trim();
  if (!chatId) return input;
  return {
    ...input,
    connector: String(input.connector || "whatsapp").trim(),
    originSurface: String(input.originSurface || "whatsapp").trim(),
    originTransport: String(input.originTransport || "whatsapp-direct").trim(),
    chatId,
    accountId: String(
      input.accountId ||
      binding.responderAccountId ||
      binding.outboundAccountId ||
      binding.senderAccountId ||
      binding.inboundAccountId ||
      "",
    ).trim(),
  };
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
  const thread = await getThread(threadId, env);
  const nextInput = whatsappBindingInputDefaults(thread, input);
  const duplicate = await activeDuplicateThreadInput(thread?.id || threadId, nextInput, env);
  if (duplicate) {
    await appendEvent({
      type: "thread_input_duplicate_suppressed",
      threadId,
      messageId: duplicate.id,
      source: nextInput.source || "",
      connector: nextInput.connector || "",
    }, env);
    return { ...duplicate, duplicate: true, duplicateReason: "active_input" };
  }
  return appendThreadMessage(thread?.id || threadId, {
    ...nextInput,
    role: "user",
    state: "queued",
  }, env);
}

export async function enqueueThreadInputForPrincipal(threadId, input, principal, env = process.env) {
  const thread = await getThreadForPrincipal(threadId, principal, env);
  const nextInput = whatsappBindingInputDefaults(thread, { ...input, ownerUserId: thread.ownerUserId });
  const duplicate = await activeDuplicateThreadInput(thread.id, nextInput, env);
  if (duplicate) {
    await appendEvent({
      type: "thread_input_duplicate_suppressed",
      threadId: thread.id,
      messageId: duplicate.id,
      source: nextInput.source || "",
      connector: nextInput.connector || "",
    }, env);
    return { ...duplicate, duplicate: true, duplicateReason: "active_input" };
  }
  if (!isAdminPrincipal(principal)) {
    const capabilities = await userScopedCapabilityHints({ userId: thread.ownerUserId, thread }, env);
    await assertSanitizedAction({
      action: "thread.input",
      principal,
      resource: {
        type: "thread",
        id: thread.id,
        ownerUserId: thread.ownerUserId,
        capabilities,
      },
      input: {
        text: String(nextInput?.text || "").slice(0, 8000),
        promptFile: String(nextInput?.promptFile || ""),
        attachments: Array.isArray(nextInput?.attachments) ? nextInput.attachments.map((attachment) => ({
          name: attachment?.name || attachment?.filename || "",
          mimetype: attachment?.mimetype || attachment?.type || "",
          size: attachment?.size || null,
        })) : [],
        source: nextInput?.source || "",
      },
    }, env);
  }
  return appendThreadMessage(thread.id, {
    ...nextInput,
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
  const messageRepository = createThreadMessageRepository(env);
  const filePath = await messageRepository.pathForThread(thread.id);
  return enqueueMessageMutation(filePath, async () => {
    const messages = await messageRepository.list(thread.id);
    let updated = null;
    let previous = null;
    const normalizeAttachments = Object.prototype.hasOwnProperty.call(patch || {}, "text") ||
      Object.prototype.hasOwnProperty.call(patch || {}, "attachments");
    const visibleMutationFields = visibleMessageMutationFields(patch);
    const next = [];
    for (const message of messages) {
      if (message.id !== messageId) {
        next.push(message);
        continue;
      }
      previous = message;
      const nextRevision = visibleMutationFields.length
        ? Math.max(1, Number(message.revision || 1) || 1) + 1
        : message.revision;
      updated = normalizeNoReplyAssistantMessage({
        ...message,
        ...patch,
        ...(nextRevision ? { revision: nextRevision } : {}),
        updatedAt: nowIso(),
      });
      if (normalizeAttachments) {
        const sourceAttachments = Array.isArray(updated.attachments) ? updated.attachments : [];
        const resolvedAttachments = await resolveThreadAttachments({
          thread,
          text: updated.text,
          attachments: sourceAttachments,
          env,
        });
        if (resolvedAttachments.attachments.length) updated.attachments = resolvedAttachments.attachments;
        else delete updated.attachments;
      }
      next.push(updated);
    }
    if (!updated) {
      const error = new Error("message_not_found");
      error.statusCode = 404;
      throw error;
    }
    await messageRepository.save(thread.id, next);
    if (visibleMutationFields.length) {
      const deleted = Boolean(patch?.deletedAt);
      await appendEvent({
        type: deleted ? "thread_message_deleted" : "thread_message_edited",
        eventType: deleted ? "message.deleted" : "message.edited",
        threadId: thread.id,
        messageId: updated.id,
        ownerUserId: updated.ownerUserId || thread.ownerUserId || null,
        role: updated.role,
        source: updated.source,
        connector: updated.connector || "",
        chatId: updated.chatId || "",
        accountId: updated.accountId || "",
        previousRevision: previous?.revision || 1,
        sourceRevision: updated.revision || 1,
        changedFields: visibleMutationFields,
      }, env);
    }
    return updated;
  });
}

export async function deleteThreadMessage(threadId, messageId, options = {}, env = process.env) {
  return updateThreadMessage(threadId, messageId, {
    deletedAt: String(options.deletedAt || "").trim() || nowIso(),
    deletedBy: String(options.deletedBy || options.actor || "").trim(),
    deleteReason: String(options.reason || options.deleteReason || "").trim(),
  }, env);
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
