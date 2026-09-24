import { classifyClaudeCodeFailure } from "./claude-code-client.js";
import { threadRequiresTenantIsolation } from "./tenant-policy.js";

function clean(value = "") {
  return String(value || "").trim();
}

export function publicClaudeCodeFailure(error) {
  const exact = clean(error?.code || error?.message || error);
  if (new Set([
    "claude_code_disabled",
    "claude_code_bypass_permissions_disabled",
    "llm_account_profile_not_found",
    "llm_account_provider_mismatch",
    "llm_account_profile_revoked",
    "llm_account_profile_not_ready",
  ]).has(exact)) return exact;
  return classifyClaudeCodeFailure(`${error?.code || ""} ${error?.message || error || ""}`);
}

export function threadUsesClaudeCode(thread = {}) {
  const executorId = clean(thread.executorId || thread.executor?.id || thread.executor?.type).toLowerCase();
  const runtimeKind = clean(thread.runtimeKind || thread.runtime?.runtimeKind || thread.executor?.metadata?.runtimeKind).toLowerCase();
  return executorId === "claude-code" || runtimeKind === "claude-code";
}

// Claude does not yet implement the contained-user runtime sandbox contract.
// Scope credentials AND process execution: an opaque profile is not isolation.
export function assertClaudeCodeHostOwner(thread = {}, env = process.env) {
  const owner = clean(thread.ownerUserId || thread.userId).toLowerCase();
  const admin = clean(env.ORKESTR_ADMIN_USER_ID || "admin").toLowerCase();
  if (!owner || owner !== admin || threadRequiresTenantIsolation(thread, env)) {
    const error = new Error("claude_code_admin_runtime_required");
    error.code = error.message;
    error.statusCode = 403;
    throw error;
  }
}
