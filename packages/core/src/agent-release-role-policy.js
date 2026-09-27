// Pure release-role parsing and prompt selection. Keep this module free of
// thread-storage imports so it can safely be used while threads.js loads the
// Claude standing-mission helpers.

export const AGENT_RELEASE_ROLE_WORKER = "worker";
export const AGENT_RELEASE_ROLE_RELEASE_TRAIN = "release_train";
export const AGENT_RELEASE_ROLES = [AGENT_RELEASE_ROLE_WORKER, AGENT_RELEASE_ROLE_RELEASE_TRAIN];

function clean(value = "") {
  return String(value || "").trim();
}

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
