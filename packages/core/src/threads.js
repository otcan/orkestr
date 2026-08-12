import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { createThreadMessageRepository, createThreadRepository } from "../../storage/src/repositories.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { normalizeNoReplyAssistantMessage } from "./no-reply.js";
import { assertResourceAccess, assertThreadLimit, filterResourcesForPrincipal, isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { resolveThreadAttachments } from "./thread-attachments.js";
import { userScopedCapabilityHints } from "./user-skills.js";
import { adminUserId, getUser, normalizeUserId } from "./users.js";
import {
  consumeMailboxContextsForHumanTurn,
  releaseMailboxContextsForHumanTurn,
  reserveMailboxContextsForHumanTurn,
} from "./mailbox-routes.js";
import {
  assertPublicRefInvariant,
  assertUniquePublicRefs,
  canonicalInstanceUrlsEnabled,
  generateUniquePublicRef,
} from "./canonical-public-references.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";

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
  "codexDeliveryMode",
  "observedVia",
  "runtimeLeaseId",
  "deliveredAt",
  "error",
  "visibility",
  "silentReason",
  "noticeCause",
  "recoverySource",
  "recoveryReason",
  "replayedFromMessageId",
  "previousCodexThreadId",
  "previousRecoveryNoticeId",
  "runtimeCheckpointId",
  "originSurface",
  "originTransport",
  "senderParticipantId",
  "senderTrustLevel",
  "senderEffectiveRole",
  "senderPolicyMode",
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
  "codexServiceTier",
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
  "apiSessionId",
  "clientMessageId",
  "idempotencyKey",
  "signalKind",
  "signalMode",
  "mailboxExecutionPolicy",
  "mailboxContextClaimId",
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
  const tracked = next.finally(() => {
    if (messageMutationQueues.get(filePath) === tracked) messageMutationQueues.delete(filePath);
  });
  // `next` is returned to the caller. The tracked promise exists only to
  // serialize and clean up the queue, so consume its mirrored rejection.
  void tracked.catch(() => {});
  messageMutationQueues.set(filePath, tracked);
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
  assertUniquePublicRefs(threads, "thread");
  return createThreadRepository(env).save(threads);
}

export async function createThread(input = {}, env = process.env) {
  return withCanonicalPublicReferenceLock(() => createThreadLocked(input, env), env);
}

