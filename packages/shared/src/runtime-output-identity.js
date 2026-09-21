import { createHash } from "node:crypto";

const clean = value => String(value || "").trim();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function alias(a, b) {
  a = clean(a); b = clean(b);
  if (a && b && a !== b) throw new Error("runtime_output_identity_conflict");
  return a || b;
}

// Text, parent aliases, timestamps, local UUIDs and attachment staging paths
// are projections, never logical output identity.
export function runtimeOutputMetadata(message = {}) {
  if (clean(message.role) !== "assistant" || clean(message.phase || "final_answer") !== "final_answer") return {};
  const generation = alias(message.codexThreadId, message.executorThreadId);
  return {
    ...(generation ? { runtimeGeneration: generation } : {}),
    runtimeTurnId: alias(message.codexTurnId, message.executorTurnId),
    runtimeItemId: alias(message.codexItemId, message.executorItemId),
  };
}

export function runtimeOutputItemKey(message = {}) {
  const m = runtimeOutputMetadata(message);
  return m.runtimeGeneration && m.runtimeTurnId && m.runtimeItemId
    ? digest([m.runtimeGeneration, m.runtimeTurnId, m.runtimeItemId, "assistant", "final_answer"]) : "";
}

export function logicalOutputKey(job = {}) {
  if (job.connector !== "whatsapp" || job.deliveryType !== "final" || !job.threadId) return "";
  const m = job.metadata || {};
  const identity = m.runtimeGeneration && m.runtimeTurnId && m.runtimeItemId
    ? ["item", m.runtimeGeneration, m.runtimeTurnId, m.runtimeItemId]
    : job.sourceEventId && job.sourceEventId !== job.sourceMessageId
      ? ["event", m.runtimeGeneration || "", job.sourceEventId] : null;
  if (!identity) return "";
  return `output-v1:${digest([job.tenantId || job.ownerUserId || "admin", job.ownerUserId || job.tenantId || "admin",
    job.connector, job.accountId || "", job.chatId || "", job.threadId, identity, clean(job.sourceRevision || "1"), "final"])}`;
}

// Compatibility with retained pre-upgrade jobs. No body-only or parent-only
// match. Conflicting runtime evidence always defeats an event alias match.
export function sameLogicalOutput(a, b) {
  if (!logicalOutputKey(b)) return false;
  for (const key of ["tenantId", "ownerUserId", "connector", "accountId", "chatId", "threadId", "sourceRevision", "deliveryType"]) {
    if (clean(a[key]) !== clean(b[key])) return false;
  }
  for (const key of ["runtimeGeneration", "runtimeTurnId", "runtimeItemId"]) {
    if (a.metadata?.[key] && b.metadata?.[key] && a.metadata[key] !== b.metadata[key]) return false;
  }
  return Boolean(a.sourceMessageId && a.sourceMessageId === b.sourceMessageId) ||
    logicalOutputKey(a) === logicalOutputKey(b) || Boolean(a.sourceEventId && a.sourceEventId === b.sourceEventId);
}
