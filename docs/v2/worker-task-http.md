# Owner task HTTP composition

The optional private Worker policy `{"mode":"owner-tasks-v1","lifetime_ms":30000}`
enables ordinary owner-authored tasks. The parent session owns the scheduler and
polls at most four children, sharing the process-wide four-Worker capacity limit.
One fresh task is claimed per tick, after reserving actual child capacity. The
runtime retains that capacity and scratch directory until the child is reaped.
An empty task queue starts no Worker native process. The older
`parent-input-once-v1` policy remains a separate diagnostic mode.

Each claim creates its own canonical binding and native session. The scheduler
uses the existing metadata, delegation, admission, consume and control ports.
Task instructions come only from the durable task payload. A missing claim never
falls back to the parent's input. Current parent authorization is checked before
claim/setup/dispatch and each observation; parent Stop fences descendants in Core
and dropping the group initiates owned cleanup. A child error retains uncertain
durable evidence and does not retry the task or stop another child.

All task HTTP routes require the current browser cookie. Mutations additionally
require the existing Origin and CSRF checks; they accept no machine credentials,
provider authentication, native identity or source-message fields.

| Method and path under `/api/v2/conversations/{conversation}` | Input | Result |
| --- | --- | --- |
| `GET /worker-tasks?parent_run_id={run}` | Exact parent locator; unknown/duplicate query fields are rejected | `WorkerTaskList` |
| `POST /worker-tasks` | `WorkerTaskCreateRequest` | Immutable `WorkerTaskReceipt` |
| `POST /worker-tasks/{task}/hold` | `{}` | 204, or 409 when delegated work needs existing run Stop |
| `DELETE /worker-tasks/{task}/payload` | Task locator | 204; raw input removed, metadata preserved |

`WorkerTaskList.can_create` combines current Core eligibility with local owned
scheduler availability. It is an observation, not authorization. Fresh creation
is refused when the scheduler is absent; an identical request can still replay
its historical receipt after current owner authentication. Changed content
conflicts. Limits and task phases are defined in [Worker tasks](worker-tasks.md).
In particular, `claimed` does not assert that a process is alive. Only the normal
owner acceptance endpoint marks a task completed. Direct child Stop uses its
linked `run_id` and existing exact-run control revision.

The server factory owns one `WorkerTaskAccess::new(owner, conversation)` value.
It passes clones through `WorkerConfiguration.tasks` and
`AppState::with_worker_task_access`. AppState stores an optional
`worker_task_access`, initially absent. The factory continues to own all shared
module/route registrations. `WorkerSchedule::prepare` and `poll` keep their
existing signatures; a parent-owned registration closes availability when its
task group is dropped. The registry contains no credentials, prompts or provider
authority and has a 16-parent bound.

The independent HTTP probe runs only fresh synthetic installations and synthetic
native processes. It checks distinct instructions/native bindings, owner-only
acceptance, sibling-preserving child Stop, current authentication/control
refusals, a deliberately dropped create response, bounded parallelism, held and
deleted inputs, parent Stop, and actual owned-process cleanup. Peer trace records
include PID-namespace/start-time metadata and opaque UUID native identities so
PID namespaces cannot create artificial identity collisions. This probe proves
neither real provider execution nor browser usability, tool isolation, restart
recovery or full-release readiness.
