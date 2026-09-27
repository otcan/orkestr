import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import {
  AGENT_RELEASE_ROLES,
  agentReleaseRolePolicy,
  threadAgentReleaseRole,
} from "./agent-release-role-policy.js";
import { nextClaudeSystemPolicyRevision } from "./claude-system-policy-revision.js";

export {
  AGENT_RELEASE_ROLE_RELEASE_TRAIN,
  AGENT_RELEASE_ROLE_WORKER,
  AGENT_RELEASE_ROLES,
  agentReleaseRolePolicy,
  isReleaseTrainThread,
  threadAgentReleaseRole,
} from "./agent-release-role-policy.js";

// A thread's release authority is a typed, persisted field on the thread
// record — never free text. Chat instructions, task/handoff text, and timer
// or autonomy-tick prompts must never be parsed for role words; only this
// stored field may grant release-train authority, and only an admin-audited
// write path may change it.
function clean(value = "") {
  return String(value || "").trim();
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Unknown, missing, or malformed values fail closed to the safe default.
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
  const updated = await updateThread(before.id, {
    agentReleaseRole: normalizedRole,
    // Claude CLI resume sessions retain their original system context. Fence
    // the old session so this trusted role change takes effect next turn.
    claudeSystemPolicyRevision: nextClaudeSystemPolicyRevision(),
  }, env);
  await appendEvent({
    type: "thread_agent_release_role_changed",
    threadId: updated.id,
    previousRole,
    role: normalizedRole,
    actorUserId: clean(actorUserId) || null,
  }, env).catch(() => {});
  return { threadId: updated.id, role: threadAgentReleaseRole(updated), policy: agentReleaseRolePolicy(updated) };
}
