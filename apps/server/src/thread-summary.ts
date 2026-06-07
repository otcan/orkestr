import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeCodexModel, normalizeReasoningEffort } from "../../../packages/core/src/codex-app-server-common.js";
import { RAW_TERMINAL_RUNTIME_KIND } from "../../../packages/core/src/raw-terminal-mode.js";
import { resolveCodexThreadMetadata, runtimeStatus } from "../../../packages/core/src/runtime-leases.js";
import { isAdminPrincipal, resourceOwnerUserId } from "../../../packages/core/src/policy.js";
import { adminPrincipal } from "../../../packages/core/src/principal.js";
import { getThread, listThreadMessages, listThreads, listThreadsForPrincipal } from "../../../packages/core/src/threads.js";
import { detectThreadGitState } from "../../../packages/core/src/thread-workers.js";
import { defaultAdminUser, normalizeUserId } from "../../../packages/core/src/users.js";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { visibleThreadMessages } from "../../../packages/core/src/thread-message-visibility.js";

type ThreadSummaryOptions = {
  cacheTtlMs?: number;
  payloadCacheTtlMs?: number;
  includeAllUserThreads?: boolean;
  principal?: Record<string, any> | null;
};

type ThreadRuntimeMode =
  | "codex-api"
  | "codex-tmux"
  | "attached-terminal"
  | "agent"
  | "sleeping"
  | "unknown";

const threadMetadataCache = new Map<string, {
  cacheKey: string;
  expiresAt: number;
  gitState: Record<string, unknown>;
  liveCodexMetadata: Record<string, unknown>;
}>();

let threadSummaryPayloadCache: {
  cacheKey: string;
  expiresAt: number;
  staleExpiresAt: number;
  payload: Record<string, unknown> | null;
  inFlight: Promise<Record<string, unknown>> | null;
} = {
  cacheKey: "",
  expiresAt: 0,
  staleExpiresAt: 0,
  payload: null,
  inFlight: null,
};

export function resetThreadSummaryCachesForTest(): void {
  threadMetadataCache.clear();
  threadSummaryPayloadCache = {
    cacheKey: "",
    expiresAt: 0,
    staleExpiresAt: 0,
    payload: null,
    inFlight: null,
  };
}

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

function latestStoredMessageEntry(messages: any[] = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(compareMessagesByTime)
    .at(-1) || null;
}

function latestStoredMessage(messages: any[] = []) {
  return latestStoredMessageEntry(messages)?.message || null;
}

