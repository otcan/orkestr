// Pure status payload for a Claude Code thread. The adapter owns live process
// state (the active supervisor and the account profile state); this module only
// shapes it for the runtime status API.

function clean(value = "") {
  return String(value || "").trim();
}

export function claudeCodeStatusPayload({ thread = {}, supervisor = null, profileState = "unknown", counts = {}, accountProfileId = "" } = {}) {
  const persistedState = clean(thread.runtime?.state || thread.state || "ready").toLowerCase();
  const state = supervisor ? "working" : persistedState === "working" ? "interrupted" : persistedState;

  // Semantic liveness: staleWorking is true when the process is alive but has not
  // produced meaningful output for longer than ORKESTR_CLAUDE_STALE_WORKING_MS.
  const staleWorking = supervisor ? supervisor.tickStaleWorking() : false;
  const staleWorkingSince = supervisor ? (supervisor.staleWorkingSince || null) : null;
  const staleWorkingReason = staleWorking ? "semantic_inactivity" : null;

  return {
    state,
    status: state,
    runtimeState: state,
    runtimeKind: "claude-code",
    provider: "anthropic",
    promptReady: state === "ready" && profileState === "ready",
    promptReadyStable: state === "ready" && profileState === "ready",
    working: Boolean(supervisor),
    foregroundWorking: Boolean(supervisor),
    // typingActive is false when the process is stale (transport alive, semantics silent).
    typingActive: Boolean(supervisor) && !staleWorking,
    backgroundWork: false,
    staleWorking,
    staleWorkingSince,
    staleWorkingReason,
    pendingCount: Number(counts.pendingCount || 0),
    runningCount: Number(counts.runningCount || 0),
    accountProfileId: accountProfileId || null,
    accountState: profileState,
    activeTurnId: supervisor?.attemptId || null,
    // "detached" turns survive a UI service restart; "pipe" turns do not.
    claudeTransport: supervisor ? (supervisor.transport || "pipe") : null,
    error: state === "interrupted" ? "claude_code_runtime_interrupted" : thread.lastError || null,
    model: thread.claudeModel || thread.executor?.metadata?.claudeModel || thread.claudeModelResolved || null,
    effort: thread.claudeEffort || thread.executor?.metadata?.claudeEffort || null,
    permissionMode: thread.claudePermissionMode || thread.executor?.metadata?.claudePermissionMode || "acceptEdits",
    tokenUsage: thread.claudeTokenUsage || null,
    rateLimits: thread.claudeRateLimits || null,
  };
}
