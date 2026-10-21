// Local input on a thread delegated to a remote runtime (Orkestr V2).
//
// The dispatch fence never runs local input on a delegated thread. Owner
// WhatsApp input (legacy remote route or scoped relay) is forwarded by the
// relay path. Every other pending input (thread-to-thread and agent messages,
// watch results, Worker assignments, mailbox and job signals, CLI and web UI
// input) is forwarded to the remote runtime as V1-local input, with its source
// and origin, and its reply comes back to this thread through the remote mirror
// (see connectors/whatsapp-remote-local-input.js).
//
// Not forwarded, and dropped with an audit event and a visible failed state
// instead (they would otherwise run in a burst once the thread is handed back):
// - a V1 timer run: V1-owned timers on a delegated thread are paused by the
//   timer delegation fence; V2-owned timers fire inside V2;
// - an executor command (/agent, /codex ...): it switches V1's own executor;
// - input already handed to a local runtime (`awaiting_ack`).
import { appendEvent } from "../../storage/src/store.js";
import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";
import { isExecutorCommandMessage } from "./thread-executor-commands.js";
import { listThreadMessageCandidates, updateThreadMessage } from "./threads.js";

export const heldInputDropReason = "thread_delegated_to_remote_runtime";
const pendingStates = ["queued", "pending_delivery", "awaiting_ack"];
const forwardableStates = new Set(["queued", "pending_delivery"]);
const remoteRoutedSources = new Set(["whatsapp_inbound", "whatsapp_group_relay"]);
const timerSources = new Set(["timer_due", "timer", "timer_run"]);
const busyThreads = new Set();

function clean(value) {
  return String(value || "").trim();
}

export function heldLocalInput(message = {}) {
  return message.role === "user" && pendingStates.includes(message.state) &&
    !remoteRoutedSources.has(clean(message.source)) && !clean(message.remoteBackend) && !clean(message.remoteMessageId);
}

// Why a held input is fenced (dropped) instead of forwarded, or "".
export function fencedLocalInputReason(message = {}) {
  if (clean(message.timerId) || timerSources.has(clean(message.source))) return "v1_timer";
  if (isExecutorCommandMessage(message)) return "executor_command";
  if (!forwardableStates.has(clean(message.state))) return "local_runtime_handoff";
  return "";
}

async function dropHeldInput(thread, message, remote, fence, env, now) {
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "dropped",
    observedVia: "remote_runtime_dispatch_fence",
    error: heldInputDropReason,
    droppedAt: now.toISOString(),
  }, env, { expectedFields: { state: message.state } }).catch(() => null);
  if (!updated) return null;
  await appendEvent({
    type: "thread_input_dropped_delegated",
    threadId: thread.id,
    messageId: message.id,
    source: clean(message.source) || null,
    timerId: clean(message.timerId) || null,
    fence,
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    reason: heldInputDropReason,
  }, env).catch(() => {});
  return updated;
}

// Forwards (with `options.forward`, see connectors/whatsapp-remote-local-input.js)
// or fences every held local input of one delegated thread. Safe to
// call repeatedly and concurrently: forwarding is idempotent per message and a
// pass already running for this thread is not duplicated in this process.
// Returns { forwarded, dropped, failed, held } message ids.
export async function routeHeldLocalInputs(thread, env = process.env, options = {}) {
  const result = { forwarded: [], dropped: [], failed: [], held: [] };
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote || !thread?.id || busyThreads.has(thread.id)) return result;
  // An operator queue hold (for example during a handoff) holds forwarding too.
  if (thread.queueDispatchHold?.paused === true) return result;
  busyThreads.add(thread.id);
  try {
    const now = options.now || new Date();
    const candidates = (await listThreadMessageCandidates(thread.id, { states: pendingStates }, env)).filter(heldLocalInput);
    if (!candidates.length) return result;
    // The connector layer supplies the forwarder; without one, input waits.
    const forward = options.forward || (async () => ({ held: null }));
    for (const message of candidates) {
      const fence = fencedLocalInputReason(message);
      if (fence) {
        if (await dropHeldInput(thread, message, remote, fence, env, now)) result.dropped.push(message.id);
        continue;
      }
      const outcome = await forward({ thread, message, remote }, env, options.fetchImpl || fetch, now.getTime()).catch(() => ({ held: null }));
      if (outcome?.forwarded) result.forwarded.push(message.id);
      else if (outcome?.failed) result.failed.push(message.id);
      else result.held.push(message.id);
    }
    return result;
  } finally {
    busyThreads.delete(thread.id);
  }
}
