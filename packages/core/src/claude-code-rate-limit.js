import { claudeCodeLoginStatus } from "./claude-code-client.js";
import { resolveLlmAccountProfile, updateLlmAccountProfileState } from "./llm-account-profiles.js";
import { appendEvent } from "../../storage/src/store.js";
import { updateThread, updateThreadMessage } from "./threads.js";

const recoveryChecks = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function epochMilliseconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function rateLimitWindows(value = {}) {
  const limits = value?.claudeRateLimits || value?.rateLimits || {};
  return [limits.primary, limits.secondary].filter(Boolean);
}

export function claudeCodeRateLimitGate(value = {}, now = Date.now()) {
  const saturated = rateLimitWindows(value)
    .filter((window) => Number(window?.used_percent) >= 100)
    .map((window) => ({
      resetAt: epochMilliseconds(window?.resets_at),
      windowMinutes: Number(window?.window_minutes) || null,
    }));
  if (!saturated.length) return { observed: false, canRecheck: false, retryAt: null, windowMinutes: null };
  const unknownReset = saturated.some((window) => !window.resetAt);
  const future = saturated.filter((window) => window.resetAt > now).sort((left, right) => right.resetAt - left.resetAt);
  const blocking = future[0] || saturated[0];
  return {
    observed: true,
    canRecheck: !unknownReset && future.length === 0,
    retryAt: future.length ? new Date(future[0].resetAt).toISOString() : null,
    windowMinutes: blocking.windowMinutes,
  };
}

function rateLimitedError(gate = {}) {
  const error = new Error("claude_code_rate_limited");
  error.code = "claude_code_rate_limited";
  error.statusCode = 429;
  error.rateLimitPreflight = true;
  error.retryAt = gate.retryAt || null;
  error.windowMinutes = gate.windowMinutes || null;
  return error;
}

async function recoverProfile(thread, profile, env) {
  const key = `${clean(thread.ownerUserId || thread.userId)}\u0000${clean(profile.id)}`;
  if (recoveryChecks.has(key)) return recoveryChecks.get(key);
  const check = (async () => {
    const status = await claudeCodeLoginStatus(profile, thread, env);
    if (!status.authenticated) {
      await appendEvent({
        type: "claude_code_rate_limit_recovery_failed",
        threadId: thread.id,
        profileId: profile.id,
        failureCode: clean(status.reason) || "claude_code_auth_status_failed",
      }, env).catch(() => {});
      return profile;
    }
    const recovered = await updateLlmAccountProfileState(
      thread.ownerUserId || thread.userId,
      profile.id,
      "ready",
      { verified: true, failureCode: "", credentialRevision: profile.credentialRevision || 0 },
      env,
    );
    await appendEvent({
      type: "claude_code_rate_limit_recovered",
      threadId: thread.id,
      profileId: profile.id,
    }, env).catch(() => {});
    return { ...profile, ...recovered };
  })().finally(() => recoveryChecks.delete(key));
  recoveryChecks.set(key, check);
  return check;
}

export async function resolveClaudeCodeRuntimeProfile(thread, env = process.env, requireReady = true) {
  let profile = await resolveLlmAccountProfile({
    ownerUserId: thread.ownerUserId || thread.userId,
    profileId: clean(thread?.executor?.accountProfileId || thread?.executor?.metadata?.accountProfileId),
    provider: "claude-code",
    requireReady: false,
    allowRevoked: !requireReady,
  }, env);
  if (profile.state === "rate_limited") {
    const gate = claudeCodeRateLimitGate(thread);
    if (gate.canRecheck) profile = await recoverProfile(thread, profile, env);
    if (profile.state === "rate_limited" && requireReady) throw rateLimitedError(gate);
  }
  if (requireReady && profile.state !== "ready") {
    return resolveLlmAccountProfile({
      ownerUserId: thread.ownerUserId || thread.userId,
      profileId: profile.id,
      provider: "claude-code",
      requireReady: true,
    }, env);
  }
  return profile;
}

export async function deferClaudeCodeRateLimitedInput(thread, message, error, schedule, env = process.env) {
  const retryAt = clean(error?.retryAt);
  await updateThreadMessage(thread.id, message.id, {
    state: "queued",
    deliveryState: "waiting_runtime_ready",
    runtimeBlockReason: "claude_code_rate_limited",
    runtimeRetryAt: retryAt || null,
    runtimeBlockWindowMinutes: Number(error?.windowMinutes) || null,
    deliveryNextAttemptAt: retryAt || null,
    error: null,
  }, env);
  await updateThread(thread.id, {
    state: "failed",
    lastError: "claude_code_rate_limited",
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "failed", activeTurnId: null },
  }, env).catch(() => {});
  if (retryAt) schedule?.(thread.id, env, Math.max(1_000, Date.parse(retryAt) - Date.now() + 1_000));
}

export async function recoverClaudeCodeThreadState(thread, profileState, env = process.env) {
  if (profileState !== "ready" || clean(thread.lastError) !== "claude_code_rate_limited") return { thread, recovered: false };
  const updated = await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "ready", activeTurnId: null },
  }, env).catch(() => thread);
  return { thread: updated, recovered: true };
}

export function resetClaudeCodeRateLimitRecoveryForTest() {
  recoveryChecks.clear();
}