async function createThreadLocked(input = {}, env = process.env) {
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

  const publicRefAssignedAt = canonicalInstanceUrlsEnabled(env) ? nowIso() : "";
  const thread = {
    id: requestedId || randomUUID(),
    ...(publicRefAssignedAt ? {
      publicRef: generateUniquePublicRef("thread", new Set(threads.map((item) => String(item.publicRef || "")).filter(Boolean))),
      publicRefAssignedAt,
    } : {}),
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
    codexServiceTier: input.codexServiceTier || input.executor?.metadata?.codexServiceTier || null,
    codexContextWindow: input.codexContextWindow || input.executor?.metadata?.codexContextWindow || null,
    codexTokenUsage: input.codexTokenUsage || input.executor?.metadata?.codexTokenUsage || null,
    codexRateLimits: input.codexRateLimits || input.executor?.metadata?.codexRateLimits || null,
    parentThreadId: String(input.parentThreadId || "").trim() || null,
    rootThreadId: String(input.rootThreadId || input.parentThreadId || "").trim() || null,
    threadKind: String(input.threadKind || "").trim() || null,
    agentParentThreadId: String(input.agentParentThreadId || "").trim() || null,
    agentRequestedParentThreadId: String(input.agentRequestedParentThreadId || "").trim() || null,
    agentOriginThreadId: String(input.agentOriginThreadId || "").trim() || null,
    agentOriginRootThreadId: String(input.agentOriginRootThreadId || "").trim() || null,
    agentTaskId: String(input.agentTaskId || "").trim() || null,
    agentProfileId: String(input.agentProfileId || "").trim() || null,
    agentTaskStatus: String(input.agentTaskStatus || "").trim() || null,
    agentTaskAutoRun: typeof input.agentTaskAutoRun === "boolean" ? input.agentTaskAutoRun : null,
    agentTask: String(input.agentTask || "").trim() || null,
    agentContextRefs: Array.isArray(input.agentContextRefs) ? input.agentContextRefs.map((value) => String(value || "").trim()).filter(Boolean) : [],
    agentTaskPrompt: String(input.agentTaskPrompt || "").trim() || null,
    agentTaskMessageId: String(input.agentTaskMessageId || "").trim() || null,
    agentResultSourceMessageId: String(input.agentResultSourceMessageId || "").trim() || null,
    agentParentResultMessageId: String(input.agentParentResultMessageId || "").trim() || null,
    agentTaskCompletedAt: String(input.agentTaskCompletedAt || "").trim() || null,
    desktopSlug: String(input.desktopSlug || "").trim() || null,
    browserSlug: String(input.browserSlug || "").trim() || null,
    managedDesktopSlug: String(input.managedDesktopSlug || "").trim() || null,
    manualInterventionDesktopSlug: String(input.manualInterventionDesktopSlug || "").trim() || null,
    defaultDesktopSlug: String(input.defaultDesktopSlug || "").trim() || null,
    desktopAccess: input.desktopAccess && typeof input.desktopAccess === "object" && !Array.isArray(input.desktopAccess)
      ? { ...input.desktopAccess }
      : null,
    desktopGrants: Array.isArray(input.desktopGrants)
      ? input.desktopGrants.map((value) => typeof value === "string" ? value : value && typeof value === "object" ? { ...value } : null).filter(Boolean)
      : [],
    resourceGrants: Array.isArray(input.resourceGrants)
      ? input.resourceGrants.map((value) => typeof value === "string" ? value : value && typeof value === "object" ? { ...value } : null).filter(Boolean)
      : [],
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
  if (thread.parentThreadId) {
    // A child is held out of discovery until its immutable parent ceiling is
    // captured. A failed policy transaction must never create a runnable child
    // with an implicit parent-wide scope.
    const { captureChildThreadResourceCeiling } = await import("./thread-resource-grants.js");
    await captureChildThreadResourceCeiling(thread, env);
  }
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
  return withCanonicalPublicReferenceLock(() => updateThreadLocked(threadId, patch, env), env);
}

async function updateThreadLocked(threadId, patch = {}, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  let updated = null;
  let changed = false;
  const next = threads.map((thread) => {
    if (thread.id !== id && thread.name !== id && thread.bindingName !== id) return thread;
    assertPublicRefInvariant(thread.publicRef, Object.prototype.hasOwnProperty.call(patch, "publicRef") ? patch.publicRef : thread.publicRef, "thread");
    if (thread.publicRefAssignedAt && Object.prototype.hasOwnProperty.call(patch, "publicRefAssignedAt") && patch.publicRefAssignedAt !== thread.publicRefAssignedAt) {
      throw Object.assign(new Error("thread_public_ref_metadata_immutable"), { statusCode: 400 });
    }
    const candidate = {
      ...thread,
      ...patch,
      executor: patch.executor ? { ...(thread.executor || {}), ...patch.executor } : thread.executor,
      binding: patch.binding ? { ...(thread.binding || {}), ...patch.binding } : thread.binding,
      updatedAt: nowIso(),
    };
    if (comparableThreadState(thread) === comparableThreadState(candidate)) {
      updated = thread;
      return thread;
    }
    updated = candidate;
    changed = true;
    return updated;
  });
  if (!updated) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (changed) await saveThreads(next, env);
  return updated;
}

function comparableThreadState(thread = {}) {
  const comparable = { ...(thread || {}) };
  delete comparable.updatedAt;
  return JSON.stringify(comparable);
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
  return withCanonicalPublicReferenceLock(() => deleteThreadLocked(threadId, options, env), env);
}

async function deleteThreadLocked(threadId, options = {}, env = process.env) {
  const id = normalizeThreadId(threadId);
  const threads = await listThreads(env);
  const target = threads.find((thread) => thread.id === id || thread.name === id || thread.bindingName === id);
  if (!target) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const childThreads = threads.filter((thread) => thread.parentThreadId === target.id || thread.rootThreadId === target.id);
  const blockingChildren = childThreads.filter((thread) => thread.threadKind !== "task-agent");
  if (blockingChildren.length && options.deleteWorkers !== true) {
    const error = new Error("thread_has_workers");
    error.statusCode = 409;
    error.workerCount = blockingChildren.length;
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

export async function listThreadMessageCandidates(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  const id = thread?.id || normalizeThreadId(threadId);
  const repository = createThreadMessageRepository(env);
  const stored = await repository.listCandidates(id, options);
  if (Array.isArray(stored)) return stored;
  const messages = await repository.list(id);
  const selected = new Map();
  const add = (message, index) => selected.set(String(message?.id || index), { message, index });
  const tailLimit = Math.max(0, Number(options.tailLimit || 0) || 0);
  if (tailLimit) {
    const start = Math.max(0, messages.length - tailLimit);
    messages.slice(start).forEach((message, index) => add(message, start + index));
  }
  if (Object.prototype.hasOwnProperty.call(options, "afterCursor")) {
    const threshold = Math.max(0, Number(options.afterCursor || 0) || 0);
    messages.forEach((message, index) => {
      if ((Number(message?.cursor || 0) || index + 1) > threshold) add(message, index);
    });
  }
  const ids = new Set((options.ids || []).map((value) => String(value || "").trim()).filter(Boolean));
  const eventIds = new Set((options.eventIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const states = new Set((options.states || []).map((value) => String(value || "").trim()).filter(Boolean));
  const phases = new Set((options.phases || []).map((value) => String(value || "").trim()).filter(Boolean));
  messages.forEach((message, index) => {
    if (
      ids.has(String(message?.id || "")) ||
      eventIds.has(String(message?.eventId || "")) ||
      states.has(String(message?.state || "")) ||
      phases.has(String(message?.phase || ""))
    ) add(message, index);
  });
  return [...selected.values()].sort((left, right) => left.index - right.index).map((entry) => entry.message);
}

export async function getThreadMessage(threadId, messageId, env = process.env) {
  const thread = await getThread(threadId, env);
  const id = thread?.id || normalizeThreadId(threadId);
  const repository = createThreadMessageRepository(env);
  if (await repository.usesSqlite()) return repository.get(id, messageId);
  return (await repository.list(id)).find((message) => message.id === messageId) || null;
}

export async function findThreadMessage(threadId, fields = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  const id = thread?.id || normalizeThreadId(threadId);
  const repository = createThreadMessageRepository(env);
  if (await repository.usesSqlite()) return repository.find(id, fields);
  const messages = await repository.list(id);
  return [...messages].reverse().find((message) => Object.entries(fields).every(([key, value]) => {
    const expected = String(value || "").trim();
    if (!expected) return true;
    const actual = key === "codexThreadId"
      ? message?.codexThreadId || message?.executorThreadId
      : key === "codexTurnId"
        ? message?.codexTurnId || message?.executorTurnId
        : key === "codexItemId"
          ? message?.codexItemId || message?.executorItemId
          : message?.[key];
    return String(actual || "").trim() === expected;
  })) || null;
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
    const sqlite = await messageRepository.usesSqlite();
    const messages = sqlite ? null : await messageRepository.list(thread.id);
    const role = String(input.role || "assistant");
    const source = String(input.source || "manual");
    const clientMessageId = clientInputIdempotencyKey(input);
    if (role === "user" && clientMessageId) {
      const duplicate = sqlite
        ? await messageRepository.find(thread.id, { clientMessageId, role: "user" })
        : [...messages].reverse().find((existing) =>
            existing.role === "user" &&
            clientInputIdempotencyKey(existing) === clientMessageId
          );
      if (duplicate) return { ...duplicate, duplicate: true, duplicateReason: "client_message_id" };
    }
    if (role === "assistant" && input.dedupeAssistantByIdempotencyKey === true && clientMessageId) {
      const candidate = sqlite
        ? await messageRepository.find(thread.id, { clientMessageId, role: "assistant" })
        : [...messages].reverse().find((existing) =>
            existing.role === "assistant" &&
            existing.source === source &&
            clientInputIdempotencyKey(existing) === clientMessageId
          );
      const duplicate = candidate && candidate.source === source ? candidate : null;
      if (duplicate) return { ...duplicate, duplicate: true, duplicateReason: "assistant_idempotency_key" };
    }
    const externalId = String(input.externalId || "").trim();
    if (role === "user" && externalId && whatsappOrigin({ ...input, role, source })) {
      const candidate = sqlite
        ? await messageRepository.find(thread.id, { externalId, role: "user" })
        : null;
      const duplicate = sqlite
        ? candidate && whatsappOrigin(candidate) && sameOptionalMessageField(candidate, input, "chatId") ? candidate : null
        : [...messages].reverse().find((existing) =>
            existing.role === "user" &&
            whatsappOrigin(existing) &&
            String(existing.externalId || "").trim() === externalId &&
            sameOptionalMessageField(existing, input, "chatId")
          );
      if (duplicate) return { ...duplicate, duplicate: true, duplicateReason: "external_id" };
    }
    const cursor =
      Number(input.cursor || 0) ||
      (sqlite
        ? await messageRepository.nextCursor(thread.id)
        : Math.max(0, ...messages.map((item) => Number(item.cursor || 0)).filter(Number.isFinite)) + 1);
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
    if (clientMessageId) nextMessage.clientMessageId = clientMessageId;
    for (const key of messageStringFields) {
      const value = String(input[key] || "").trim();
      if (value) nextMessage[key] = value;
    }
    if (input.externalPrincipal && typeof input.externalPrincipal === "object" && !Array.isArray(input.externalPrincipal)) {
      nextMessage.externalPrincipal = Object.fromEntries(
        Object.entries(input.externalPrincipal)
          .map(([key, value]) => [key, String(value || "").trim()])
          .filter(([, value]) => value),
      );
    }
    if (input.securityClassification && typeof input.securityClassification === "object" && !Array.isArray(input.securityClassification)) {
      nextMessage.securityClassification = {
        malicious: input.securityClassification.malicious === true,
        reason: String(input.securityClassification.reason || "").trim(),
      };
    }
    if (input.shadowBoundaryWarning && typeof input.shadowBoundaryWarning === "object" && !Array.isArray(input.shadowBoundaryWarning)) {
      nextMessage.shadowBoundaryWarning = {
        eligible: input.shadowBoundaryWarning.eligible === true,
        emitted: input.shadowBoundaryWarning.emitted === true,
        resourceType: String(input.shadowBoundaryWarning.resourceType || "").trim().toLowerCase(),
        mode: String(input.shadowBoundaryWarning.mode || "").trim().toLowerCase(),
        reason: String(input.shadowBoundaryWarning.reason || "").trim().toLowerCase(),
        notificationId: String(input.shadowBoundaryWarning.notificationId || "").trim(),
      };
    }
    nextMessage = normalizeNoReplyAssistantMessage(nextMessage);
    if (input.forceDeliveryAfterInterrupt === true) nextMessage.forceDeliveryAfterInterrupt = true;
    if (input.steerActiveTurn === true || input.steerActiveTurn === false) nextMessage.steerActiveTurn = input.steerActiveTurn;
    if (input.recoveryContinuation === true) nextMessage.recoveryContinuation = true;
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
    if (sqlite) await messageRepository.append(thread.id, nextMessage);
    else await messageRepository.save(thread.id, [...messages, nextMessage]);
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

function clientInputIdempotencyKey(input = {}) {
  return String(
    input.clientMessageId ||
    input.client_message_id ||
    input.clientMessageID ||
    input.idempotencyKey ||
    "",
  ).trim();
}

function mailboxContextClaimKey(threadId = "", input = {}) {
  const clientMessageId = clientInputIdempotencyKey(input);
  if (!clientMessageId) return randomUUID();
  return `mailbox-context:${createHash("sha256").update(`${threadId}:${clientMessageId}`).digest("hex").slice(0, 40)}`;
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
  const repository = createThreadMessageRepository(env);
  const messages = await repository.usesSqlite()
    ? await repository.listByStates(threadId, [...activeInputStates])
    : await listThreadMessages(threadId, env);
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
  // Context-next-turn mailbox routes reserve their durable context only for an
  // authenticated human input. The reservation is released if this message is
  // not durably created, and a passive delivery marker prevents it steering an
  // already-running turn.
  const mailboxContextClaimId = mailboxContextClaimKey(thread.id, nextInput);
  // Reconcile a durable append that survived a crash before its context state
  // was consumed. The claim id is deterministic for a client idempotency key,
  // so a retry sees the same reserved context rather than attaching it to a
  // later, unrelated human request.
  const knownMessageClaims = (await listThreadMessages(thread.id, env)).map((message) => ({
    claimId: String(message.mailboxContextClaimId || "").trim(),
    messageId: String(message.id || "").trim(),
  })).filter((item) => item.claimId && item.messageId);
  const reservation = await reserveMailboxContextsForHumanTurn({ threadId: thread.id, claimId: mailboxContextClaimId, knownMessageClaims }, env);
  const contextualInput = reservation.contexts.length ? {
    ...nextInput,
    text: [reservation.text, String(nextInput.text || "").trim() ? `Human request:\n${String(nextInput.text || "").trim()}` : ""].filter(Boolean).join("\n\n"),
    mailboxContextClaimId,
    codexDeliveryMode: "passive",
    steerActiveTurn: false,
  } : nextInput;
  try {
    const message = await appendThreadMessage(thread.id, {
      ...contextualInput,
      role: "user",
      state: "queued",
    }, env);
    if (reservation.contexts.length && (!message.duplicate || String(message.mailboxContextClaimId || "") === mailboxContextClaimId)) {
      await consumeMailboxContextsForHumanTurn(mailboxContextClaimId, message.id, env);
    } else if (reservation.contexts.length) {
      await releaseMailboxContextsForHumanTurn(mailboxContextClaimId, env);
    }
    return message;
  } catch (error) {
    if (reservation.contexts.length) await releaseMailboxContextsForHumanTurn(mailboxContextClaimId, env).catch(() => {});
    throw error;
  }
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
    const sqlite = await messageRepository.usesSqlite();
    const storedMessage = sqlite ? await messageRepository.get(thread.id, messageId) : null;
    const messages = sqlite ? (storedMessage ? [storedMessage] : []) : await messageRepository.list(thread.id);
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
    if (sqlite) await messageRepository.update(thread.id, messageId, updated);
    else await messageRepository.save(thread.id, next);
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
  const messages = await listThreadMessageCandidates(threadId, { states: ["queued"] }, env);
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
