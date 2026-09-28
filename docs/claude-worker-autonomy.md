# Bounded proactive autonomy for Claude worker threads

Claude worker threads can run a small amount of standing, unsupervised work
between explicit handoffs. This is opt-in per thread and stays inside a
permit/deny policy that only an admin-set, persisted, typed field can widen
(`agentReleaseRole`, read via `threadAgentReleaseRole` in
`packages/core/src/agent-release-role-policy.js`, written only through the
admin-gated `packages/core/src/agent-release-role.js` API) -- chat, task, or
timer/autonomy-tick text can never widen it. Unknown, missing, or malformed
values fail closed to `worker`.

## Standing mission

A worker's `handoffPrompt` (or a task-agent's `agentTaskPrompt`) is delivered
once, as the first message. The standing mission is different: it is a short,
admin-set field re-delivered on **every** Claude turn through the same
`--append-system-prompt` path already used for the failed-turn notice
(`packages/core/src/claude-code-client.js`). The two coexist; neither replaces
the other.

Only the thread's own persisted `standingMission` and `agentReleaseRole`
fields feed this text -- never message content, tool output, task/handoff
text, or anything else a turn produced -- so the only way to change what a
worker is told is through the admin-gated APIs below. When a mission is set,
`resolveStandingMissionPolicy` (`packages/core/src/claude-standing-mission.js`)
prepends a permit/deny policy selected only by `agentReleaseRolePolicy(thread)`
(`packages/core/src/agent-release-role-policy.js`) -- the same function that
builds the one-time worker handoff prompt's role line and rules
(`packages/core/src/thread-workers.js`), so both prompt surfaces state
identical permissions instead of two independently maintained copies:

- **`worker`** (default -- `CLAUDE_AUTONOMY_MISSION_POLICY` in
  `claude-standing-mission.js`): select explicitly unowned backlog work;
  inspect, implement, test, commit, and push changes only to the worker's own
  stored branch; choose a different safe task if blocked; report status or
  hand off to the parent thread. Denied: merging, rebasing, or pushing `main`
  or any release branch; running releases, deploys, or production restarts;
  production or data repair; reading or writing secrets; sending external
  messages or writing to Jira; indefinite monitoring without separate
  explicit authorization.
- **`release_train`** (granted only through
  `PUT /api/threads/:threadId/release-role`): additionally permits
  inventorying and syncing workers, integrating worker branches, testing,
  pushing to main and tags, watching CI, and deploying, following every phase
  in docs/release-train.md -- but merge-to-main, tagging, push, or deploy only
  when the user has explicitly requested that specific release phase in the
  current conversation. A scheduled timer or autonomy tick may inventory and
  report status but never by itself authorizes those actions. Every worker
  denial still applies unchanged (no force-push or destructive recovery
  without an explicit request naming that action on non-shared-release-history
  branches, no discarding dirty work instead of checkpointing it first, no
  secrets access, no external messages/Jira), and incomplete branch/fleet
  alignment must be reported honestly instead of declaring the train complete.

Threads with no standing mission set behave exactly as before -- no extra
system prompt is appended -- regardless of release role.

### Policy-revision session fencing

A resumed Claude Code CLI session (`--resume`) can otherwise retain context
from before an admin changed what a thread is told. Setting or clearing the
standing mission, and changing `agentReleaseRole`, all bump the thread's
`claudeSystemPolicyRevision` (`packages/core/src/claude-system-policy-revision.js`,
a fresh `crypto.randomUUID()` each time). `getClaudeCodeSession`
(`packages/core/src/claude-code-sessions.js`) only returns a stored session id
when its saved `policyRevision` still matches the thread's current one; a
mismatch is treated as no session, so the next turn starts a fresh,
non-resumed Claude CLI process instead of one that could carry forward
pre-change policy or mission text.

