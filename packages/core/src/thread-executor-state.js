import { threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
import { codexSessionId, codexThreadId } from "./codex-app-server-common.js";

// Pure executor-state helpers for in-place executor switching. A thread has
// exactly one active executor; the inactive executor's resumable settings
// live in thread.executorStates[<executor>] and never include secrets.

export const EXECUTOR_CODEX = "codex";
export const EXECUTOR_CLAUDE = "claude-code";
export const SWITCHABLE_EXECUTORS = [EXECUTOR_CODEX, EXECUTOR_CLAUDE];

const codexRolloutFields = [
  "codexRolloutPath",
  "codexRolloutGeneration",
  "codexRolloutOffset",
  "codexRolloutSyncedAt",
  "codexRolloutSyncError",
  "codexRolloutValidation",
];
const codexSettingFields = [
  "codexModel",
  "codexModelProvider",
  "codexReasoningEffort",
  "codexServiceTier",
  "codexContextWindow",
  "codexTokenUsage",
  "codexRateLimits",
];

// Top-level thread fields owned by one executor. They are deleted (not
// nulled) when that executor stops being active.
export const CODEX_THREAD_FIELDS = ["codexThreadId", "codexSessionId", ...codexRolloutFields, ...codexSettingFields];
export const CLAUDE_THREAD_FIELDS = [
  "claudeModel",
  "claudeEffort",
  "claudePermissionMode",
  "claudeModelUpdatedAt",
  "claudeModelResolved",
  "claudeTokenUsage",
  "claudeRateLimits",
  "claudeContextWindow",
];
const CODEX_EXECUTOR_FIELDS = ["codexThreadId", "codexSessionId", "transport", "sessionName", "tmuxTarget"];
const CODEX_METADATA_FIELDS = [
  "codexThreadId",
  "codexSessionId",
  ...codexRolloutFields,
  ...codexSettingFields,
  "previousCodexGeneration",
  "codexGenerationChangedAt",
  "transport",
  "runtimeKind",
  "terminalMode",
];
const CLAUDE_EXECUTOR_FIELDS = ["accountProfileId", "transport"];
const CLAUDE_METADATA_FIELDS = ["accountProfileId", "claudeModel", "claudeEffort", "claudePermissionMode", "runtimeKind", "transport"];

export function clean(value = "") {
  return String(value || "").trim();
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function withoutKeys(value, keys) {
  const next = { ...record(value) };
  for (const key of keys) delete next[key];
  return next;
}

function definedEntries(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

export function normalizeExecutorTarget(value = "") {
  const token = clean(value).toLowerCase();
  if (["claude", "claude-code", "claude_code", "claudecode", "anthropic"].includes(token)) return EXECUTOR_CLAUDE;
  if (["codex", "openai", "codex-app-server"].includes(token)) return EXECUTOR_CODEX;
  return "";
}

export function activeThreadExecutor(thread = {}) {
  if (threadUsesClaudeCode(thread)) return EXECUTOR_CLAUDE;
  const runtimeKind = clean(thread.runtimeKind || thread.runtime?.runtimeKind || thread.executor?.metadata?.runtimeKind).toLowerCase();
  if (runtimeKind === "api-agent" || clean(thread.executor?.type).toLowerCase() === "api-agent") return "api-agent";
  return EXECUTOR_CODEX;
}

export function claudeProfileIdForThread(thread = {}) {
  return clean(thread.executor?.accountProfileId || thread.executor?.metadata?.accountProfileId);
}

export function currentExecutorSettings(thread = {}, executor = activeThreadExecutor(thread)) {
  const metadata = record(thread.executor?.metadata);
  if (executor === EXECUTOR_CLAUDE) {
    return {
      model: clean(thread.claudeModel || metadata.claudeModel) || null,
      effort: clean(thread.claudeEffort || metadata.claudeEffort) || null,
      profileId: claudeProfileIdForThread(thread) || null,
      permissionMode: clean(thread.claudePermissionMode || metadata.claudePermissionMode) || null,
    };
  }
  return {
    model: clean(thread.codexModel || metadata.codexModel) || null,
    effort: clean(thread.codexReasoningEffort || metadata.codexReasoningEffort) || null,
    profileId: null,
    permissionMode: null,
  };
}

export function snapshotExecutorState(thread = {}, executor, now = new Date().toISOString()) {
  const metadata = record(thread.executor?.metadata);
  const runtime = record(thread.runtime);
  if (executor === EXECUTOR_CLAUDE) {
    return definedEntries({
      executor,
      accountProfileId: claudeProfileIdForThread(thread),
      claudeModel: clean(thread.claudeModel || metadata.claudeModel),
      claudeEffort: clean(thread.claudeEffort || metadata.claudeEffort),
      claudePermissionMode: clean(thread.claudePermissionMode || metadata.claudePermissionMode),
      savedAt: now,
      lastActiveAt: now,
    });
  }
  return definedEntries({
    executor,
    codexThreadId: codexThreadId(thread),
    codexSessionId: codexSessionId(thread),
    codexModel: clean(thread.codexModel || metadata.codexModel),
    codexReasoningEffort: clean(thread.codexReasoningEffort || metadata.codexReasoningEffort),
    codexServiceTier: clean(thread.codexServiceTier || metadata.codexServiceTier),
    codexModelProvider: clean(thread.codexModelProvider || metadata.codexModelProvider),
    codexRolloutPath: clean(thread.codexRolloutPath || metadata.codexRolloutPath || runtime.operatorRolloutPath),
    savedAt: now,
    lastActiveAt: now,
  });
}

// Remove every copy of the leaving executor's routing identity. Codex ids in
// any location make isCodexRuntimeThread() true, so none may survive.
export function cleanedExecutorObjects(thread = {}, leaving) {
  const executorKeys = leaving === EXECUTOR_CLAUDE ? CLAUDE_EXECUTOR_FIELDS : CODEX_EXECUTOR_FIELDS;
  const metadataKeys = leaving === EXECUTOR_CLAUDE ? CLAUDE_METADATA_FIELDS : CODEX_METADATA_FIELDS;
  const executor = withoutKeys(thread.executor, [...executorKeys, "metadata"]);
  const metadata = withoutKeys(thread.executor?.metadata, metadataKeys);
  return { executor, metadata };
}

export function leavingThreadFields(leaving) {
  return leaving === EXECUTOR_CLAUDE ? [...CLAUDE_THREAD_FIELDS] : [...CODEX_THREAD_FIELDS];
}

function truthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

// A thread first moved to Claude inherits the Codex side's access level: a
// full-access, no-approval Codex thread gets Claude's bypassPermissions mode
// when the host allows it; anything else starts at acceptEdits. A thread that
// ran on Claude before keeps its previous mode.
export function defaultClaudePermissionMode(thread = {}, env = process.env) {
  if (!truthyFlag(env.ORKESTR_CLAUDE_CODE_ALLOW_BYPASS_PERMISSIONS)) return "acceptEdits";
  const metadata = thread?.executor?.metadata || {};
  const sandbox = clean(thread.codexSandbox || metadata.codexSandbox || env.ORKESTR_CODEX_SANDBOX).toLowerCase();
  const approval = clean(thread.codexApprovalPolicy || metadata.codexApprovalPolicy || env.ORKESTR_CODEX_APPROVAL_POLICY).toLowerCase();
  return sandbox === "danger-full-access" && approval === "never" ? "bypassPermissions" : "acceptEdits";
}

export function claudeTargetPatch(thread, { profileId, model, effort, restore = {}, env = process.env }) {
  const { executor, metadata } = cleanedExecutorObjects(thread, EXECUTOR_CODEX);
  const permissionMode = clean(restore.claudePermissionMode) || defaultClaudePermissionMode(thread, env);
  const settings = definedEntries({ claudeModel: clean(model), claudeEffort: clean(effort) });
  return {
    state: "ready",
    lastError: null,
    executorId: EXECUTOR_CLAUDE,
    runtimeKind: EXECUTOR_CLAUDE,
    claudePermissionMode: permissionMode,
    ...settings,
    executor: {
      ...executor,
      id: EXECUTOR_CLAUDE,
      type: EXECUTOR_CLAUDE,
      transport: "stream-json",
      accountProfileId: profileId,
      metadata: {
        ...withoutKeys(metadata, CLAUDE_METADATA_FIELDS),
        runtimeKind: EXECUTOR_CLAUDE,
        transport: "stream-json",
        accountProfileId: profileId,
        claudePermissionMode: permissionMode,
        ...settings,
      },
    },
    runtime: { runtimeKind: EXECUTOR_CLAUDE, state: "ready", activeTurnId: null },
  };
}

export function codexTargetPatch(thread, { model, effort, restore = {} }) {
  const { executor, metadata } = cleanedExecutorObjects(thread, EXECUTOR_CLAUDE);
  const id = clean(restore.codexThreadId);
  const sessionId = clean(restore.codexSessionId) || id;
  const identity = id ? { codexThreadId: id, codexSessionId: sessionId } : {};
  const settings = definedEntries({
    codexModel: clean(model),
    codexReasoningEffort: clean(effort),
    codexServiceTier: clean(restore.codexServiceTier),
    codexModelProvider: clean(restore.codexModelProvider),
  });
  return {
    state: "ready",
    lastError: null,
    executorId: EXECUTOR_CODEX,
    runtimeKind: "codex-app-server",
    ...identity,
    ...settings,
    executor: {
      ...withoutKeys(executor, CODEX_EXECUTOR_FIELDS),
      id: EXECUTOR_CODEX,
      type: EXECUTOR_CODEX,
      transport: "app-server",
      ...identity,
      metadata: {
        ...withoutKeys(metadata, CODEX_METADATA_FIELDS),
        runtimeKind: "codex-app-server",
        transport: "app-server",
        ...identity,
        ...settings,
      },
    },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "ready",
      activeTurnId: null,
      pendingRequest: null,
      ...(id ? { ...identity, runtimeGeneration: id } : {}),
    },
  };
}

function publicExecutorState(state = {}) {
  const value = record(state);
  return definedEntries({
    executor: clean(value.executor),
    codexThreadId: clean(value.codexThreadId),
    model: clean(value.codexModel || value.claudeModel),
    effort: clean(value.codexReasoningEffort || value.claudeEffort),
    profileId: clean(value.accountProfileId),
    permissionMode: clean(value.claudePermissionMode),
    savedAt: clean(value.savedAt),
  });
}

export function threadExecutorSummary(thread = {}) {
  const executor = activeThreadExecutor(thread);
  const settings = currentExecutorSettings(thread, executor);
  const states = record(thread.executorStates);
  const pending = record(thread.pendingExecutorSwitch);
  const handoff = record(thread.pendingExecutorHandoff);
  return {
    threadId: thread.id,
    executor,
    runtimeKind: clean(thread.runtimeKind || thread.runtime?.runtimeKind) || null,
    model: settings.model,
    effort: settings.effort,
    profileId: settings.profileId,
    permissionMode: settings.permissionMode,
    codexThreadId: executor === EXECUTOR_CODEX ? codexThreadId(thread) || null : null,
    executorStates: Object.fromEntries(Object.entries(states).map(([key, value]) => [key, publicExecutorState(value)])),
    pendingExecutorSwitch: Object.keys(pending).length ? definedEntries({
      target: clean(pending.target),
      model: clean(pending.model),
      effort: clean(pending.effort),
      profileId: clean(pending.profileId),
      actor: clean(pending.actor),
      reason: clean(pending.reason),
      requestedAt: clean(pending.requestedAt),
    }) : null,
    pendingExecutorHandoff: Object.keys(handoff).length ? definedEntries({
      from: clean(handoff.from),
      to: clean(handoff.to),
      path: clean(handoff.path),
      createdAt: clean(handoff.createdAt),
    }) : null,
    lastExecutorSwitch: thread.lastExecutorSwitch || null,
  };
}
