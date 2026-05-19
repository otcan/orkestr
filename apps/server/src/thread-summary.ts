import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveCodexThreadMetadata, runtimeStatus } from "../../../packages/core/src/runtime-leases.js";
import { getThread, listThreadMessages, listThreads } from "../../../packages/core/src/threads.js";
import { detectThreadGitState } from "../../../packages/core/src/thread-workers.js";

type ThreadSummaryOptions = {
  cacheTtlMs?: number;
  payloadCacheTtlMs?: number;
};

const threadMetadataCache = new Map<string, {
  cacheKey: string;
  expiresAt: number;
  gitState: Record<string, unknown>;
  liveCodexMetadata: Record<string, unknown>;
}>();

let threadSummaryPayloadCache: {
  cacheKey: string;
  expiresAt: number;
  payload: Record<string, unknown> | null;
  inFlight: Promise<Record<string, unknown>> | null;
} = {
  cacheKey: "",
  expiresAt: 0,
  payload: null,
  inFlight: null,
};

export function codexThreadId(thread: any): string {
  return String(thread?.executor?.codexThreadId || thread?.codexThreadId || "").trim();
}

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

function messageTimestampMs(message: any): number {
  const ms = Date.parse(String(message?.timestamp || message?.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function compareMessagesByTime(left: { message: any; index: number }, right: { message: any; index: number }): number {
  const leftMs = messageTimestampMs(left.message);
  const rightMs = messageTimestampMs(right.message);
  if (leftMs && rightMs && leftMs !== rightMs) return leftMs - rightMs;
  if (leftMs !== rightMs) return leftMs - rightMs;
  return messageCursor(left.message, left.index) - messageCursor(right.message, right.index);
}

function latestStoredMessage(messages: any[] = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(compareMessagesByTime)
    .at(-1)?.message || null;
}

const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);
const proposedPlanOpenTagPattern = /^\s*<\s*proposed[\s_-]*plan\s*>/i;

function hasProposedPlanEnvelope(value: any): boolean {
  return proposedPlanOpenTagPattern.test(String(value || ""));
}

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

function latestMessageSummary(messages: any[] = []) {
  const message = latestStoredMessage(messages);
  if (!message) {
    return {
      lastMessageAt: null,
      lastMessageRole: null,
      lastMessagePhase: null,
      lastMessageState: null,
      lastMessageDeliveryState: null,
      lastMessageError: null,
    };
  }
  const role = String(message?.role || message?.kind || "").trim().toLowerCase() || null;
  const text = String(message?.text || "");
  const rawPhase = String(message?.phase || (role === "assistant" ? "final_answer" : "")).trim().toLowerCase() || null;
  const phase = role === "assistant" && hasProposedPlanEnvelope(text) ? "plan" : rawPhase;
  return {
    lastMessageAt: message?.timestamp || message?.createdAt || null,
    lastMessageRole: role,
    lastMessagePhase: phase,
    lastMessageState: String(message?.state || "").trim().toLowerCase() || null,
    lastMessageDeliveryState: String(message?.deliveryState || "").trim().toLowerCase() || null,
    lastMessageError: String(message?.error || "").trim() || null,
  };
}

function latestAssistantPlanAvailable(messages: any[] = []): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = String(message?.role || message?.kind || "").trim().toLowerCase();
    const text = String(message?.text || "").trim();
    if (role !== "assistant" || !text) continue;
    const phase = String(message?.phase || "").trim().toLowerCase();
    return phase === "plan" || hasProposedPlanEnvelope(text);
  }
  return false;
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

function codexModeValue(value: any): string | null {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "code" || mode === "plan" ? mode : null;
}

function codexModeSettleMs(): number {
  const configured = Number(process.env.ORKESTR_CODEX_MODE_SETTLE_MS || 10000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 10000;
}

function recentlyAppliedCodexMode(thread: any, metadata: any): string | null {
  if (!thread?.codexModeLiveApplied) return null;
  const mode = codexModeValue(thread?.codexMode || metadata.codexMode);
  if (!mode) return null;
  const source = String(thread?.codexModeSource || metadata.codexModeSource || "").trim();
  if (source !== "orkestr-ui-live" && source !== "runtime-sync-live") return null;
  const updatedAt = Date.parse(String(thread?.codexModeUpdatedAt || metadata.codexModeUpdatedAt || ""));
  if (!Number.isFinite(updatedAt)) return null;
  return Date.now() - updatedAt <= codexModeSettleMs() ? mode : null;
}

function threadSummaryCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 120_000;
}

function threadSummaryPayloadCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5000;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function threadCheckoutPath(thread: any, status: any): string {
  return nonEmptyString(
    thread?.worktreePath ||
    thread?.repoPath ||
    thread?.runtime?.worktreePath ||
    thread?.runtime?.repoPath ||
    status?.lease?.workspace ||
    thread?.runtime?.workspace ||
    thread?.cwd ||
    thread?.workspace,
  );
}

async function readSmallText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8").then((value) => value.trim()).catch(() => "");
}

