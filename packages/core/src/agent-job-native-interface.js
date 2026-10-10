// The one interface every native Agent Job executor implements (toolLoop
// "native": the provider runs its own tool loop). Built-in implementations:
// `codex` (agent-job-codex.js, Codex app-server) and `claude-code`
// (agent-job-claude-code.js, `claude -p`). The runner side that supplies the
// context lives in agent-job-native-attempt.js; docs/spec/agent-job-runner.md
// describes the contract.
//
// Executor:
//   id, jobExecutor (name of the built-in executor), capabilities (toolLoop
//   "native", resume "session", permissionHook "pre_call", streaming true),
//   probe(ctx), run(ctx, input) -> NativeOutcome
//
// ctx (one attempt):
//   runId, job, attempt, provider, env, home, baseDir
//   workspace           per-run workspace path (agent-job-workspace.js)
//   prepareWorkspace(i) -> { path, kind, repository }; a git worktree for
//                       repository jobs, else a directory
//   resume              { sessionRef, attempt, reason } of the previous attempt
//                       on this provider, or null: start a new session
//   signal              AbortSignal; reason "cancelled" | "timeout" | "lease_lost"
//   emit(event)         progress into the run journal, see NATIVE_EVENT_TYPES
//   authorizeTool(call) the tool-permission hook for a provider-native call
//                       { tool, args, callId } -> { decision: "allow" } |
//                       { decision: "deny", reason } | { decision: "pending" |
//                       "expired", approval } | { decision: "cancelled" }.
//                       "pending" is the approval pause: stop the turn and
//                       return { type: "park", approval }.
//   executeTool(call)   run an Orkestr job tool through the effect ledger
//   toolDecision(tool)  allow | approval_required | deny (permissions.tools)
//   fault(point)        fault injection (tests)
//
// NativeOutcome: { type: "final", output } | { type: "park" | "expired",
// approval } | { type: "cancelled" }. Failures throw nativeAttemptError(...),
// classified with runtime-turn-error-class.js.

export const NATIVE_EVENT_TYPES = Object.freeze([
  "session.started", // { sessionRef, resumed }
  "workspace.ready", // { path, kind }
  "message.delta", // { text }
  "message.completed", // { text }
  "tool.requested", // { tool, callId }
  "tool.completed", // { tool, callId, ok }
  "usage", // { inputTokens, outputTokens, costUsd }
  "output.repair", // { error }
]);

const EXECUTOR_SWITCHES = Object.freeze({
  codex: "ORKESTR_AGENT_JOB_CODEX_EXECUTOR",
  "claude-code": "ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR",
});

export function nativeExecutorSwitch(provider) {
  return EXECUTOR_SWITCHES[provider] || "";
}

// Built-in executors are on unless their switch is 0/false/no/off.
export function nativeExecutorEnabled(provider, env = process.env) {
  const name = nativeExecutorSwitch(provider);
  const value = String((name && env[name]) ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

// Runner semantics for a turn error class: auth -> provider error, no retry
// (fallback applies); rate_limit/transient -> provider error, retried with
// backoff; permanent -> task error.
export function nativeAttemptError(classification, { message = "", sessionRef = "" } = {}) {
  const errorClass = classification?.class || "permanent";
  const kind = errorClass === "permanent" ? "task" : "provider";
  return Object.assign(new Error(message || classification?.code || errorClass), {
    code: classification?.code || errorClass,
    kind,
    retryable: classification?.retryable === true,
    retryAfterMs: classification?.retryAfterMs ?? null,
    errorClass,
    sessionRef,
  });
}

export function nativeTimeoutError() {
  return Object.assign(new Error("attempt_timeout"), { kind: "timeout", retryable: true, errorClass: "transient", code: "attempt_timeout" });
}

// Problems with an executor's shape, [] when it satisfies the interface.
export function nativeExecutorProblems(executor) {
  const problems = [];
  const caps = executor?.capabilities || {};
  if (!executor?.id) problems.push("id");
  if (!executor?.jobExecutor) problems.push("jobExecutor");
  if (typeof executor?.run !== "function") problems.push("run(ctx, input)");
  if (typeof executor?.probe !== "function") problems.push("probe(ctx)");
  if (caps.toolLoop !== "native") problems.push("capabilities.toolLoop native");
  if (caps.resume !== "session") problems.push("capabilities.resume session");
  if (caps.permissionHook !== "pre_call") problems.push("capabilities.permissionHook pre_call");
  if (caps.streaming !== true) problems.push("capabilities.streaming");
  if (!["kill", "cooperative"].includes(caps.interrupt)) problems.push("capabilities.interrupt");
  if (!nativeExecutorSwitch(executor?.id)) problems.push("env switch");
  return problems;
}

// Resume prompt line for input.approvedCalls (approved, not yet executed).
export function approvedCallsText(input) {
  return input.approvedCalls
    ? `A person approved these exact calls. If the action is still needed, make the same call again with the same arguments; do not get the same result through a different tool:\n${input.approvedCalls}`
    : "";
}