The standing headless runtime notice (see
[runtime control](runtime-control.md#claude-code-turn-limits-and-visibility))
is appended on every turn, including resumed ones, so changing its wording
takes effect on the next turn without a policy-revision bump.

### Admin API

```
GET    /api/threads/:threadId/mission
PUT    /api/threads/:threadId/mission   { "mission": "text" }
DELETE /api/threads/:threadId/mission
GET    /api/threads/:threadId/release-role
PUT    /api/threads/:threadId/release-role   { "role": "worker" | "release_train" }
```

Admin-only (`assertThreadAdminOnly`). The mission API is length-capped
(`ORKESTR_CLAUDE_STANDING_MISSION_MAX_CHARS`, default 4000) and audited via
`thread_standing_mission_updated` / `thread_standing_mission_cleared` events;
the release-role API is audited via `thread_agent_release_role_changed`
(`packages/core/src/agent-release-role.js`). Neither is a general
thread-patch route.

### CLI

```
orkestr thread mission get   <thread> [--json]
orkestr thread mission set   <thread> <mission text> [--json]
orkestr thread mission clear <thread> [--json]
orkestr worker release-role get <thread> [--json]
orkestr worker release-role set <thread> <worker|release_train> [--json]
```

## Orphaned turn recovery

A Claude Code turn runs as a per-turn child process tracked only in that
server process's memory. If the server restarts (or crashes) mid-turn, the
in-memory tracking is gone but `thread.runtime.activeTurnId` and the
correlated message's `"running"` state are not. `packages/core/src/claude-code-orphan-turn-recovery.js`
sweeps for exactly this case as part of the existing runtime-sync pass
(`apps/server/src/server-runtime-sync.ts`, alongside the Codex app-server
recovery it already ran).

Recovery only acts when it can positively correlate `thread.runtime.activeTurnId`
with a `role: "user"`, `state: "running"` message via `executorTurnId`. If a
completed final answer for that turn already exists, the input is completed
(never replayed, since prior tool calls may have had side effects); otherwise
the message is marked failed/interrupted and the runtime's active-turn state
is cleared. A thread with a live in-process supervisor, or no confidently
correlated message, is left untouched. Clearing the active-turn id makes a
second pass a no-op.

## Own-branch push

`packages/core/src/worker-branch-push.js` exposes a narrow, explicit action:
push a worker's own stored branch to `origin`, nothing else.

```
POST /api/threads/:threadId/push-branch     (admin-only)
orkestr worker push-branch <worker-thread>
```

Before pushing it verifies, in order: the thread has a `parentThreadId` (is a
worker), the stored `branchName` is neither `main`/`master` nor the thread's
`baseBranch`, the branch name itself is a valid git ref, checkout ownership
passes (`assertWorkerGitOwnership`), the checked-out `HEAD` branch matches the
stored branch exactly, `origin`'s URL matches the thread's stored
`repoRemoteUrl`, and the remote has no commits the worker doesn't already have.
The push refspec is always `HEAD:refs/heads/<branch>` -- never `--force`, never
an arbitrary refspec. On success it persists `remoteBranch` on the thread and,
when service and checkout share an identity, sets the local tracking branch.
When the Orkestr service is privileged but the checkout belongs to a runtime
user, it validates that checkout as its owner, copies the exact branch into an
isolated temporary bare repository, and pushes from there. This avoids leaving
root-owned refs, locks, or config in the worker checkout; in that case the
persisted `remoteBranch` is the canonical upstream state.

## Recurring autonomy tick (opt-in)

No new timer API is needed: the existing `POST /api/timers` already supports
a thread-targeted prompt on a cadence. Point one at a worker with
`CLAUDE_AUTONOMY_TICK_PROMPT` (exported from `claude-standing-mission.js`) as
the prompt text:

```json
{
  "targetType": "thread",
  "target": "<worker-thread-id>",
  "cadence": "hourly",
  "prompt": "Autonomy tick: review your standing mission. Take at most one safe, bounded unit of work toward it..., then stop. ..."
}
```

Each tick instructs the worker to review its standing mission, take at most
one safe unit of work, or report idle/blocked -- it does not itself send any
WhatsApp message. This is deliberately opt-in per thread; nothing schedules a
recurring tick automatically.
