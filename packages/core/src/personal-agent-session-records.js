// Orkestr conversation/session identities never double as provider session IDs.
export function sessionError(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}

export function sessionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw sessionError("agent_session_identity_invalid", 400);
  return value;
}

export function sessionProfile(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["provider", "accountProfileId", "model", "effort"].includes(key))) {
    throw sessionError("agent_session_profile_invalid", 400);
  }
  if (!["codex", "claude-code"].includes(input.provider)) throw sessionError("agent_session_provider_unsupported", 400);
  const accountProfileId = sessionId(input.accountProfileId);
  if (typeof input.model !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(input.model)) throw sessionError("agent_session_model_required", 400);
  const effort = input.effort || null;
  const efforts = input.provider === "codex" ? ["none", "minimal", "low", "medium", "high", "xhigh"] : ["low", "medium", "high", "max"];
  if (effort !== null && !efforts.includes(effort)) throw sessionError("agent_session_effort_invalid", 400);
  return { provider: input.provider, accountProfileId, model: input.model, effort };
}

export function sessionScope(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw sessionError("agent_session_scope_invalid", 400);
  if (input.kind === "global" && (input.id === null || input.id === undefined)) return { kind: "global", id: null };
  if (input.kind === "project") return { kind: "project", id: sessionId(input.id) };
  throw sessionError("agent_session_scope_invalid", 400);
}

// Only known integrity codes become public diagnoses; provider prose is never
// persisted. Native identity reuse retains the existing public reason.
export function sessionIntegrityReason(error) {
  switch (error?.code) {
    case "agent_session_native_identity_changed": return "native_identity_changed";
    case "agent_session_native_identity_reused": return "native_session_unavailable";
    case "agent_session_identity_invalid": return "native_identity_invalid";
    case "agent_session_outcome_invalid": return "outcome_invalid";
    case "agent_session_native_session_missing": return "native_session_missing";
    case "agent_session_persistence_failed": return "persistence_failed";
    default: return null;
  }
}

// Provider prose and stack traces are never persisted in the public status.
export function sessionBlockedReason(error) {
  const code = String(error?.code || "");
  if (/rate.?limit|quota/.test(code) || error?.errorClass === "rate_limit") return "rate_limited";
  if (/auth|login|revoked|credentials|profile_not_ready/.test(code) || error?.errorClass === "auth") return "authentication_required";
  if (/resume|session_missing|missing_session|identity_changed|identity_reused/.test(code)) return "native_session_unavailable";
  if (/lease/.test(code)) return "lease_lost";
  return "runtime_unavailable";
}
