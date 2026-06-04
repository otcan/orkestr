import { isNoReplyAssistantMessage } from "../../core/src/no-reply.js";

function clean(value) {
  return String(value || "").trim();
}

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function commentaryProgressMirrorEnabled(env = process.env) {
  return truthyEnv(env.ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES);
}

export function codexAssistantSource(message = {}) {
  return ["codex-rollout", "codex-app-server", "codex-app-server-import"].includes(clean(message?.source));
}

export function codexAssistantPhase(message = {}) {
  return clean(message?.phase || "final_answer").toLowerCase();
}

export function shouldSkipCodexAssistantMirror(message = {}) {
  return ["context_compaction"].includes(codexAssistantPhase(message));
}

export function shouldMirrorWhatsAppReply(message = {}) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (codexAssistantSource(message)) {
    const phase = codexAssistantPhase(message);
    if (shouldSkipCodexAssistantMirror(message)) return false;
    return !["commentary", "awaiting_approval"].includes(phase);
  }
  return true;
}

export function shouldMirrorWhatsAppProgress(message = {}, env = process.env) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (!codexAssistantSource(message)) return false;
  if (shouldSkipCodexAssistantMirror(message)) return false;
  const phase = codexAssistantPhase(message);
  if (phase === "awaiting_approval") return true;
  return phase === "commentary" && commentaryProgressMirrorEnabled(env);
}
