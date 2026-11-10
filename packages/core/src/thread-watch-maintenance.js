// Explicit, reversible reconciliation of old automatic finals. Never advance a
// cursor over pending inputs: those inputs can still fail at their original row.
import path from "node:path";
import { createHash } from "node:crypto";
import { appHome } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { getThread, listThreadMessageCandidates } from "./threads.js";
import { readThreadWatches, mutateThreadWatches } from "./thread-watches.js";
import { withThreadQueueBoundary } from "./thread-queue-control.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { statusCode: 409 }); };
export const watchFinalDigest = message => hash({ id: message.id, role: message.role,
  phase: message.phase, state: message.state, text: message.text, attachments: message.attachments || [] });
export function reconciledWatchFinal(watch, message) {
  return message.role === "assistant" && message.phase === "final_answer" && message.state === "completed" &&
    watch.reconciledFinals?.[message.id]?.digest === watchFinalDigest(message);
}
export async function watchMaintenanceSnapshot(threadId, watchId, env = process.env) {
  const watch = (await readThreadWatches(env)).find(w => w.id === watchId);
  if (!watch || watch.watcherThreadId !== threadId || watch.auto !== "worker") fail("automatic_watch_required");
  const entries = (await listThreadMessageCandidates(watch.targetThreadId, { afterCursor: watch.cursor }, env))
    .filter(m => m.role === "assistant" && m.phase === "final_answer" && m.state === "completed" &&
      Date.parse(m.createdAt) >= Date.parse(watch.createdAt))
    .map(message => ({ id: message.id, digest: watchFinalDigest(message), message }));
  return { watch, entries };
}
function ledgerPath(threadId, operationId, env) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId || "")) fail("queue_operation_id_invalid");
  return path.join(appHome(env), "queue-maintenance", hash(threadId), `${operationId}.watch.json`);
}
export async function reconcileWatchFinals(threadId, input, env = process.env) {
  return withThreadQueueBoundary(threadId, async () => {
    if (!(await getThread(threadId, env))?.queueDispatchHold?.paused) fail("queue_hold_required");
    const file = ledgerPath(threadId, input.operationId, env), inputHash = hash(input);
    let ledger = await readJson(file, null);
    if (ledger && ledger.inputHash !== inputHash) fail("queue_operation_conflict");
    if (ledger?.status === "applied") return { ...ledger, duplicate: true };
    const snapshot = await watchMaintenanceSnapshot(threadId, input.watchId, env);
    if (snapshot.watch.status !== "cancelled") fail("watch_cancellation_required");
    if (!ledger) {
      if (!input.summary?.trim() || !Array.isArray(input.entries)) fail("queue_ledger_required");
      const decisions = new Map(input.entries.map(e => [e.id, e]));
      if (decisions.size !== input.entries.length || decisions.size !== snapshot.entries.length ||
          snapshot.entries.some(e => decisions.get(e.id)?.digest !== e.digest)) fail("watch_snapshot_changed");
      const entries = snapshot.entries.map(entry => {
        const d = decisions.get(entry.id);
        if (!["retain", "summarize"].includes(d.disposition) ||
            (d.disposition === "summarize" && (!String(d.reason || "").trim() || !String(d.evidence || "").trim()))) fail("queue_supersession_not_proven");
        return { ...entry, disposition: d.disposition, reason: String(d.reason || ""), evidence: String(d.evidence || "") };
      });
      ledger = { status: "prepared", threadId, operationId: input.operationId, inputHash, watchId: input.watchId,
        watchBefore: snapshot.watch, summary: input.summary, entries, createdAt: new Date().toISOString() };
      await writeJson(file, ledger);
    }
    await mutateThreadWatches(watches => watches.map(w => {
      if (w.id !== input.watchId) return w;
      if (w.status !== "cancelled") fail("watch_cancellation_required");
      const reconciledFinals = { ...w.reconciledFinals };
      for (const e of ledger.entries.filter(e => e.disposition === "summarize"))
        reconciledFinals[e.id] = { digest: e.digest, operationId: input.operationId };
      return { ...w, reconciledFinals }; // cursor, fire limits and pending/failure rows untouched
    }), env);
    ledger = { ...ledger, status: "applied", appliedAt: new Date().toISOString() };
    await writeJson(file, ledger);
    await appendEvent({ type: "thread_watch_finals_reconciled", threadId, watchId: input.watchId, operationId: input.operationId }, env);
    return ledger;
  }, env);
}
export async function rollbackWatchFinals(threadId, operationId, env = process.env) {
  return withThreadQueueBoundary(threadId, async () => {
    if (!(await getThread(threadId, env))?.queueDispatchHold?.paused) fail("queue_hold_required");
    const file = ledgerPath(threadId, operationId, env), ledger = await readJson(file, null);
    if (!ledger) fail("queue_ledger_not_found");
    if (ledger.status === "rolled_back") return { ...ledger, duplicate: true };
    await mutateThreadWatches(watches => watches.map(w => {
      if (w.id !== ledger.watchId) return w;
      if (w.status !== "cancelled") fail("watch_cancellation_required");
      const reconciledFinals = { ...w.reconciledFinals };
      for (const e of ledger.entries.filter(e => e.disposition === "summarize")) {
        if (reconciledFinals[e.id]?.operationId !== operationId) fail("queue_rollback_conflict");
        const before = ledger.watchBefore.reconciledFinals?.[e.id];
        if (before) reconciledFinals[e.id] = before; else delete reconciledFinals[e.id];
      }
      // Revisit the preserved cursor. Existing input idempotency keys prevent
      // duplicate delivery; original pending failures remain observable.
      return { ...w, reconciledFinals, cursor: Math.min(w.cursor, ledger.watchBefore.cursor) };
    }), env);
    const result = { ...ledger, status: "rolled_back", rolledBackAt: new Date().toISOString() };
    await writeJson(file, result);
    return result;
  }, env);
}
