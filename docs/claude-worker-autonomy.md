# Bounded proactive autonomy for Claude worker threads

Claude worker threads can run a small amount of standing, unsupervised work
between explicit handoffs. This is opt-in per thread and stays inside a
permit/deny policy that only an admin-set, persisted, typed field can widen
(`agentReleaseRole` in `packages/core/src/agent-release-role.js`) -- chat,
task, or timer/autonomy-tick text can never widen it.

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
worker is told is through the admin-gated APIs below. A permit/deny policy is
always prepended when a mission is set, selected only by the thread's
persisted `agentReleaseRole` (default `worker`):

- **Permitted** (`worker`, the default -- `CLAUDE_AUTONOMY_MISSION_POLICY` in
  `packages/core/src/claude-standing-mission.js`): select explicitly unowned
  backlog work; inspect, implement, test, commit, and push changes only to
  the worker's own stored branch; choose a different safe task if blocked;
  report status or hand off to the parent thread.
- **Denied** (`worker`): merging, rebasing, or pushing `main` or any release
  branch; running releases, deploys, or production restarts; production or
  data repair; reading or writing secrets; sending external messages or
  writing to Jira; indefinite monitoring without separate explicit
  authorization.
- **`release_train`** (`CLAUDE_RELEASE_TRAIN_MISSION_POLICY`, granted only
  through `PUT /api/threads/:threadId/release-role`): additionally permits
  following docs/release-train.md -- inventorying/syncing workers,
  integrating, testing, pushing main/tags, watching CI, and deploying -- but
  only for a release phase the user has explicitly requested in the current
  conversation. Being ticked by a timer, or holding the role at all, is never
  itself that request. Force-pushing, destructive recovery, discarding dirty
  work, secrets access, and the rest of the worker denials still apply
  unchanged, and incomplete branch/fleet alignment must be reported honestly.

Threads with no standing mission set behave exactly as before -- no extra
system prompt is appended -- regardless of release role.

### Admin API

```
GET    /api/threads/:threadId/mission
PUT    /api/threads/:threadId/mission   { "mission": "text" }
DELETE /api/threads/:threadId/mission
```

Admin-only (`assertThreadAdminOnly`), length-capped
(`ORKESTR_CLAUDE_STANDING_MISSION_MAX_CHARS`, default 4000), and audited via
`thread_standing_mission_updated` / `thread_standing_mission_cleared` events.
This is intentionally not a general thread-patch route.

### CLI

```
orkestr thread mission get   <thread> [--json]
orkestr thread mission set   <thread> <mission text> [--json]
orkestr thread mission clear <thread> [--json]
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
