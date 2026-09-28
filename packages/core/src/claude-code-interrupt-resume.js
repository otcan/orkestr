import { appendEvent } from "../../storage/src/store.js";
import { findThreadMessage, listThreadMessageCandidates, updateThreadMessage } from "./threads.js";
import { parseThreadInputCommand } from "./thread-commands.js";
import { codexInputText } from "./codex-app-server-common.js";
import { getClaudeCodeSession, setClaudeCodeSession } from "./claude-code-sessions.js";

// Claude Code runs one `claude -p` process per turn with stdin closed after the
// prompt, so a mid-turn message cannot be steered into the running turn.
// Instead Orkestr interrupts the turn (SIGINT first, so the CLI can flush its
// session transcript), keeps the session id the interrupted turn reported, and
// resumes the same conversation with every message that arrived meanwhile
// coalesced into one follow-up turn.

export const CLAUDE_CODE_INTERRUPT_RESUME_NOTE =
  "[The previous turn was interrupted by a new message from the user. Continue from the current state.]";

export const CLAUDE_CODE_INTERRUPT_PENDING_STATE = "interrupt_resume_pending";

const pendingStates = ["queued", "pending_delivery"];
const disabledValues = new Set(["0", "false", "off", "no", "disabled", "disable"]);
const maxCoalescedInputs = 20;
// threadId -> turnId of the turn most recently stopped for an instant interrupt.
const instantInterruptedTurns = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function claudeCodeInstantInterruptEnabled(env = process.env) {
  return !disabledValues.has(clean(env.ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT).toLowerCase());
}

export function claudeCodeInterruptGraceMs(env = process.env) {
  const raw = clean(env.ORKESTR_CLAUDE_CODE_INTERRUPT_GRACE_MS);
  const value = raw ? Number(raw) : 3_000;
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : 3_000;
}

function inputRequestsSteer(message = {}) {
  const mode = clean(message.codexDeliveryMode).toLowerCase();
  if (mode === "passive") return false;
  return message.steerActiveTurn === true || mode === "instant_steer";
}

// An explicit interrupt (`/now`, "Send now", `orkestr send --now`) always
// applies; an implicit interactive steer input applies unless the kill switch
// ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT=0 restores plain queueing.
export function claudeCodeInputRequestsInterrupt(message = null, env = process.env) {
  if (!message || clean(message.role).toLowerCase() !== "user") return false;
  if (message.forceDeliveryAfterInterrupt === true) return true;
  return claudeCodeInstantInterruptEnabled(env) && inputRequestsSteer(message);
}

// Rewrites pending `/now <text>` inputs into their payload, flagged for
// interrupt-and-resume. A bare `/now` stays a control command (plain stop).
export async function normalizeClaudeCodeNowInputs(thread, messages = [], env = process.env) {
  const normalized = [];
  for (const message of messages) {
    const parsed = parseThreadInputCommand(message);
    const payload = clean(parsed.text);
    if (parsed.command !== "interrupt" || (!payload && !clean(message.promptFile))) {
      normalized.push(message);
      continue;
    }
    const patch = {
      text: payload,
      forceDeliveryAfterInterrupt: true,
      steerActiveTurn: true,
      codexDeliveryMode: "instant_steer",
      deliveryState: CLAUDE_CODE_INTERRUPT_PENDING_STATE,
      observedVia: "claude_code_now_command",
      error: null,
    };
    normalized.push(await updateThreadMessage(thread.id, message.id, patch, env).catch(() => ({ ...message, ...patch })));
  }
  return normalized;
}

// Called for a pending input that arrived while a turn is active. Idempotent:
// a second request for the same turn is reported as a duplicate, and a turn
// that already emitted its final result is left to complete naturally.
export async function requestClaudeCodeInstantInterrupt({ thread, supervisor, reason = "instant_interrupt", env = process.env } = {}) {
  if (!supervisor || supervisor.settled) return { interrupted: false, reason: "no_active_turn" };
  const turnId = clean(supervisor.attemptId);
  if (supervisor.interrupted) return { interrupted: true, duplicate: true, turnId };
  if (supervisor.resultObserved) return { interrupted: false, reason: "turn_completing", turnId };
  const graceMs = claudeCodeInterruptGraceMs(env);
  const sent = typeof supervisor.gracefulInterrupt === "function"
    ? supervisor.gracefulInterrupt(graceMs)
    : (supervisor.interrupt(), true);
  if (!sent) return { interrupted: Boolean(supervisor.interrupted), duplicate: true, turnId };
  instantInterruptedTurns.set(clean(thread.id), turnId);
  await appendEvent({
    type: "claude_code_turn_interrupt_requested",
    threadId: thread.id,
    turnId,
    mode: "graceful",
    reason,
    graceMs,
  }, env).catch(() => {});
  return { interrupted: true, turnId, mode: "graceful" };
}

