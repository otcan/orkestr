import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { agentReleaseRolePolicy, isReleaseTrainThread } from "./agent-release-role-policy.js";
import { sanitizeStandingMissionText } from "./claude-standing-mission.js";
import { listThreadMessages } from "./threads.js";

// Executor-neutral context checkpoints. The safe-reset checkpoint and the
// executor-switch handoff share the message rendering below; only the switch
// handoff is ever delivered back to a model (once, as a turn preamble).

const execFileAsync = promisify(execFile);
const pendingInputStates = new Set(["queued", "pending_delivery", "awaiting_ack"]);

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function executorLabel(executor = "") {
  const value = clean(executor).toLowerCase();
  if (value === "claude-code") return "Claude Code";
  if (value === "codex") return "Codex";
  return value || "unknown";
}

// Options are an object so Array#map(checkpointMessageText) stays safe.
export function checkpointMessageText(message, options = {}) {
  const maxChars = Number(options?.maxChars) || 0;
  const role = clean(message?.role || "unknown");
  const phase = clean(message?.phase || "");
  const stamp = clean(message?.timestamp || message?.createdAt || "");
  let text = clean(message?.text || "");
  if (maxChars > 0 && text.length > maxChars) text = `${text.slice(0, maxChars)}\n[truncated]`;
  const header = [role, phase, stamp].filter(Boolean).join(" ");
  return [`### ${header || "message"}`, "", text || "(empty)"].join("\n");
}

