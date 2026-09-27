import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";

// A thread's release authority is a typed, persisted field on the thread
// record — never free text. Chat instructions, task/handoff text, and timer
// or autonomy-tick prompts must never be parsed for role words; only this
// stored field may grant release-train authority, and only an admin-audited
// write path may change it.
export const AGENT_RELEASE_ROLE_WORKER = "worker";
export const AGENT_RELEASE_ROLE_RELEASE_TRAIN = "release_train";
export const AGENT_RELEASE_ROLES = [AGENT_RELEASE_ROLE_WORKER, AGENT_RELEASE_ROLE_RELEASE_TRAIN];

function clean(value = "") {
  return String(value || "").trim();
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Unknown, missing, or malformed values fail closed to the safe default.
export function threadAgentReleaseRole(thread = {}) {
  const value = clean(thread?.agentReleaseRole).toLowerCase();
  return AGENT_RELEASE_ROLES.includes(value) ? value : AGENT_RELEASE_ROLE_WORKER;
}

export function isReleaseTrainThread(thread = {}) {
  return threadAgentReleaseRole(thread) === AGENT_RELEASE_ROLE_RELEASE_TRAIN;
}

const WORKER_ROLE_LABEL = "worker thread. You are not the parent/root Orkestr thread.";
const WORKER_POLICY_LINES = [
  "Rules:",
  "- Work only inside this worker worktree and branch.",
  "- Do not modify the parent checkout.",
  "- Do not merge into, push to, or otherwise mutate main from this worker thread.",
  "- The parent/root Orkestr thread owns integration, merge-to-main, push-to-main, tags, and release actions.",
  "- If asked to merge or push main, report your branch status and tell the parent/root thread to perform the integration.",
  "- Keep commits scoped to this branch.",
  "- Report changed files, verification commands, and any merge notes when done.",
];

const RELEASE_TRAIN_ROLE_LABEL = "release train, granted explicitly by an admin through the persisted agentReleaseRole field.";
const RELEASE_TRAIN_POLICY_LINES = [
  "Rules (release train role — see docs/release-train.md for the full runbook):",
  "- You may inventory and sync workers, integrate worker branches, run tests, push to main and tags, watch CI, and deploy, following every phase in docs/release-train.md.",
  "- Perform merge-to-main, tagging, pushing, watching CI, or deploying only when the user has explicitly requested that specific release phase in the current conversation.",
  "- A scheduled timer or autonomy tick may inventory and report status, but must never by itself authorize merge-to-main, tagging, push, or deploy.",
  "- Never discard user work; checkpoint dirty worker or parent changes with a normal commit before integrating.",
  "- Never force-push, and never run destructive recovery (for example git reset --hard, or discarding uncommitted work) unless the user explicitly asks for that specific destructive action on a branch that is not shared release history.",
  "- Never read or expose secrets, credentials, or tokens as part of any release step.",
  "- If any worker or release branch is not cleanly fast-forwarded or aligned after main moves, report the exact blocker honestly instead of declaring the train complete.",
];

// The ONLY input to this selection is the trusted, persisted field on the
// thread record. There is no free-text matching of chat, task, or handoff
// content — a message that merely claims release-train authority changes
// nothing here.
export function agentReleaseRolePolicy(thread = {}) {
  const role = threadAgentReleaseRole(thread);
  const releaseTrain = role === AGENT_RELEASE_ROLE_RELEASE_TRAIN;
  return {
    role,
    roleLabel: releaseTrain ? RELEASE_TRAIN_ROLE_LABEL : WORKER_ROLE_LABEL,
    promptLines: releaseTrain ? [...RELEASE_TRAIN_POLICY_LINES] : [...WORKER_POLICY_LINES],
    promptText: (releaseTrain ? RELEASE_TRAIN_POLICY_LINES : WORKER_POLICY_LINES).join("\n"),
    canMergeToMain: releaseTrain,
    canPushMain: releaseTrain,
    canTag: releaseTrain,
    canDeploy: releaseTrain,
    requiresExplicitPhaseRequest: releaseTrain,
  };
}

export async function getThreadAgentReleaseRole(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  return { threadId: thread.id, role: threadAgentReleaseRole(thread), policy: agentReleaseRolePolicy(thread) };
}

export async function setThreadAgentReleaseRole(threadId, role, { actorUserId = "" } = {}, env = process.env) {
  const normalizedRole = clean(role).toLowerCase();
  if (!AGENT_RELEASE_ROLES.includes(normalizedRole)) throw httpError("agent_release_role_invalid", 400);
  const before = await getThread(threadId, env);
  if (!before) throw httpError("thread_not_found", 404);
  const previousRole = threadAgentReleaseRole(before);
  const updated = await updateThread(before.id, { agentReleaseRole: normalizedRole }, env);
  await appendEvent({
    type: "thread_agent_release_role_changed",
    threadId: updated.id,
    previousRole,
    role: normalizedRole,
    actorUserId: clean(actorUserId) || null,
  }, env).catch(() => {});
  return { threadId: updated.id, role: threadAgentReleaseRole(updated), policy: agentReleaseRolePolicy(updated) };
}
