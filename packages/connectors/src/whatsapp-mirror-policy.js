import { isNoReplyAssistantMessage } from "../../core/src/no-reply.js";

function clean(value) {
  return String(value || "").trim();
}

export function codexAssistantSource(message = {}) {
  return ["codex-rollout", "codex-app-server", "codex-app-server-import"].includes(clean(message?.source));
}

export function codexAssistantPhase(message = {}) {
  return clean(message?.phase || "final_answer").toLowerCase();
}

const codexProgressPhases = new Set(["commentary", "awaiting_approval", "context_compaction"]);

export function shouldMirrorWhatsAppReply(message = {}) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (codexAssistantSource(message)) {
    const phase = codexAssistantPhase(message);
    return !codexProgressPhases.has(phase);
  }
  return true;
}

export function shouldMirrorWhatsAppProgress(message = {}, env = process.env) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (!codexAssistantSource(message)) return false;
  const phase = codexAssistantPhase(message);
  return codexProgressPhases.has(phase);
}
