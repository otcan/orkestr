import { createHash } from "node:crypto";
import {
  getMobileRealtimeCallInternal,
  recordMobileRealtimeMirrorMessage,
} from "./mobile-realtime-store.js";
import { assistantMessage, visibleThreadMessages } from "./thread-message-visibility.js";
import { listThreadMessageCandidates } from "./threads.js";

const ACTIVE_CALL_STATES = new Set(["connecting", "active", "reconnecting"]);
function clean(value = "") {
  return String(value || "").trim();
}

function opaqueMessageId(callId, messageId) {
  return `mm_${createHash("sha256").update(`${clean(callId)}\n${clean(messageId)}`).digest("hex").slice(0, 32)}`;
}

function safeMirrorMessage(call, message) {
  const role = clean(message?.role).toLowerCase();
  const sourceMessageId = clean(message?.id);
  const text = clean(message?.text).slice(0, 50_000);
  const phase = clean(message?.phase).toLowerCase();
  // Hush is a final-only surface. Commentary, plans, clarification prompts,
  // progress, debug output, and user echoes stay in the authoritative thread.
  if (!sourceMessageId || !text || role !== "assistant" || phase !== "final_answer" || !assistantMessage(message)) {
    return null;
  }
  const createdAt = clean(message?.createdAt);
  return {
    sourceMessageId,
    message: {
      id: opaqueMessageId(call.id, sourceMessageId),
      role: "assistant",
      phase: "final_answer",
      origin: "thread",
      text,
      createdAt: Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : new Date().toISOString(),
    },
  };
}

/**
 * Copies only safe assistant final answers created after this call began into
 * its durable SSE log. Thread identity and executor metadata never cross the
 * mobile boundary.
 */
export async function syncMobileRealtimeThreadMirror(callId, options = {}) {
  const env = options.env || process.env;
  const dependencies = {
    listThreadMessageCandidates,
    recordMobileRealtimeMirrorMessage,
    ...(options.dependencies || {}),
  };
  const call = await getMobileRealtimeCallInternal(callId, env);
  if (!call || !ACTIVE_CALL_STATES.has(clean(call.status)) || !clean(call.threadId)) return [];
  // Calls created by an older release have no trustworthy start cursor. Do
  // not replay their thread history after a process upgrade.
  if (!Object.prototype.hasOwnProperty.call(call, "threadMirrorBaselineCursor")) return [];
  const candidates = await dependencies.listThreadMessageCandidates(call.threadId, {
    afterCursor: Math.max(0, Number(call.threadMirrorBaselineCursor || 0)),
  }, env);
  const visible = visibleThreadMessages(Array.isArray(candidates) ? candidates : []);
  const created = [];
  for (const candidate of visible) {
    const projected = safeMirrorMessage(call, candidate);
    if (!projected) continue;
    const event = await dependencies.recordMobileRealtimeMirrorMessage(
      call.id,
      projected.sourceMessageId,
      projected.message,
      env,
    );
    if (event) created.push(event);
  }
  return created;
}