async function gitDirs(checkoutPath: string): Promise<{ gitDir: string; commonGitDir: string } | null> {
  if (!checkoutPath) return null;
  const dotGit = path.join(checkoutPath, ".git");
  const dotGitStat = await stat(dotGit).catch(() => null);
  if (!dotGitStat) return null;

  let gitDir = "";
  if (dotGitStat.isDirectory()) {
    gitDir = dotGit;
  } else if (dotGitStat.isFile()) {
    const match = (await readSmallText(dotGit)).match(/^gitdir:\s*(.+)$/i);
    if (match) gitDir = path.resolve(checkoutPath, match[1]);
  }
  if (!gitDir) return null;

  const commonDirText = await readSmallText(path.join(gitDir, "commondir"));
  const commonGitDir = commonDirText ? path.resolve(gitDir, commonDirText) : gitDir;
  return { gitDir, commonGitDir };
}

function fullRefName(ref: string, kind: "head" | "remote"): string {
  const normalized = nonEmptyString(ref);
  if (!normalized) return "";
  if (normalized.startsWith("refs/")) return normalized;
  return kind === "remote" ? `refs/remotes/${normalized}` : `refs/heads/${normalized}`;
}

async function gitFileToken(filePath: string, includeContents = false): Promise<string> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) return "";
  const contents = includeContents && fileStat.size <= 4096 ? await readSmallText(filePath) : "";
  return `${filePath}:${fileStat.mtimeMs}:${fileStat.size}:${contents}`;
}

async function ownThreadGitCacheFingerprint(thread: any, status: any): Promise<string> {
  const checkoutPath = threadCheckoutPath(thread, status);
  const dirs = await gitDirs(checkoutPath);
  if (!dirs) return "";

  const headPath = path.join(dirs.gitDir, "HEAD");
  const headText = await readSmallText(headPath);
  const headRef = headText.match(/^ref:\s*(.+)$/)?.[1]?.trim() || "";
  const branchRef = headRef || fullRefName(nonEmptyString(thread?.branchName), "head");
  const remoteRef = fullRefName(nonEmptyString(thread?.remoteBranch), "remote");
  const refPaths = [branchRef, remoteRef]
    .filter(Boolean)
    .flatMap((ref) => [path.join(dirs.gitDir, ref), path.join(dirs.commonGitDir, ref)]);
  const tokenPaths = [
    headPath,
    path.join(dirs.gitDir, "index"),
    path.join(dirs.gitDir, "FETCH_HEAD"),
    path.join(dirs.gitDir, "ORIG_HEAD"),
    path.join(dirs.commonGitDir, "packed-refs"),
    ...refPaths,
  ];
  const tokens = await Promise.all([...new Set(tokenPaths)].map((filePath) => gitFileToken(filePath, true)));
  return JSON.stringify({
    checkoutPath,
    headText,
    tokens: tokens.filter(Boolean),
  });
}

async function threadGitCacheFingerprint(thread: any, status: any): Promise<string> {
  const own = await ownThreadGitCacheFingerprint(thread, status);
  const parentId = nonEmptyString(thread?.parentThreadId);
  const parent = parentId ? await getThread(parentId).catch(() => null) : null;
  const parentFingerprint = parent ? await ownThreadGitCacheFingerprint(parent, null).catch(() => "") : "";
  return JSON.stringify({ own, parent: parentFingerprint });
}

function threadMetadataCacheKey(thread: any, status: any, gitFingerprint = ""): string {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  return JSON.stringify({
    id: thread?.id || null,
    activeRuntimeLeaseId: status?.lease?.id || thread?.activeRuntimeLeaseId || null,
    codexThreadId: thread?.executor?.codexThreadId || thread?.codexThreadId || metadata.codexThreadId || null,
    repoPath: thread?.repoPath || thread?.worktreePath || null,
    workspace: thread?.workspace || thread?.cwd || status?.lease?.workspace || thread?.runtime?.workspace || null,
    branchName: thread?.branchName || null,
    baseCommit: thread?.baseCommit || null,
    baseBranch: thread?.baseBranch || null,
    remoteBranch: thread?.remoteBranch || null,
    executorMetadata: metadata,
    gitFingerprint,
  });
}

