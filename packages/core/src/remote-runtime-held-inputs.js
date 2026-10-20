// Local input on a thread delegated to a remote runtime.
//
// The dispatch fence never runs local input on a delegated thread. Owner
// WhatsApp input (legacy remote route or scoped relay) is forwarded to the
// remote runtime. Any other pending input (a V1 timer, a UI or API message,
// an executor command) has no executor while the delegation lasts and would
// run in a burst once the thread is handed back. It is dropped instead, with an
// audit event and a visible failed state on the message. To run it, send it
// again after the handback.
import { appendEvent } from "../../storage/src/store.js";
import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";
import { listThreadMessageCandidates, updateThreadMessage } from "./threads.js";

export const heldInputDropReason = "thread_delegated_to_remote_runtime";
const pendingStates = ["queued", "pending_delivery", "awaiting_ack"];
const remoteRoutedSources = new Set(["whatsapp_inbound", "whatsapp_group_relay"]);

function clean(value) {
  return String(value || "").trim();
}

export function heldLocalInput(message = {}) {
  return message.role === "user" && pendingStates.includes(message.state) &&
    !remoteRoutedSources.has(clean(message.source)) && !clean(message.remoteBackend) && !clean(message.remoteMessageId);
}

export async function dropHeldLocalInputs(thread, env = process.env, now = new Date()) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return [];
  const candidates = await listThreadMessageCandidates(thread.id, { states: pendingStates }, env);
  const dropped = [];
  for (const message of candidates.filter(heldLocalInput)) {
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "failed",
      deliveryState: "dropped",
      observedVia: "remote_runtime_dispatch_fence",
      error: heldInputDropReason,
      droppedAt: now.toISOString(),
    }, env, { expectedFields: { state: message.state } }).catch(() => null);
    if (!updated) continue;
    dropped.push(updated.id);
    await appendEvent({
      type: "thread_input_dropped_delegated",
      threadId: thread.id,
      messageId: message.id,
      source: clean(message.source) || null,
      timerId: clean(message.timerId) || null,
      remoteBackend: remote.backendId,
      remoteThreadId: remote.remoteThreadId,
      reason: heldInputDropReason,
    }, env).catch(() => {});
  }
  return dropped;
}
