import { threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
// Operator queue maintenance is serialized with native dispatch, never with a
// running turn. Original records and a write-ahead ledger remain recoverable.
import path from "node:path";
import { createHash } from "node:crypto";
import { appHome } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { appendThreadMessage, getThread, listThreadMessageCandidates, updateThread, updateThreadMessage } from "./threads.js";

export const QUEUED_INPUT_STATES = ["queued", "pending_delivery", "awaiting_ack", "delivering", "claimed"];
const fail = code => { throw Object.assign(new Error(code), { statusCode: 409 }); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const queueMessageDigest = message => hash(message);
export function withThreadQueueBoundary(threadId, operation, env = process.env) {
  return withStorageFileLock(path.join(appHome(env), "queue-maintenance", `${hash(threadId)}.boundary`), operation, { timeoutMs: 120_000 });
}
export async function threadQueueSnapshot(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) fail("thread_not_found");
  const messages = (await listThreadMessageCandidates(threadId, { states: QUEUED_INPUT_STATES }, env))
    .filter(m => m.role === "user" && QUEUED_INPUT_STATES.includes(m.state));
  return { threadId, paused: thread.queueDispatchHold?.paused === true, hold: thread.queueDispatchHold || null,
    activeTurnId: thread.runtime?.activeTurnId || null, pendingCount: messages.length,
    oldestPendingAt: messages[0]?.createdAt || null,
    entries: messages.map(message => ({ id: message.id, digest: hash(message), message })) };
}
export async function setThreadQueueHold(threadId, input, env = process.env) {
  return withThreadQueueBoundary(threadId, async () => {
    const thread = await getThread(threadId, env);
    if (!thread) fail("thread_not_found");
    if (typeof input.paused !== "boolean" || !String(input.reason || "").trim()) fail("queue_hold_reason_required");
    // Restrict maintenance to runtimes which serialize native admission with this boundary.
    if (!["codex-app-server", "app-server"].includes(thread.runtimeKind) && !threadUsesClaudeCode(thread)) fail("queue_maintenance_runtime_unsupported");
    await updateThread(threadId, { queueDispatchHold: { paused: input.paused, reason: input.reason,
      changedAt: new Date().toISOString(), changedBy: input.actor || "operator" } }, env);
    await appendEvent({ type: "thread_queue_hold_changed", threadId, paused: input.paused, reason: input.reason }, env);
    return threadQueueSnapshot(threadId, env);
  }, env);
}
function ledgerFile(threadId, operationId, env) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId || "")) fail("queue_operation_id_invalid");
  return path.join(appHome(env), "queue-maintenance", hash(threadId), `${operationId}.json`);
}
function neverDispatched(message) {
  return message.state === "queued" && !message.deliveredAt && !message.codexTurnId && !message.executorTurnId &&
    !message.deliveryClaimedAt && !message.deliveryClaimId && !message.deliveryLastAttemptAt;
}
export async function consolidateThreadQueue(threadId, input, env = process.env) {
  return withThreadQueueBoundary(threadId, async () => {
    const file = ledgerFile(threadId, input.operationId, env);
    let ledger = await readJson(file, null);
    const inputHash = hash(input);
    if (ledger && ledger.inputHash !== inputHash) fail("queue_operation_conflict");
    if (ledger?.status === "applied") return { ...ledger, duplicate: true };
    const snapshot = await threadQueueSnapshot(threadId, env);
    if (!snapshot.paused) fail("queue_hold_required");
    if (!ledger) {
      if (!Array.isArray(input.entries) || !input.summary?.trim()) fail("queue_ledger_required");
      const entries = new Map(input.entries.map(entry => [entry.id, entry]));
      if (entries.size !== input.entries.length || entries.size !== snapshot.entries.length ||
          snapshot.entries.some(entry => !entries.has(entry.id))) fail("queue_snapshot_changed");
      for (const entry of snapshot.entries) {
        const decision = entries.get(entry.id);
        if (decision.digest !== entry.digest) fail("queue_snapshot_changed");
        if (!["retain", "supersede"].includes(decision.disposition)) fail("queue_disposition_invalid");
        if (decision.disposition === "supersede" && (!neverDispatched(entry.message) ||
          !["cli", "thread_watch", "agent_report"].includes(entry.message.source) ||
          !String(decision.reason || "").trim() || !String(decision.evidence || "").trim())) fail("queue_supersession_not_proven");
      }
      ledger = { version: 1, threadId, operationId: input.operationId, inputHash, status: "prepared",
        createdAt: new Date().toISOString(), summary: input.summary,
        entries: snapshot.entries.map(entry => {
          const decision = entries.get(entry.id);
          return { ...entry, disposition: decision.disposition, reason: String(decision.reason || ""), evidence: String(decision.evidence || "") };
        }) };
      await writeJson(file, ledger); // complete original input/provenance before any mutation
    }
    const summary = await appendThreadMessage(threadId, { role: "assistant", phase: "notification", state: "completed",
      visibility: "internal", source: "queue_consolidation", text: ledger.summary,
      clientMessageId: `queue-summary:${input.operationId}`, dedupeAssistantByIdempotencyKey: true }, env);
    for (const entry of ledger.entries.filter(entry => entry.disposition === "supersede")) {
      const current = (await import("./threads.js")).getThreadMessage;
      const row = await current(threadId, entry.id, env);
      if (row?.queueConsolidationId === input.operationId && row.state === "superseded") continue;
      if (!row || hash(row) !== entry.digest) fail("queue_snapshot_changed");
      await updateThreadMessage(threadId, entry.id, { state: "superseded", deliveryState: "superseded_unexecuted",
        supersededBy: summary.id, queueConsolidationId: input.operationId, supersessionReason: entry.reason }, env,
      { expectedStates: ["queued"] });
    }
    ledger = { ...ledger, status: "applied", summaryMessageId: summary.id, appliedAt: new Date().toISOString() };
    await writeJson(file, ledger);
    await appendEvent({ type: "thread_queue_consolidated", threadId, operationId: input.operationId,
      retained: ledger.entries.filter(e => e.disposition === "retain").length,
      superseded: ledger.entries.filter(e => e.disposition === "supersede").length, summaryMessageId: summary.id }, env);
    return ledger;
  }, env);
}
export async function rollbackThreadQueue(threadId, operationId, env = process.env) {
  return withThreadQueueBoundary(threadId, async () => {
    const file = ledgerFile(threadId, operationId, env);
    const ledger = await readJson(file, null);
    if (!ledger) fail("queue_ledger_not_found");
    if (ledger.status === "rolled_back") return { ...ledger, duplicate: true };
    if (!(await threadQueueSnapshot(threadId, env)).paused) fail("queue_hold_required");
    const { getThreadMessage } = await import("./threads.js");
    const entries = ledger.entries.filter(e => e.disposition === "supersede");
    for (const entry of entries) {
      const row = await getThreadMessage(threadId, entry.id, env);
      if (row?.queueRollbackId === operationId && row.state === entry.message.state) continue;
      if (row?.queueConsolidationId !== operationId || row.state !== "superseded") fail("queue_rollback_conflict");
    }
    for (const entry of entries) {
      if ((await getThreadMessage(threadId, entry.id, env))?.queueRollbackId === operationId) continue;
      await updateThreadMessage(threadId, entry.id, {
      state: entry.message.state, deliveryState: entry.message.deliveryState || "", supersededBy: null,
      queueConsolidationId: null, supersessionReason: null, queueRollbackId: operationId,
    }, env, { expectedStates: ["superseded"] });
    }
    const result = { ...ledger, status: "rolled_back", rolledBackAt: new Date().toISOString() };
    await writeJson(file, result);
    return result;
  }, env);
}