export async function contextCheckpointPath(thread, kind, env = process.env) {
  const paths = await ensureDataDirs(env);
  const dir = path.join(paths.home, "context-checkpoints", thread.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${nowIso().replace(/[:.]/g, "-")}-${kind}.md`);
}

async function gitOutput(cwd, args, timeoutMs) {
  const result = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 });
  return String(result.stdout || "").trimEnd();
}

// Best effort and time bounded: a missing repo or a slow filesystem must never
// block an executor switch.
export async function workspaceGitSnapshot(cwd = "", env = process.env) {
  const dir = clean(cwd);
  if (!dir) return null;
  const timeoutMs = positiveInt(env.ORKESTR_EXECUTOR_HANDOFF_GIT_TIMEOUT_MS, 3000);
  try {
    const [branch, head, status] = await Promise.all([
      gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
      gitOutput(dir, ["rev-parse", "--short", "HEAD"], timeoutMs),
      gitOutput(dir, ["status", "--short"], timeoutMs),
    ]);
    const lines = status ? status.split("\n") : [];
    return { branch, head, status: lines.slice(0, 60), statusTruncated: lines.length > 60 };
  } catch {
    return null;
  }
}

function roleLines(thread = {}) {
  if (clean(thread.parentThreadId)) {
    const policy = agentReleaseRolePolicy(thread);
    return [`- Role: ${policy.roleLabel}`, `- Parent Orkestr thread: ${clean(thread.parentThreadId)}`];
  }
  if (isReleaseTrainThread(thread)) return [`- Role: ${agentReleaseRolePolicy(thread).roleLabel}`];
  return ["- Role: primary agent for this Orkestr thread (it has no parent thread)."];
}

function conversationMessages(messages = []) {
  return messages.filter((message) => {
    const role = clean(message?.role);
    return (role === "user" || role === "assistant") && clean(message?.text);
  });
}

function lastFinalAnswer(messages = []) {
  return [...messages].reverse().find((message) =>
    clean(message?.role) === "assistant" && ["", "final_answer"].includes(clean(message?.phase))) || null;
}

async function openTimerCount(thread, env) {
  try {
    const { listTimers } = await import("./timers.js");
    return (await listTimers(env)).filter((timer) =>
      timer.enabled !== false &&
      clean(timer.targetType || "thread") === "thread" &&
      [timer.target, timer.threadId].map(clean).includes(thread.id)).length;
  } catch {
    return null;
  }
}

export function executorHandoffIntro(thread = {}, from = "", to = "") {
  return [
    `Orkestr executor switch: this is the same Orkestr thread (${thread.id}), with the same owner and the same authority as before.`,
    `The previous executor was ${executorLabel(from)}. You (${executorLabel(to)}) are now the active agent for this thread.`,
    "The handoff below is background context from the thread history. Continue the work from it; do not repeat completed steps.",
  ].join("\n");
}

export async function buildExecutorHandoff(thread, context = {}, env = process.env) {
  const limit = positiveInt(context.messageLimit || env.ORKESTR_EXECUTOR_HANDOFF_MESSAGES, 40);
  const perMessage = positiveInt(env.ORKESTR_EXECUTOR_HANDOFF_MESSAGE_CHARS, 4000);
  const all = await listThreadMessages(thread.id, env).catch(() => []);
  const sinceMs = Date.parse(clean(context.since));
  const conversation = conversationMessages(all);
  const scoped = Number.isFinite(sinceMs)
    ? conversation.filter((message) => Date.parse(clean(message.createdAt || message.timestamp)) > sinceMs)
    : conversation;
  const recent = scoped.slice(-limit);
  const final = lastFinalAnswer(conversation);
  const git = await workspaceGitSnapshot(thread.cwd || thread.workspace || thread.worktreePath, env);
  const pendingCount = all.filter((message) => clean(message.role) === "user" && pendingInputStates.has(clean(message.state))).length;
  const timers = await openTimerCount(thread, env);
  const mission = sanitizeStandingMissionText(thread.standingMission, env);
  const lines = [
    `# Executor Handoff: ${thread.name || thread.id}`,
    "",
    executorHandoffIntro(thread, context.from, context.to),
    "",
    "## Thread",
    "",
    `- Thread: ${thread.id}`,
    `- Created: ${nowIso()}`,
    `- Previous executor: ${executorLabel(context.from)}`,
    `- Active executor: ${executorLabel(context.to)}`,
    ...(clean(context.reason) ? [`- Switch reason: ${clean(context.reason)}`] : []),
    ...roleLines(thread),
    `- Working directory: ${clean(thread.cwd || thread.workspace) || "(none)"}`,
    ...(git ? [
      `- Branch: ${git.branch || "(unknown)"}`,
      `- HEAD: ${git.head || "(unknown)"}`,
      `- Git status (short): ${git.status.length ? "" : "clean"}`,
      ...git.status.map((line) => `    ${line}`),
      ...(git.statusTruncated ? ["    ..."] : []),
    ] : []),
    `- Pending queued inputs: ${pendingCount}`,
    `- Open timers: ${timers === null ? "unknown" : timers}`,
    "",
    ...(mission ? ["## Standing Mission", "", mission, ""] : []),
    `## Previous Executor's Last Final Answer`,
    "",
    final ? checkpointMessageText(final, { maxChars: perMessage }) : "(none)",
    "",
    Number.isFinite(sinceMs)
      ? `## Messages Since ${executorLabel(context.to)} Last Ran (${recent.length})`
      : `## Recent Messages (${recent.length})`,
    "",
    ...(recent.length ? recent.map((message) => checkpointMessageText(message, { maxChars: perMessage })) : ["(none)"]),
    "",
  ];
  return { content: lines.join("\n"), messageCount: recent.length, pendingCount, timerCount: timers, git };
}

export async function writeExecutorHandoff(thread, context = {}, env = process.env) {
  const handoff = await buildExecutorHandoff(thread, context, env);
  const handoffPath = await contextCheckpointPath(thread, "executor-switch", env);
  await fs.writeFile(handoffPath, handoff.content, { mode: 0o600 });
  await appendEvent({
    type: "thread_executor_handoff_written",
    threadId: thread.id,
    path: handoffPath,
    from: context.from || null,
    to: context.to || null,
    messageCount: handoff.messageCount,
  }, env).catch(() => {});
  return { path: handoffPath, messageCount: handoff.messageCount, content: handoff.content };
}