async function cachedThreadMetadata(thread: any, status: any, ttlMs: number) {
  const gitFingerprint = ttlMs > 0 ? await threadGitCacheFingerprint(thread, status).catch(() => "") : "";
  const cacheKey = ttlMs > 0 ? threadMetadataCacheKey(thread, status, gitFingerprint) : "";
  const cached = ttlMs > 0 ? threadMetadataCache.get(String(thread?.id || "")) : null;
  if (cached && cached.cacheKey === cacheKey && cached.expiresAt > Date.now()) {
    return { gitState: cached.gitState, liveCodexMetadata: cached.liveCodexMetadata };
  }
  const gitState: any = await detectThreadGitState(thread).catch(() => ({}));
  const metadataTarget = {
    ...thread,
    ...gitState,
    runtime: status?.lease ? { ...(thread.runtime || {}), ...status.lease } : thread.runtime,
  };
  const liveCodexMetadata: any = await resolveCodexThreadMetadata(metadataTarget).catch(() => ({}));
  if (ttlMs > 0 && thread?.id) {
    threadMetadataCache.set(String(thread.id), {
      cacheKey,
      expiresAt: Date.now() + ttlMs,
      gitState,
      liveCodexMetadata,
    });
  }
  return { gitState, liveCodexMetadata };
}

export async function threadRuntimeSummary(thread: any, messages: any[] = [], options: ThreadSummaryOptions = {}) {
  const ttlMs = Number(options.cacheTtlMs ?? 0) || 0;
  const status = await runtimeStatus(thread.id, process.env, messages).catch(() => null);
  const { gitState, liveCodexMetadata } = await cachedThreadMetadata(thread, status, ttlMs);
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
  const latestMessage = latestMessageSummary(messages);
  const planAvailable = latestAssistantPlanAvailable(messages);
  const lastActivityAt = latestMessage.lastMessageAt || thread.updatedAt || thread.createdAt || null;
  const pendingQuestion = latestPendingQuestion(messages);
  const resolvedCodexThreadId = codexThreadId(codexThread);
  const metadata = codexMetadata(codexThread);
  const liveCodexMode = codexModeValue(status?.codexMode);
  const liveCodexModeSource = String(status?.codexModeSource || "").trim();
  const appliedCodexMode = recentlyAppliedCodexMode(thread, metadata);
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
    ...latestMessage,
    lastActivityAt,
    threadUpdatedAt: thread.updatedAt || lastActivityAt,
    inferredThreadId: resolvedCodexThreadId || null,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    ...metadata,
    planAvailable,
    planImplementationReady: Boolean(status?.planImplementationReady),
    planImplementationMenuVisible: Boolean(status?.planImplementationMenuVisible),
    codexMode: appliedCodexMode || liveCodexMode || metadata.codexMode,
    codexModeSource: appliedCodexMode ? metadata.codexModeSource : liveCodexModeSource || metadata.codexModeSource,
    codexModeLive: appliedCodexMode || liveCodexMode,
  };
  return summary;
}

export async function threadSummaryPayload(options: ThreadSummaryOptions = {}) {
  const cacheTtlMs = Number(options.cacheTtlMs ?? threadSummaryCacheTtlMs()) || 0;
  const payloadCacheTtlMs = Number(options.payloadCacheTtlMs ?? threadSummaryPayloadCacheTtlMs()) || 0;
  const payloadCacheKey = JSON.stringify({ cacheTtlMs });
  const now = Date.now();
  if (
    payloadCacheTtlMs > 0 &&
    threadSummaryPayloadCache.cacheKey === payloadCacheKey &&
    threadSummaryPayloadCache.payload &&
    threadSummaryPayloadCache.expiresAt > now
  ) {
    return threadSummaryPayloadCache.payload;
  }
  if (
    payloadCacheTtlMs > 0 &&
    threadSummaryPayloadCache.cacheKey === payloadCacheKey &&
    threadSummaryPayloadCache.inFlight
  ) {
    return threadSummaryPayloadCache.inFlight;
  }
  const computePayload = (async () => {
    const threads = await listThreads();
    const activeThreadIds = new Set(threads.map((thread: any) => String(thread?.id || "")).filter(Boolean));
    for (const id of threadMetadataCache.keys()) {
      if (!activeThreadIds.has(id)) threadMetadataCache.delete(id);
    }
    return {
      generatedAt: new Date().toISOString(),
      threads: await Promise.all(threads.map(async (thread: any) => threadRuntimeSummary(
        thread,
        await listThreadMessages(thread.id),
        { cacheTtlMs },
      ))),
    };
  })();
  if (payloadCacheTtlMs > 0) {
    threadSummaryPayloadCache = {
      cacheKey: payloadCacheKey,
      expiresAt: 0,
      payload: null,
      inFlight: computePayload,
    };
  }
  try {
    const payload = await computePayload;
    if (payloadCacheTtlMs > 0) {
      threadSummaryPayloadCache = {
        cacheKey: payloadCacheKey,
        expiresAt: Date.now() + payloadCacheTtlMs,
        payload,
        inFlight: null,
      };
    }
    return payload;
  } catch (error) {
    if (threadSummaryPayloadCache.inFlight === computePayload) {
      threadSummaryPayloadCache = {
        cacheKey: "",
        expiresAt: 0,
        payload: null,
        inFlight: null,
      };
    }
    throw error;
  }
}
