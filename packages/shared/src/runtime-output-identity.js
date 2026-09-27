import { createHash } from "node:crypto";

const clean = value => String(value || "").trim();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bodyText = value => String(value || "").replace(/\s+/g, " ").trim();
function alias(a, b) {
  a = clean(a); b = clean(b);
  if (a && b && a !== b) throw new Error("runtime_output_identity_conflict");
  return a || b;
}

// Whitespace-normalized digest of the runtime source text (never the formatted
// connector payload, which can carry prefixes or debug footers). It is only a
// corroborator inside one exact runtime turn, never an identity on its own.
export function runtimeOutputBodyKey(message = {}) {
  const text = bodyText(message.text);
  return text ? digest(["final_answer", text]) : "";
}

// Text, parent aliases, timestamps, local UUIDs and attachment staging paths
// are projections, never logical output identity.
export function runtimeOutputMetadata(message = {}) {
  if (clean(message.role) !== "assistant" || clean(message.phase || "final_answer") !== "final_answer") return {};
  const generation = alias(message.codexThreadId, message.executorThreadId);
  const body = runtimeOutputBodyKey(message);
  return {
    ...(generation ? { runtimeGeneration: generation } : {}),
    runtimeTurnId: alias(message.codexTurnId, message.executorTurnId),
    runtimeItemId: alias(message.codexItemId, message.executorItemId),
    ...(body ? { runtimeOutputBodyKey: body } : {}),
  };
}

export function runtimeOutputItemKey(message = {}) {
  const m = runtimeOutputMetadata(message);
  return m.runtimeGeneration && m.runtimeTurnId && m.runtimeItemId
    ? digest([m.runtimeGeneration, m.runtimeTurnId, m.runtimeItemId, "assistant", "final_answer"]) : "";
}

const whatsappFinal = job => job.connector === "whatsapp" && job.deliveryType === "final" && Boolean(job.threadId);

export function logicalOutputKey(job = {}) {
  if (!whatsappFinal(job)) return "";
  const m = job.metadata || {};
  const identity = m.runtimeGeneration && m.runtimeTurnId && m.runtimeItemId
    ? ["item", m.runtimeGeneration, m.runtimeTurnId, m.runtimeItemId]
    : job.sourceEventId && job.sourceEventId !== job.sourceMessageId
      ? ["event", m.runtimeGeneration || "", job.sourceEventId] : null;
  if (!identity) return "";
  return `output-v1:${digest([job.tenantId || job.ownerUserId || "admin", job.ownerUserId || job.tenantId || "admin",
    job.connector, job.accountId || "", job.chatId || "", job.threadId, identity, clean(job.sourceRevision || "1"), "final"])}`;
}

function jobBodyKey(job = {}) {
  return clean(job.metadata?.runtimeOutputBodyKey) || runtimeOutputBodyKey({ text: job.payload?.text });
}

function turnScope(job = {}) {
  const m = job.metadata || {};
  return whatsappFinal(job) && m.runtimeGeneration && m.runtimeTurnId && jobBodyKey(job)
    ? [m.runtimeGeneration, m.runtimeTurnId] : null;
}

// Whether an ensure must look for retained aliases of the same logical output.
export function outputFenceApplies(job = {}) {
  return Boolean(logicalOutputKey(job) || turnScope(job));
}

// Redacted fingerprint for diagnostics; also covers turn-scoped item-less finals.
export function outputFenceFingerprint(job = {}) {
  const scope = turnScope(job);
  return logicalOutputKey(job) || (scope ? `output-turn-v1:${digest([job.tenantId || "", job.ownerUserId || "",
    job.accountId || "", job.chatId || "", job.threadId, scope, clean(job.sourceRevision || "1")])}` : "");
}

// A projection without a runtime item ID (rollout files usually omit it) is
// correlated only inside the exact runtime generation+turn and only with the
// same normalized source text. Two items that both carry IDs never match here,
// so distinct items or turns with identical text stay deliverable.
function sameTurnOutput(a, b) {
  const left = turnScope(a), right = turnScope(b);
  if (!left || !right || left[0] !== right[0] || left[1] !== right[1]) return false;
  if (a.metadata?.runtimeItemId && b.metadata?.runtimeItemId) return false;
  return jobBodyKey(a) === jobBodyKey(b);
}

// Compatibility with retained pre-upgrade jobs. No body-only or parent-only
// match. Conflicting runtime evidence always defeats an event alias match.
export function logicalOutputMatchReason(a, b) {
  if (!outputFenceApplies(b)) return "";
  for (const key of ["tenantId", "ownerUserId", "connector", "accountId", "chatId", "threadId", "sourceRevision", "deliveryType"]) {
    if (clean(a[key]) !== clean(b[key])) return "";
  }
  for (const key of ["runtimeGeneration", "runtimeTurnId", "runtimeItemId"]) {
    if (a.metadata?.[key] && b.metadata?.[key] && a.metadata[key] !== b.metadata[key]) return "";
  }
  if (a.sourceMessageId && a.sourceMessageId === b.sourceMessageId) return "same_source_message";
  if (logicalOutputKey(b) && logicalOutputKey(a) === logicalOutputKey(b)) return "same_logical_key";
  if (a.sourceEventId && a.sourceEventId === b.sourceEventId) return "same_source_event";
  return sameTurnOutput(a, b) ? "same_turn_output_body" : "";
}

export function sameLogicalOutput(a, b) {
  return Boolean(logicalOutputMatchReason(a, b));
}
