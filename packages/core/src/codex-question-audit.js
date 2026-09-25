import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { getThread } from "./threads.js";
import { withThreadMessageMutation } from "./thread-message-mutation.js";
import { codexThreadId, threadUsesCodexAppServer } from "./codex-app-server-common.js";
import { inputDigest } from "./codex-input-identity.js";

const phases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);
const clean = value => String(value ?? "").trim();
const generation = row => clean(row.codexThreadId || row.executorThreadId);
const requestId = row => clean(row.codexRequestId || row.executorRequestId);
const digest = value => inputDigest(JSON.stringify(value));
const aliasesAgree = row => ["Thread", "Turn", "Request"].every(kind =>
  !clean(row[`codex${kind}Id`]) || !clean(row[`executor${kind}Id`]) ||
  clean(row[`codex${kind}Id`]) === clean(row[`executor${kind}Id`]));

// No rollout files, provider calls, hydration or completion hooks. A candidate
// is a review target, not permission to rewrite history or answer a request.
export function auditCodexQuestions(thread, messages, { ownerUserId, runtimeGeneration, maxMessages = 10_000 } = {}) {
  if (!ownerUserId || !runtimeGeneration || thread?.ownerUserId !== ownerUserId ||
      !thread?.id || codexThreadId(thread) !== runtimeGeneration || !threadUsesCodexAppServer(thread)) {
    throw new Error("question_audit_scope_mismatch");
  }
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100_000 ||
      !Array.isArray(messages) || messages.length > maxMessages || messages.some(row => !row?.id)) {
    throw new Error("question_audit_inventory_bounds");
  }
  const pending = thread.runtime?.pendingRequest;
  const pendingId = clean(pending?.requestId);
  const identities = new Map(), answeredIds = new Set(), ambiguousAnswers = new Set();
  for (const row of messages) {
    identities.set(row.id, (identities.get(row.id) || 0) + 1);
  }
  for (const row of messages) {
    if (row.role === "user" && row.ownerUserId === ownerUserId && (!row.threadId || row.threadId === thread.id) &&
        generation(row) === runtimeGeneration && row.state === "completed") {
      const target = aliasesAgree(row) && identities.get(row.id) === 1 ? answeredIds : ambiguousAnswers;
      if (row.answeredInputMessageId) target.add(row.answeredInputMessageId);
      if (row.canceledInputMessageId) target.add(row.canceledInputMessageId);
    }
  }
  const rows = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !phases.has(clean(message.phase).toLowerCase())) continue;
    // Never reveal another owner's IDs even if a damaged inventory mixes them.
    if (message.ownerUserId !== ownerUserId || (message.threadId && message.threadId !== thread.id)) continue;
    let disposition = "manual_review", reason = "unproven_identity";
    const sameGeneration = generation(message) === runtimeGeneration &&
      (!message.executorThreadId || message.executorThreadId === runtimeGeneration) &&
      (!message.codexRequestId || !message.executorRequestId || clean(message.codexRequestId) === clean(message.executorRequestId)) &&
      (!message.codexTurnId || !message.executorTurnId || message.codexTurnId === message.executorTurnId);
    const unique = identities.get(message.id) === 1;
    const answered = answeredIds.has(message.id);
    if (sameGeneration && unique) {
      if (ambiguousAnswers.has(message.id)) {
        reason = "conflicting_resolution_evidence";
      } else if (answered || message.supersededBy || message.visibility === "internal") {
        disposition = "resolved"; reason = "persisted_resolution";
      } else if (requestId(message)) {
        const bound = pending?.method === "item/tool/requestUserInput" && pendingId === requestId(message) &&
          (!pending.threadId || pending.threadId === thread.id) &&
          clean(pending.codexThreadId || pending.params?.threadId) === runtimeGeneration &&
          (!clean(pending.params?.threadId) || clean(pending.params.threadId) === runtimeGeneration) &&
          clean(pending.params?.turnId) === clean(message.codexTurnId || message.executorTurnId) &&
          clean(message.codexTurnId || message.executorTurnId);
        disposition = bound ? "pending_native" : "manual_review";
        reason = bound ? "persisted_request_bound" : "native_request_not_bound";
      } else if (message.source === "codex-rollout" && !pending) {
        disposition = "legacy_unbound"; reason = "native_runtime_requires_request_id";
      } else if (pending) {
        reason = "pending_request_requires_review";
      }
    }
    rows.push({ messageId: message.id, disposition, reason,
      proposedAction: disposition === "legacy_unbound" ? "review_expired_question_annotation" : "none" });
  }
  const counts = { legacy_unbound: 0, pending_native: 0, resolved: 0, manual_review: 0 };
  for (const row of rows) counts[row.disposition] += 1;
  return { version: 1, ownerUserId, threadId: thread.id, runtimeGeneration, dryRun: true,
    automaticMutation: false, scanned: messages.length, counts, rows,
    snapshotDigest: digest({ thread, messages }) };
}

export async function reportCodexQuestions({ threadId, ownerUserId, runtimeGeneration, maxMessages }, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread || thread.id !== threadId || thread.ownerUserId !== ownerUserId) throw new Error("question_audit_scope_mismatch");
  return withThreadMessageMutation(threadId, env, async () => {
    const before = await getThread(threadId, env);
    const messages = await createThreadMessageRepository(env).list(threadId);
    const after = await getThread(threadId, env);
    if (digest(before) !== digest(after)) throw new Error("question_audit_runtime_changed");
    return auditCodexQuestions(after, messages, { ownerUserId, runtimeGeneration, maxMessages });
  });
}