// True when the thread's last turn was stopped by an instant interrupt and the
// next turn therefore needs the resume note. Consumes the marker.
export function consumeClaudeCodeInterruptResume(thread = {}) {
  const threadId = clean(thread.id);
  const turnId = instantInterruptedTurns.get(threadId);
  if (!turnId) return false;
  instantInterruptedTurns.delete(threadId);
  return clean(thread.runtime?.lastTurnStatus) === "interrupted" && clean(thread.runtime?.lastTurnId) === turnId;
}

// Pending interrupt inputs that directly follow `primary` in queue order and
// can share its resume turn. Control commands and passive inputs end the run
// so queue order is preserved.
export async function collectClaudeCodeResumeBatch(thread, primary, env = process.env) {
  if (!claudeCodeInputRequestsInterrupt(primary, env)) return [];
  const candidates = (await listThreadMessageCandidates(thread.id, { states: pendingStates }, env))
    .filter((message) => clean(message.role).toLowerCase() === "user");
  const index = candidates.findIndex((message) => message.id === primary.id);
  if (index < 0) return [];
  const following = await normalizeClaudeCodeNowInputs(thread, candidates.slice(index + 1, index + 1 + maxCoalescedInputs), env);
  const batch = [];
  for (const message of following) {
    if (!pendingStates.includes(clean(message.state))) break;
    if (!claudeCodeInputRequestsInterrupt(message, env)) break;
    if (parseThreadInputCommand(message).command) break;
    batch.push(message);
  }
  return batch;
}

export function claudeCodeResumePrompt(primary, coalesced = [], { interrupted = false } = {}) {
  if (!interrupted && !coalesced.length) return codexInputText(primary);
  const parts = [primary, ...coalesced].map((message) => clean(codexInputText(message))).filter(Boolean);
  return [interrupted ? CLAUDE_CODE_INTERRUPT_RESUME_NOTE : "", ...parts].filter(Boolean).join("\n\n");
}

const outcomePatches = {
  running: () => ({ state: "running", deliveryState: "delivering", observedVia: "claude_code_stream_json" }),
  completed: () => ({ state: "completed", deliveryState: "delivered", deliveredAt: nowIso(), observedVia: "claude_code_stream_json", error: null }),
  interrupted: () => ({ state: "completed", deliveryState: "delivered", deliveredAt: nowIso(), observedVia: "claude_code_interrupted", error: null }),
  failed: (error) => ({ state: "failed", deliveryState: "failed", error: error || "claude_code_failed" }),
};

// Keeps every coalesced input linked to the one executor turn that carried it.
export async function settleClaudeCodeCoalescedInputs(thread, primary, coalesced = [], outcome, attemptId, env = process.env, error = "") {
  if (!coalesced.length) return;
  const patch = outcomePatches[outcome]?.(error);
  if (!patch) return;
  for (const message of coalesced) {
    await updateThreadMessage(thread.id, message.id, {
      ...patch,
      executorKind: "claude-code",
      executorTurnId: attemptId,
      coalescedIntoMessageId: primary.id,
    }, env).catch(() => {});
  }
  if (outcome === "running") {
    await updateThreadMessage(thread.id, primary.id, { coalescedMessageIds: coalesced.map((message) => message.id) }, env).catch(() => {});
    await appendEvent({
      type: "claude_code_inputs_coalesced",
      threadId: thread.id,
      turnId: attemptId,
      messageId: primary.id,
      coalescedCount: coalesced.length,
    }, env).catch(() => {});
  }
}

// After a crash, inputs coalesced into the orphaned turn are still "running"
// under the same executor turn id; settle them like the correlated input.
export async function settleOrphanedClaudeCodeTurnInputs(thread, turnId, patch, env = process.env) {
  const settled = [];
  for (let index = 0; index < maxCoalescedInputs + 1; index += 1) {
    const message = await findThreadMessage(thread.id, { codexTurnId: turnId, role: "user", state: "running" }, env).catch(() => null);
    if (!message || clean(message.state) !== "running" || settled.includes(message.id)) break;
    await updateThreadMessage(thread.id, message.id, patch, env);
    settled.push(message.id);
  }
  return settled;
}

// The interrupted turn's own stream reports the session it ran under; keep it
// so the resumed turn continues the same transcript, including partial work.
export async function persistInterruptedClaudeCodeSession(thread, sessionId, env = process.env) {
  const next = clean(sessionId);
  if (!next) return false;
  try {
    if (await getClaudeCodeSession(thread, env) === next) return false;
    await setClaudeCodeSession(thread, next, env);
    return true;
  } catch {
    return false;
  }
}

export function resetClaudeCodeInterruptResumeForTest() {
  instantInterruptedTurns.clear();
}
