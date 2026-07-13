function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function dateMs(value = "") {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

export function phaseSet(trace = {}) {
  return new Set((Array.isArray(trace.phases) ? trace.phases : []).map((phase) => lower(phase.phase)));
}

export function phaseTime(trace = {}, phaseName = "") {
  const phase = (Array.isArray(trace.phases) ? trace.phases : []).find((entry) => lower(entry.phase) === lower(phaseName));
  return dateMs(phase?.ts);
}

function firstPhaseTime(trace = {}, phaseNames = []) {
  const names = new Set(phaseNames.map(lower));
  const times = (Array.isArray(trace.phases) ? trace.phases : [])
    .filter((entry) => names.has(lower(entry.phase)))
    .map((entry) => dateMs(entry.ts))
    .filter(Boolean);
  return times.length ? Math.min(...times) : 0;
}

function phaseReasons(trace = {}) {
  return new Set((Array.isArray(trace.phases) ? trace.phases : [])
    .map((entry) => lower(entry.reason || entry.status || entry.terminalState))
    .filter(Boolean));
}

function traceHasAnyPhase(trace = {}, phaseNames = []) {
  const phases = phaseSet(trace);
  return phaseNames.some((phase) => phases.has(lower(phase)));
}

export function traceHasRuntimeReplyEvidence(trace = {}) {
  return traceHasAnyPhase(trace, ["assistant_seen", "mirror_claimed", "mirror_sent"]) ||
    (phaseSet(trace).has("completed") && phaseSet(trace).has("queued"));
}

export function traceHasOutboundMirrorEvidence(trace = {}) {
  return traceHasAnyPhase(trace, ["assistant_seen", "mirror_claimed", "mirror_sent", "mirror_failed"]);
}

export function traceIsOutboundOnlyMirror(trace = {}) {
  const phases = phaseSet(trace);
  if (!traceHasOutboundMirrorEvidence(trace)) return false;
  return !["received", "routed", "queued", "delivery_started", "delivered_to_runtime"].some((phase) => phases.has(phase));
}

export function traceShortCircuitedBeforeRuntime(trace = {}) {
  const phases = phaseSet(trace);
  if (traceHasRuntimeReplyEvidence(trace) || phases.has("delivery_started") || phases.has("delivered_to_runtime")) return false;
  if (phases.has("queued")) return false;
  const reasons = phaseReasons(trace);
  const knownLocalTerminalReasons = new Set([
    "approval_not_pending",
    "desktop_share_approved",
    "desktop_share_approve_failed",
    "duplicate_event_id",
    "duplicate_status_command",
    "google_workspace_connect",
    "status_command",
  ]);
  if ([...reasons].some((reason) => knownLocalTerminalReasons.has(reason))) return true;
  return trace.terminal === true && lower(trace.currentPhase) === "skipped";
}

export function requiredTracePhases(trace = {}) {
  if (traceShortCircuitedBeforeRuntime(trace)) return [];
  const phases = phaseSet(trace);
  if (traceIsOutboundOnlyMirror(trace)) {
    const required = [];
    if (traceHasAnyPhase(trace, ["mirror_claimed", "mirror_sent", "completed"])) required.push("assistant_seen");
    if (phases.has("completed")) required.push("mirror_sent", "completed");
    return [...new Set(required)];
  }
  const required = ["received", "routed"];
  const needsRuntime = traceHasRuntimeReplyEvidence(trace) ||
    phases.has("delivery_started") ||
    phases.has("delivered_to_runtime") ||
    (phases.has("queued") && (trace.terminal === true || ["completed", "delivered_to_runtime", "assistant_seen"].includes(lower(trace.currentPhase))));
  if (needsRuntime || phases.has("queued")) required.push("queued");
  if (needsRuntime) required.push("delivery_started", "delivered_to_runtime");
  if (needsRuntime && traceHasAnyPhase(trace, ["assistant_seen", "mirror_claimed", "mirror_sent"])) {
    required.push("assistant_seen");
  }
  return [...new Set(required)];
}

function isoAt(ms, fallback = Date.now()) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : fallback;
  return new Date(value).toISOString();
}

export function inferredRuntimeBackfillPhases(trace = {}, missingPhases = []) {
  const missing = new Set((Array.isArray(missingPhases) ? missingPhases : []).map(lower));
  const phases = phaseSet(trace);
  const additions = [];
  const queuedMs = phaseTime(trace, "queued") || phaseTime(trace, "routed") || phaseTime(trace, "received") || dateMs(trace.createdAt);
  const replyMs = firstPhaseTime(trace, ["assistant_seen", "mirror_claimed", "mirror_sent", "completed"]) || dateMs(trace.updatedAt) || Date.now();
  const startMs = queuedMs ? queuedMs + 1 : Math.max(1, replyMs - 2);
  const deliveredMs = replyMs > startMs + 1 ? Math.min(startMs + 1, replyMs - 1) : startMs + 1;
  if (missing.has("delivery_started") && !phases.has("delivery_started")) {
    additions.push({ phase: "delivery_started", ts: isoAt(startMs), reason: "router_doctor_inferred_from_assistant_reply" });
  }
  if (missing.has("delivered_to_runtime") && !phases.has("delivered_to_runtime")) {
    additions.push({ phase: "delivered_to_runtime", ts: isoAt(deliveredMs), reason: "router_doctor_inferred_from_assistant_reply" });
  }
  if (missing.has("assistant_seen") && !phases.has("assistant_seen") && traceHasAnyPhase(trace, ["mirror_claimed", "mirror_sent", "completed"])) {
    additions.push({ phase: "assistant_seen", ts: isoAt(replyMs), reason: "router_doctor_inferred_from_mirror_reply" });
  }
  return additions;
}
