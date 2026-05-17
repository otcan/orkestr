import { resolveCodexThreadMetadata, runtimeStatus } from "../../../packages/core/src/runtime-leases.js";
import { listThreadMessages, listThreads } from "../../../packages/core/src/threads.js";
import { detectThreadGitState } from "../../../packages/core/src/thread-workers.js";

type ThreadSummaryOptions = {
  cacheTtlMs?: number;
};

const threadSummaryCache = new Map<string, { cacheKey: string; expiresAt: number; summary: Record<string, unknown> }>();

export function codexThreadId(thread: any): string {
  return String(thread?.executor?.codexThreadId || thread?.codexThreadId || "").trim();
}

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);

function isNeedInputMessage(message: any): boolean {
  const role = String(message?.role || message?.kind || "assistant").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  return role === "assistant" && needInputPhases.has(phase) && !!String(message?.text || "").trim();
}

function latestPendingQuestion(messages: any[] = []) {
  let userRepliedAfterQuestion = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = String(message?.text || "").trim();
    if (!text) continue;
    const role = String(message?.role || message?.kind || "").trim().toLowerCase();
    if (role === "user") {
      userRepliedAfterQuestion = true;
      continue;
    }
    if (!isNeedInputMessage(message)) continue;
    if (userRepliedAfterQuestion) return null;
    const timestamp = message?.timestamp || message?.createdAt || null;
    const eventId = String(message?.eventId || message?.id || "").trim() || null;
    return {
      text,
      eventId,
      messageId: message?.id || null,
      cursor: messageCursor(message, index),
      timestamp,
      phase: message?.phase || null,
    };
  }
  return null;
}

function codexMetadata(thread: any) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const tokenUsage = thread?.codexTokenUsage || metadata.codexTokenUsage || metadata.tokenUsage || null;
  const totalTokenUsage = thread?.codexTotalTokenUsage || metadata.codexTotalTokenUsage || metadata.totalTokenUsage || null;
  const contextWindow = Number(thread?.codexContextWindow || metadata.codexContextWindow || metadata.contextWindow || 0) || null;
  const rateLimits = thread?.codexRateLimits || metadata.codexRateLimits || metadata.rateLimits || null;
  return {
    codexMode: thread?.codexMode || metadata.codexMode || thread?.desiredCodexMode || null,
    codexModeLabel: thread?.codexModeLabel || metadata.codexModeLabel || null,
    codexModeRaw: thread?.codexModeRaw || metadata.codexModeRaw || null,
    codexModeSource: thread?.codexModeSource || metadata.codexModeSource || null,
    codexModeUpdatedAt: thread?.codexModeUpdatedAt || metadata.codexModeUpdatedAt || null,
    desiredCodexMode: thread?.desiredCodexMode || null,
    desiredCodexModeUpdatedAt: thread?.desiredCodexModeUpdatedAt || null,
    codexModel: thread?.codexModel || metadata.codexModel || process.env.ORKESTR_DEFAULT_CODEX_MODEL || process.env.OPENAI_MODEL || null,
    codexModelProvider: thread?.codexModelProvider || metadata.codexModelProvider || "codex",
    codexReasoningEffort: thread?.codexReasoningEffort || metadata.codexReasoningEffort || process.env.ORKESTR_DEFAULT_CODEX_REASONING || null,
    codexModelUpdatedAt: thread?.codexModelUpdatedAt || metadata.codexModelUpdatedAt || null,
    codexContextWindow: contextWindow,
    codexTokenUsage: tokenUsage,
    codexTotalTokenUsage: totalTokenUsage,
    codexRateLimits: rateLimits,
  };
}

function threadSummaryCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 120_000;
}