function chronologicalMessages(messages: any[] = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(compareMessagesByTime)
    .map(({ message }) => message);
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

function planImplementationPendingQuestion(thread: any, status: any) {
  if (!status?.planImplementationMenuVisible) return null;
  return {
    text: [
      "Codex is asking what to do with the proposed plan.",
      "",
      "1. Implement this plan",
      "2. Clear context and implement",
      "3. Stay in Plan mode",
      "",
      "Reply with 1, 2, or 3. Use /code to close this prompt and switch to coding.",
    ].join("\n"),
    eventId: `codex-plan-implementation:${thread?.id || "thread"}:${status?.paneId || "pane"}`,
    messageId: null,
    cursor: null,
    timestamp: status?.progress?.capturedAt || null,
    phase: "implementation_choice",
  };
}

function latestMessageSummary(messages: any[] = []) {
  const latestEntry = latestStoredMessageEntry(visibleThreadMessages(messages));
  const message = latestEntry?.message || null;
  if (!message) {
    return {
      lastMessageAt: null,
      lastMessageCursor: null,
      lastMessageId: null,
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
    lastMessageCursor: messageCursor(message, latestEntry?.index ?? 0),
    lastMessageId: String(message?.id || message?.eventId || "").trim() || null,
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
  const runtimeKind = String(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.transport || metadata.runtimeKind || metadata.transport || "").trim();
  if (runtimeKind === "api-agent" || metadata.runtimeKind === "api-agent") {
    return {
      codexMode: null,
      codexModeLabel: null,
      codexModeRaw: null,
      codexModeSource: null,
      codexModeUpdatedAt: null,
      desiredCodexMode: null,
      desiredCodexModeUpdatedAt: null,
      codexModel: thread?.apiAgentModel || process.env.ORKESTR_API_AGENT_MODEL || "gpt-5-mini",
      codexModelProvider: "openai-api",
      codexReasoningEffort: null,
      codexModelUpdatedAt: null,
      codexContextWindow: null,
      codexTokenUsage: null,
      codexTotalTokenUsage: null,
      codexRateLimits: null,
      runtimeKind: "api-agent",
      codexSessionId: null,
      importedFromCodex: false,
    };
  }
  const tokenUsage = thread?.codexTokenUsage || metadata.codexTokenUsage || metadata.tokenUsage || null;
  const totalTokenUsage = thread?.codexTotalTokenUsage || metadata.codexTotalTokenUsage || metadata.totalTokenUsage || null;
  const contextWindow = Number(thread?.codexContextWindow || metadata.codexContextWindow || metadata.contextWindow || 0) || null;
  const rateLimits = thread?.codexRateLimits || metadata.codexRateLimits || metadata.rateLimits || null;
  const provider = [thread?.codexModelProvider, metadata.codexModelProvider]
    .map((value) => String(value || "").trim())
    .find((value) => value && !value.startsWith("/") && !value.toLowerCase().endsWith(".jsonl"));
  return {
    codexMode: thread?.codexMode || metadata.codexMode || null,
    codexModeLabel: thread?.codexModeLabel || metadata.codexModeLabel || null,
    codexModeRaw: thread?.codexModeRaw || metadata.codexModeRaw || null,
    codexModeSource: thread?.codexModeSource || metadata.codexModeSource || null,
    codexModeUpdatedAt: thread?.codexModeUpdatedAt || metadata.codexModeUpdatedAt || null,
    desiredCodexMode: null,
    desiredCodexModeUpdatedAt: null,
    codexModel: [thread?.codexModel, metadata.codexModel, process.env.ORKESTR_DEFAULT_CODEX_MODEL, process.env.OPENAI_MODEL].map(normalizeCodexModel).find(Boolean) || null,
    codexModelProvider: provider || "codex",
    codexReasoningEffort: [thread?.codexReasoningEffort, metadata.codexReasoningEffort, process.env.ORKESTR_DEFAULT_CODEX_REASONING].map(normalizeReasoningEffort).find(Boolean) || null,
    codexModelUpdatedAt: thread?.codexModelUpdatedAt || metadata.codexModelUpdatedAt || null,
    codexContextWindow: contextWindow,
    codexTokenUsage: tokenUsage,
    codexTotalTokenUsage: totalTokenUsage,
    codexRateLimits: rateLimits,
    runtimeKind: runtimeKind === "app-server" || runtimeKind === "codex-app-server"
      ? "codex-app-server"
      : runtimeKind === RAW_TERMINAL_RUNTIME_KIND || metadata.terminalMode === RAW_TERMINAL_RUNTIME_KIND
        ? RAW_TERMINAL_RUNTIME_KIND
        : runtimeKind === "codex-tmux"
          ? "codex-tmux"
          : runtimeKind === "tmux"
            ? "migration_required"
          : null,
    codexSessionId: thread?.codexSessionId || thread?.executor?.codexSessionId || metadata.codexSessionId || null,
    importedFromCodex: thread?.importedFromCodex === true || metadata.importedFromCodex === true,
  };
}

function codexModeValue(value: any): string | null {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "code" || mode === "plan" ? mode : null;
}

function persistedCodexMode(metadata: any): { mode: string | null; source: string | null } {
  const mode = codexModeValue(metadata?.codexMode);
  const source = String(metadata?.codexModeSource || "").trim() || null;
  if (mode === "plan" && source === "orkestr-wake-restore") {
    return { mode: "code", source: null };
  }
  return { mode, source: mode ? source : null };
}

function threadSummaryCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 120_000;
}

function threadSummaryPayloadCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5000;
}

function threadSummaryStalePayloadTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_STALE_PAYLOAD_TTL_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 30_000;
}

function threadSummaryMessagesLimit(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_MESSAGES_LIMIT || 200);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 200;
}

function threadSummarySlowMs(): number {
  const parsed = Number(process.env.ORKESTR_THREAD_SUMMARY_SLOW_MS || 1500);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1500;
}

async function listThreadSummaryScope(principal: Record<string, any> | null, includeAllUserThreads: boolean) {
  const effectivePrincipal = principal || adminPrincipal(defaultAdminUser());
  if (includeAllUserThreads || !isAdminPrincipal(effectivePrincipal)) {
    return listThreadsForPrincipal(effectivePrincipal);
  }

  const ownerUserId = normalizeUserId(effectivePrincipal.userId || defaultAdminUser().id);
  const threads = await listThreads();
  return threads.filter((thread: any) => resourceOwnerUserId(thread) === ownerUserId);
}

