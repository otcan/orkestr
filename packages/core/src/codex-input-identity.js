import { createHash, randomUUID } from "node:crypto";
import { clean, codexInputText, itemText, userInputText } from "./codex-app-server-common.js";
import { incrementCounter } from "./observability.js";

export const inputDigest = value => createHash("sha256").update(String(value)).digest("hex");
const generation = row => clean(row?.codexThreadId || row?.executorThreadId);
const turn = row => clean(row?.codexTurnId || row?.executorTurnId);
const item = row => clean(row?.codexItemId || row?.executorItemId);
const original = row => row.role === "user" && row.source !== "codex-app-server-import" && !row.supersededBy;
const textOf = row => itemText(row) || userInputText(row.input);

export function identityMetric(outcome) {
  const allowed = new Set(["item", "submission", "legacy", "unmatched", "ambiguous", "conflict", "accepted", "uncertain", "parent_unresolved"]);
  incrementCounter("orkestr_codex_input_identity_total", { outcome: allowed.has(outcome) ? outcome : "unknown" });
}

export function sameInputScope(a, b) {
  return a.role === "user" && b.role === "user" && generation(a) && generation(a) === generation(b) &&
    turn(a) && turn(a) === turn(b) && a.ownerUserId && a.ownerUserId === b.ownerUserId;
}

export function submittedInputMatches(message, text) {
  const submission = message.codexSubmission;
  // If a versioned dispatch record exists, do not reconstruct changed inputs.
  if (submission) return submission.serializerVersion === 1 && submission.payloadDigest === inputDigest(text);
  return codexInputText(message) === text;
}

export function matchCanonicalInput(messages, input, historyItems = []) {
  const scoped = messages.filter(row => sameInputScope(row, input));
  const bound = scoped.filter(row => item(input) && item(row) === item(input) && !row.supersededBy);
  if (bound.length === 1) {
    const row = bound[0];
    return { message: row, outcome: "item" };
  }
  if (bound.length > 1) return { message: null, outcome: "conflict" };
  const candidates = scoped.filter(row => original(row) && !item(row) && submittedInputMatches(row, input.text));
  const matchingItems = historyItems.filter(row => row.type === "userMessage" && textOf(row) === input.text);
  // A shared turn or identical text is not enough to collapse distinct inputs.
  if (candidates.length !== 1 || matchingItems.length > 1) {
    return { message: null, outcome: candidates.length > 1 || matchingItems.length > 1 ? "ambiguous" : "unmatched",
      hasLocalCandidates: candidates.length > 0 };
  }
  const candidate = candidates[0];
  if (scoped.some(row => row.id !== candidate.id && row.source === "codex-app-server-import" && !row.supersededBy && row.text === input.text)) {
    return { message: null, outcome: "conflict" };
  }
  return { message: candidate, outcome: candidate.codexSubmission ? "submission" : "legacy" };
}

export function canonicalUserPatch(existing, input) {
  // Deliberately do not copy display text, attachment/policy/provenance fields,
  // timestamps, event IDs, delivery state or a history completion into the input.
  return {
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
    codexItemId: input.codexItemId || existing.codexItemId || null,
    executorThreadId: input.codexThreadId,
    executorTurnId: input.codexTurnId,
    executorItemId: input.codexItemId || existing.executorItemId || null,
  };
}

export function canonicalTurnParent(messages, codexId, turnId, preferredId = "") {
  const scoped = messages.filter(row => row.role === "user" && !row.supersededBy && generation(row) === codexId && turn(row) === turnId);
  if (preferredId) {
    const preferred = scoped.find(row => row.id === preferredId);
    if (preferred) return preferred;
  }
  const canonical = scoped.filter(original);
  if (canonical.length === 1 && scoped.every(row => row.id === canonical[0].id || submittedInputMatches(canonical[0], row.text))) return canonical[0];
  return scoped.length === 1 ? scoped[0] : null;
}

export function createSubmission(thread, message, codexId, mode, targetTurnId, baseline = null) {
  const history = baseline?.id === codexId && Array.isArray(baseline.turns) ? baseline : null;
  const items = history?.turns.flatMap(t => (t.items || []).filter(i => i.type === "userMessage").map(i => `${t.id}\n${i.id}`)) || [];
  return {
    version: 1, serializerVersion: 1, attemptId: randomUUID(), messageId: message.id,
    threadId: thread.id, ownerUserId: message.ownerUserId || thread.ownerUserId,
    generation: codexId, mode, targetTurnId: targetTurnId || null,
    payloadDigest: inputDigest(codexInputText(message)), startedAt: new Date().toISOString(),
    baselineKnown: Boolean(history && history.turns.every(t => clean(t.id) && Array.isArray(t.items) && t.items.every(i => i.type !== "userMessage" || clean(i.id))) && items.length <= 10000),
    beforeItems: items.length <= 10000 ? items : [],
  };
}

export function uniqueAcceptedSubmission(probe, message) {
  const s = message.codexSubmission;
  if (!probe?.ok || !s?.attemptId || s.version !== 1 ||
      s.generation !== clean(probe.thread?.id) || s.messageId !== message.id ||
      (message.ownerUserId && s.ownerUserId !== message.ownerUserId) ||
      s.payloadDigest !== inputDigest(codexInputText(message))) return null;
  const started = Date.parse(s.startedAt);
  if (!Number.isFinite(started) || started > Date.now()) return null;
  if (s.acceptedTurnId) {
    const acknowledged = (probe.thread.turns || []).filter(t => t.id === s.acceptedTurnId);
    return acknowledged.length === 1 ? { turn: acknowledged[0], item: null } : null;
  }
  if (!s.baselineKnown || !Array.isArray(s.beforeItems)) return null;
  const matches = [];
  for (const t of probe.thread.turns || []) for (const i of t.items || []) {
    if (!t.id || !i.id || i.type !== "userMessage" || s.beforeItems.includes(`${t.id}\n${i.id}`)) continue;
    if (s.mode === "steer" && t.id !== s.targetTurnId) continue;
    // Require an occurrence timestamp, not turn completion/import time.
    let at = i.createdAt ?? i.startedAt ?? i.timestamp ?? (s.mode === "start" ? t.startedAt ?? t.createdAt : null);
    const ms = typeof at === "number" ? (at < 1e10 ? at * 1000 : at) : Date.parse(at);
    if (!Number.isFinite(ms) || ms < started || ms > Date.now() + 1000) continue;
    if (inputDigest(textOf(i)) === s.payloadDigest) matches.push({ turn: t, item: i });
  }
  return matches.length === 1 ? matches[0] : null;
}