function threadSummaryCacheKey(thread: any, messages: any[] = []): string {
  const lastMessage = messages.at(-1) || {};
  const pendingCounts = messages.reduce((counts: Record<string, number>, message: any) => {
    const state = String(message?.state || "unknown");
    counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  return JSON.stringify({
    id: thread?.id || null,
    name: thread?.name || null,
    title: thread?.title || null,
    bindingName: thread?.bindingName || null,
    state: thread?.state || null,
    status: thread?.status || null,
    activeRuntimeLeaseId: thread?.activeRuntimeLeaseId || null,
    runtimeState: thread?.runtime?.state || null,
    paneId: thread?.runtime?.paneId || thread?.executor?.tmuxTarget || null,
    sessionName: thread?.runtime?.sessionName || thread?.executor?.sessionName || null,
    repoPath: thread?.repoPath || thread?.worktreePath || null,
    branchName: thread?.branchName || null,
    baseCommit: thread?.baseCommit || null,
    baseBranch: thread?.baseBranch || null,
    remoteBranch: thread?.remoteBranch || null,
    workerStatus: thread?.workerStatus || null,
    workerLabel: thread?.workerLabel || null,
    binding: thread?.binding || null,
    messageCount: messages.length,
    pendingCounts,
    lastMessageId: lastMessage?.id || null,
    lastMessageState: lastMessage?.state || null,
    lastMessageDeliveryState: lastMessage?.deliveryState || null,
    lastMessageDeliveryNextAttemptAt: lastMessage?.deliveryNextAttemptAt || null,
    lastMessageUpdatedAt: lastMessage?.updatedAt || lastMessage?.createdAt || null,
  });
}

export async function threadRuntimeSummary(thread: any, messages: any[] = [], options: ThreadSummaryOptions = {}) {
  const ttlMs = Number(options.cacheTtlMs ?? 0) || 0;
  const cacheKey = ttlMs > 0 ? threadSummaryCacheKey(thread, messages) : "";
  const cached = ttlMs > 0 ? threadSummaryCache.get(String(thread?.id || "")) : null;
  if (cached && cached.cacheKey === cacheKey && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  const status = await runtimeStatus(thread.id).catch(() => null);
  const gitState: any = await detectThreadGitState(thread).catch(() => ({}));
  const metadataTarget = {
    ...thread,
    ...gitState,
    runtime: status?.lease ? { ...(thread.runtime || {}), ...status.lease } : thread.runtime,
  };
  const liveCodexMetadata: any = await resolveCodexThreadMetadata(metadataTarget).catch(() => ({}));
  const codexThread = {
    ...thread,
    ...liveCodexMetadata,
    executor: {
      ...(thread.executor || {}),
      codexThreadId: liveCodexMetadata.codexThreadId || thread.executor?.codexThreadId || "",
      metadata: {
        ...(thread.executor?.metadata || {}),
        ...liveCodexMetadata,
      },
    },
  };
  const state = status?.state || thread.state || "sleeping";
  const ready = state === "ready";
  const awaitingAckCount = status?.awaitingAckCount ?? 0;
  const lastActivityAt = messages.at(-1)?.createdAt || thread.updatedAt || thread.createdAt || null;
  const pendingQuestion = latestPendingQuestion(messages);
  const resolvedCodexThreadId = codexThreadId(codexThread);
  const summary = {
    ...thread,
    ...gitState,
    threadId: resolvedCodexThreadId || thread.id,
    codexThreadId: resolvedCodexThreadId || null,
    status: state,
    state,
    routeEligible: true,
    sessionName: status?.sessionName || thread.runtime?.sessionName || thread.executor?.sessionName || null,
    paneId: status?.paneId || thread.runtime?.paneId || thread.executor?.tmuxTarget || null,
    tmuxTarget: status?.paneId || thread.runtime?.paneId || thread.executor?.tmuxTarget || null,
    runtime: status?.lease ? { ...(thread.runtime || {}), ...status.lease, state } : thread.runtime || null,
    activeRuntimeLeaseId: status?.lease?.id || thread.activeRuntimeLeaseId || null,
    promptReady: status?.promptReady ?? ready,
    promptReadyStable: status?.promptReadyStable ?? ready,
    working: status?.working ?? state === "working",
    foregroundWorking: status?.foregroundWorking ?? state === "working",
    typingActive: status?.typingActive ?? state === "working",
    backgroundWork: status?.backgroundWork ?? false,
    awaitingInput: !!pendingQuestion,
    awaitingInputEventId: pendingQuestion?.eventId || null,
    pendingQuestion,
    pendingCount: status?.pendingCount ?? 0,
    runningCount: status?.runningCount ?? 0,
    awaitingAckCount,
    nextDeliveryAttemptAt: status?.nextDeliveryAttemptAt ?? null,
    historyState: "ready",
    staleWorking: false,
    staleWorkingReason: null,
    staleWorkingSince: null,
    publicStatus: awaitingAckCount > 0 ? "Awaiting ack" : ready ? "Ready" : state === "sleeping" ? "Sleeping" : state,
    publicStatusCode: awaitingAckCount > 0 ? "awaiting_ack" : ready ? "ready" : state,
    hibernated: state === "sleeping",
    lastActivityAt,
    threadUpdatedAt: thread.updatedAt || lastActivityAt,
    inferredThreadId: resolvedCodexThreadId || null,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    ...codexMetadata(codexThread),
  };
  if (ttlMs > 0 && thread?.id) {
    threadSummaryCache.set(String(thread.id), { cacheKey, expiresAt: Date.now() + ttlMs, summary });
  }
  return summary;
}

export async function threadSummaryPayload(options: ThreadSummaryOptions = {}) {
  const cacheTtlMs = Number(options.cacheTtlMs ?? threadSummaryCacheTtlMs()) || 0;
  const threads = await listThreads();
  const activeThreadIds = new Set(threads.map((thread: any) => String(thread?.id || "")).filter(Boolean));
  for (const id of threadSummaryCache.keys()) {
    if (!activeThreadIds.has(id)) threadSummaryCache.delete(id);
  }
  return {
    generatedAt: new Date().toISOString(),
    threads: await Promise.all(threads.map(async (thread: any) => threadRuntimeSummary(
      thread,
      await listThreadMessages(thread.id),
      { cacheTtlMs },
    ))),
  };
}