async function listThreadMessagesForSummary(threadId: string) {
  const messages = await listThreadMessages(threadId);
  const limit = threadSummaryMessagesLimit();
  if (limit <= 0 || messages.length <= limit) return messages;
  const tailStart = Math.max(0, messages.length - limit);
  const tail = messages.slice(tailStart);
  const preserveStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
  const preserved = messages.slice(0, tailStart).filter((message) => {
    const role = String(message?.role || message?.kind || "").trim().toLowerCase();
    const state = String(message?.state || "").trim().toLowerCase();
    return (role === "user" && preserveStates.has(state)) || isNeedInputMessage(message);
  });
  return [...preserved, ...tail];
}

function storeThreadSummaryPayload(
  cacheKey: string,
  payload: Record<string, unknown>,
  payloadCacheTtlMs: number,
  stalePayloadTtlMs: number,
) {
  if (payloadCacheTtlMs <= 0) return;
  const now = Date.now();
  threadSummaryPayloadCache = {
    cacheKey,
    expiresAt: now + payloadCacheTtlMs,
    staleExpiresAt: now + payloadCacheTtlMs + stalePayloadTtlMs,
    payload,
    inFlight: null,
  };
}

function keepStaleThreadSummaryPayload(
  cacheKey: string,
  stalePayloadTtlMs: number,
  computePayload: Promise<Record<string, unknown>>,
) {
  if (threadSummaryPayloadCache.inFlight !== computePayload) return false;
  const keepPayload = threadSummaryPayloadCache.cacheKey === cacheKey ? threadSummaryPayloadCache.payload : null;
  threadSummaryPayloadCache = {
    cacheKey: keepPayload ? cacheKey : "",
    expiresAt: 0,
    staleExpiresAt: keepPayload && stalePayloadTtlMs > 0 ? Date.now() + stalePayloadTtlMs : 0,
    payload: keepPayload,
    inFlight: null,
  };
  return Boolean(keepPayload);
}

function summaryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown_error");
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const transientRuntimeStates = new Set(["pending", "processing", "running", "waking", "working"]);

function hasOpenRuntimeLease(thread: any): boolean {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return Boolean(
    thread?.activeRuntimeLeaseId ||
    runtime.activeRuntimeLeaseId ||
    (runtime.id && !runtime.endedAt && !runtime.ended_at),
  );
}

function threadSummaryState(thread: any, status: any): string {
  const state = nonEmptyString(status?.state) || nonEmptyString(thread?.state) || "sleeping";
  if (status) return state;
  return transientRuntimeStates.has(state.toLowerCase()) && !hasOpenRuntimeLease(thread) ? "sleeping" : state;
}

function hasOwnKey(value: any, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function cleanRuntimeValue(value: any): string {
  return String(value || "").trim();
}

function lowerRuntimeValue(value: any): string {
  return cleanRuntimeValue(value).toLowerCase();
}

function firstRuntimeValue(...values: any[]): string {
  for (const value of values) {
    const clean = cleanRuntimeValue(value);
    if (clean) return clean;
  }
  return "";
}

function threadRuntimeControlSummary(input: {
  thread: any;
  status: any;
  runtime: any;
  state: string;
  runtimeKind: string | null;
  sessionName: string | null;
  paneId: string | null;
  codexAppServerTransport: string | null;
  codexAppServerSocket: string | null;
}): Record<string, unknown> {
  const metadata = input.thread?.executor?.metadata && typeof input.thread.executor.metadata === "object" ? input.thread.executor.metadata : {};
  const runtimeKind = lowerRuntimeValue(firstRuntimeValue(
    input.runtimeKind,
    input.status?.runtimeKind,
    input.status?.runtimeState,
    input.runtime?.runtimeKind,
    input.thread?.runtimeKind,
    input.thread?.executor?.transport,
    metadata.runtimeKind,
    metadata.transport,
  ));
  const executorType = lowerRuntimeValue(input.thread?.executor?.type || input.thread?.executor?.id);
  const transport = lowerRuntimeValue(firstRuntimeValue(
    input.codexAppServerTransport,
    input.status?.transport,
    input.thread?.executor?.transport,
    metadata.transport,
    input.runtime?.transport,
    runtimeKind,
  ));
  const terminalMode = lowerRuntimeValue(firstRuntimeValue(input.runtime?.terminalMode, input.thread?.terminalMode, metadata.terminalMode));
  const paneAvailable = Boolean(cleanRuntimeValue(input.paneId));
  const terminalAttached = runtimeKind === RAW_TERMINAL_RUNTIME_KIND || transport === RAW_TERMINAL_RUNTIME_KIND || terminalMode === RAW_TERMINAL_RUNTIME_KIND;
  const isCodexAppServer = runtimeKind === "codex-app-server" || runtimeKind === "app-server" || transport === "codex-app-server" || transport === "app-server" || Boolean(input.codexAppServerSocket);
  const isAgentRuntime = runtimeKind === "api-agent" || executorType === "api-agent";
  const isCodexTmux = !terminalAttached && !isCodexAppServer && !isAgentRuntime && (
    runtimeKind === "codex-tmux" ||
    runtimeKind === "migration_required" ||
    transport === "tmux" ||
    transport === "codex-tmux" ||
    paneAvailable
  );

  let runtimeMode: ThreadRuntimeMode = "unknown";
  let runtimeModeLabel = "Runtime unknown";
  let runtimeControlPath = "unknown";
  let runtimeTransport = transport || runtimeKind || null;

  if (isCodexAppServer) {
    runtimeMode = "codex-api";
    runtimeModeLabel = "Codex API";
    runtimeControlPath = "app-server";
    runtimeTransport = input.codexAppServerTransport || "codex-app-server";
  } else if (terminalAttached) {
    runtimeMode = "attached-terminal";
    runtimeModeLabel = "Attached terminal";
    runtimeControlPath = "raw-terminal";
    runtimeTransport = RAW_TERMINAL_RUNTIME_KIND;
  } else if (isAgentRuntime) {
    runtimeMode = "agent";
    runtimeModeLabel = "Agent";
    runtimeControlPath = "agent-api";
    runtimeTransport = "api-agent";
  } else if (isCodexTmux) {
    runtimeMode = "codex-tmux";
    runtimeModeLabel = "Codex tmux";
    runtimeControlPath = "tmux-pane";
    runtimeTransport = "tmux";
  } else if (input.state === "sleeping") {
    runtimeMode = "sleeping";
    runtimeModeLabel = "Sleeping";
    runtimeControlPath = "none";
  }

  return {
    runtimeMode,
    runtimeModeLabel,
    runtimeControlPath,
    runtimeTransport,
    isCodexAppServer,
    isCodexTmux,
    isAgentRuntime,
    terminalAttached,
    rawTerminalActive: terminalAttached,
    paneAvailable,
  };
}

export function threadSummaryRuntimeSnapshot(thread: any, status: any, state: string): any {
  const stored = thread?.runtime && typeof thread.runtime === "object" ? { ...thread.runtime } : null;
  if (!status) return stored;
  if (!stored && !status?.lease) return null;
  const runtime = {
    ...(stored || {}),
    ...(status?.lease || {}),
    state,
  };
  if (hasOwnKey(status, "codexStatus")) runtime.codexStatus = status.codexStatus || null;
  if (hasOwnKey(status, "activeTurnId")) runtime.activeTurnId = status.activeTurnId || null;
  if (hasOwnKey(status, "pendingRequest")) runtime.pendingRequest = status.pendingRequest || null;
  return runtime;
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
  const status: any = await runtimeStatus(thread.id, process.env, messages).catch(() => null);
  const { gitState, liveCodexMetadata } = await cachedThreadMetadata(thread, status, ttlMs);
  const orderedMessages = chronologicalMessages(messages);
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
  const state = threadSummaryState(thread, status);
  const ready = state === "ready";
  const inferredWorking = Boolean(status && state === "working");
  const awaitingAckCount = status?.awaitingAckCount ?? 0;
  const latestMessage = latestMessageSummary(orderedMessages);
  const planAvailable = latestAssistantPlanAvailable(orderedMessages);
  const lastActivityAt = latestMessage.lastMessageAt || thread.updatedAt || thread.createdAt || null;
  const pendingQuestion = planImplementationPendingQuestion(thread, status) || latestPendingQuestion(orderedMessages);
  const resolvedCodexThreadId = codexThreadId(codexThread);
  const metadata = codexMetadata(codexThread);
  const liveCodexMode = codexModeValue(status?.codexMode);
  const liveCodexModeSource = String(status?.codexModeSource || "").trim();
  const storedCodexMode = persistedCodexMode(metadata);
  const progress = status?.progress || thread.runtime?.progress || null;
  const runtime = threadSummaryRuntimeSnapshot(thread, status, state);
  const turnLifecycle = status?.turnLifecycle || runtime?.turnLifecycle || null;
  const codexStatus = hasOwnKey(status, "codexStatus") ? status?.codexStatus || null : thread.runtime?.codexStatus || null;
  const activeTurnId = hasOwnKey(status, "activeTurnId") ? status?.activeTurnId || null : thread.runtime?.activeTurnId || null;
  const runtimeKind = metadata.runtimeKind || (resolvedCodexThreadId ? "migration_required" : null);
  const sessionName = status?.sessionName || thread.runtime?.sessionName || thread.executor?.sessionName || null;
  const paneId = status?.paneId || thread.runtime?.paneId || thread.executor?.tmuxTarget || null;
  const codexAppServerTransport = status?.codexAppServerTransport || null;
  const codexAppServerSocket = status?.codexAppServerSocket || null;
  const runtimeControl = threadRuntimeControlSummary({
    thread,
    status,
    runtime,
    state,
    runtimeKind,
    sessionName,
    paneId,
    codexAppServerTransport,
    codexAppServerSocket,
  });
  const summary = {
    ...thread,
    ...gitState,
    threadId: resolvedCodexThreadId || thread.id,
    codexThreadId: resolvedCodexThreadId || null,
    status: state,
    state,
    routeEligible: true,
    sessionName,
    paneId,
    tmuxTarget: paneId,
    runtime: runtime ? { ...runtime, ...runtimeControl } : runtime,
    turnLifecycle,
    activeRuntimeLeaseId: status?.lease?.id || thread.activeRuntimeLeaseId || null,
    promptReady: status?.promptReady ?? ready,
    promptReadyStable: status?.promptReadyStable ?? ready,
    working: status?.working ?? inferredWorking,
    foregroundWorking: status?.foregroundWorking ?? inferredWorking,
    typingActive: status?.typingActive ?? inferredWorking,
    backgroundWork: status?.backgroundWork ?? false,
    awaitingInput: !!pendingQuestion,
    awaitingInputEventId: pendingQuestion?.eventId || null,
    pendingQuestion,
    pendingCount: status?.pendingCount ?? 0,
    runningCount: status?.runningCount ?? 0,
    awaitingAckCount,
    nextDeliveryAttemptAt: status?.nextDeliveryAttemptAt ?? null,
    progress,
    progressSummary: progress?.summary || null,
    progressStateHint: progress?.stateHint || null,
    progressTailLines: Array.isArray(progress?.tailLines) ? progress.tailLines : [],
    progressCapturedAt: progress?.capturedAt || null,
    historyState: "ready",
    staleWorking: false,
    staleWorkingReason: null,
    staleWorkingSince: null,
    publicStatus: awaitingAckCount > 0 ? "Awaiting ack" : ready ? "Ready" : state === "sleeping" ? "Sleeping" : state === "unloaded" ? "Unloaded" : state,
    publicStatusCode: awaitingAckCount > 0 ? "awaiting_ack" : ready ? "ready" : state,
    hibernated: state === "sleeping",
    ...latestMessage,
    lastActivityAt,
    threadUpdatedAt: thread.updatedAt || lastActivityAt,
    inferredThreadId: resolvedCodexThreadId || null,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    ...metadata,
    runtimeKind,
    ...runtimeControl,
    codexAppServerTransport,
    codexAppServerSocket,
    codexSessionId: metadata.codexSessionId || null,
    codexStatus,
    activeTurnId,
    importedFromCodex: metadata.importedFromCodex,
    migrationRequired: Boolean(status?.migrationRequired),
    planAvailable,
    planImplementationReady: Boolean(status?.planImplementationReady),
    planImplementationMenuVisible: Boolean(status?.planImplementationMenuVisible),
    codexMode: liveCodexMode || storedCodexMode.mode,
    codexModeSource: liveCodexModeSource || storedCodexMode.source,
    codexModeLive: liveCodexMode,
  };
  return summary;
}

export async function threadSummaryPayload(options: ThreadSummaryOptions = {}) {
  const cacheTtlMs = Number(options.cacheTtlMs ?? threadSummaryCacheTtlMs()) || 0;
  const payloadCacheTtlMs = Number(options.payloadCacheTtlMs ?? threadSummaryPayloadCacheTtlMs()) || 0;
  const stalePayloadTtlMs = threadSummaryStalePayloadTtlMs();
  const principal = options.principal || null;
  const includeAllUserThreads = options.includeAllUserThreads === true;
  const effectivePrincipal = principal || adminPrincipal(defaultAdminUser());
  const payloadCacheKey = JSON.stringify({
    cacheTtlMs,
    home: process.env.ORKESTR_HOME || "",
    includeAllUserThreads,
    userId: effectivePrincipal?.userId || "admin",
    role: effectivePrincipal?.role || "admin",
  });
  const now = Date.now();
  if (
    payloadCacheTtlMs > 0 &&
    threadSummaryPayloadCache.cacheKey === payloadCacheKey &&
    threadSummaryPayloadCache.payload &&
    threadSummaryPayloadCache.expiresAt > now
  ) {
    return threadSummaryPayloadCache.payload;
  }
  const stalePayloadAvailable = Boolean(
    payloadCacheTtlMs > 0 &&
    stalePayloadTtlMs > 0 &&
    threadSummaryPayloadCache.cacheKey === payloadCacheKey &&
    threadSummaryPayloadCache.payload &&
    threadSummaryPayloadCache.staleExpiresAt > now,
  );
  const stalePayload = stalePayloadAvailable ? threadSummaryPayloadCache.payload : null;
  const inFlightPayload = threadSummaryPayloadCache.inFlight;
  if (
    payloadCacheTtlMs > 0 &&
    threadSummaryPayloadCache.cacheKey === payloadCacheKey &&
    inFlightPayload
  ) {
    return stalePayload || inFlightPayload;
  }
  const computePayload = (async () => {
    const startedAt = Date.now();
    const threads = await listThreadSummaryScope(effectivePrincipal, includeAllUserThreads);
    const activeThreadIds = new Set(threads.map((thread: any) => String(thread?.id || "")).filter(Boolean));
    for (const id of threadMetadataCache.keys()) {
      if (!activeThreadIds.has(id)) threadMetadataCache.delete(id);
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      threads: await Promise.all(threads.map(async (thread: any) => threadRuntimeSummary(
        thread,
        await listThreadMessagesForSummary(thread.id),
        { cacheTtlMs },
      ))),
    };
    const durationMs = Date.now() - startedAt;
    const slowMs = threadSummarySlowMs();
    if (slowMs > 0 && durationMs >= slowMs) {
      await appendEvent({
        type: "thread_summary_slow",
        durationMs,
        threadCount: threads.length,
        cacheTtlMs,
        payloadCacheTtlMs,
        includeAllUserThreads,
        ownerUserId: effectivePrincipal?.userId || null,
      }).catch(() => {});
    }
    return payload;
  })();
  if (payloadCacheTtlMs > 0) {
    const priorPayload = threadSummaryPayloadCache.cacheKey === payloadCacheKey ? threadSummaryPayloadCache.payload : null;
    threadSummaryPayloadCache = {
      cacheKey: payloadCacheKey,
      expiresAt: 0,
      staleExpiresAt: priorPayload && stalePayloadTtlMs > 0 ? Date.now() + stalePayloadTtlMs : 0,
      payload: priorPayload,
      inFlight: computePayload,
    };
    if (priorPayload && stalePayloadTtlMs > 0) {
      void computePayload
        .then((payload) => {
          if (threadSummaryPayloadCache.inFlight === computePayload) {
            storeThreadSummaryPayload(payloadCacheKey, payload, payloadCacheTtlMs, stalePayloadTtlMs);
          }
        })
        .catch((error) => {
          const stalePayloadKept = keepStaleThreadSummaryPayload(payloadCacheKey, stalePayloadTtlMs, computePayload);
          void appendEvent({
            type: "thread_summary_refresh_failed",
            error: summaryErrorMessage(error),
            stalePayloadKept,
            includeAllUserThreads,
            ownerUserId: effectivePrincipal?.userId || null,
          }).catch(() => {});
        });
      return priorPayload;
    }
  }
  try {
    const payload = await computePayload;
    if (payloadCacheTtlMs > 0) {
      storeThreadSummaryPayload(payloadCacheKey, payload, payloadCacheTtlMs, stalePayloadTtlMs);
    }
    return payload;
  } catch (error) {
    let stalePayloadKept = false;
    if (threadSummaryPayloadCache.inFlight === computePayload) {
      stalePayloadKept = keepStaleThreadSummaryPayload(payloadCacheKey, stalePayloadTtlMs, computePayload);
    }
    await appendEvent({
      type: "thread_summary_refresh_failed",
      error: summaryErrorMessage(error),
      stalePayloadKept,
      includeAllUserThreads,
      ownerUserId: effectivePrincipal?.userId || null,
    }).catch(() => {});
    throw error;
  }
}
