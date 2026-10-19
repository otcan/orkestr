# Persistent beta intelligence roles

The optional `roles` section of the protected beta configuration enables Fast
and four fixed Worker launch slots alongside the Deep primary. It contains only
the launcher, launcher digest, and read-only workspace for each role. The
selected-service packager generates these profiles and gives each role or Worker
slot a separate private native home. Browsers cannot supply a launcher, native
session, provider credential, or budget.

All roles use the same authenticated owner, conversation, Core context, and
execution window. The one aggregate window retains its original 900-second,
32-attempt, 64-MiB limits in both proxy layers, including the 30-second,
4-attempt, 1-MiB cleanup reserve. Adding roles or admitting another ordinary
input does not create another budget. Only one conversation has an active
aggregate window at a time.

## Behavior

- **Deep** consumes the ordinary input and supports progress, Steer, Stop, and
  explicit owner acceptance.
- **Fast** independently presents each ordinary input admitted to that same
  window. It uses a different native session and has its own progress, Stop,
  and explicit acceptance. It does not consume the Deep inbox or support Steer.
- **Worker** runs an owner-created task under an exact live Running Deep parent.
  Up to four Workers may run concurrently, each with a fresh native session and
  the existing 30-second task policy. A Worker proposal still requires owner
  acceptance. Parent fencing, task hold, Stop, payload deletion, and selected
  run inspection retain their existing ordinary API semantics.

Native metadata setup for Deep and Fast completes before Core activation.
Inference starts only after activation. Each child passes the manager's exact
paused-child binding before FD3 readiness. Worker slots stay reserved until
their original child resources are reaped; dropping a scheduler alone cannot
make a slot reusable.

At retirement the factory retains the original Deep, Fast, and Worker reap
witnesses through the Core terminal transaction and manager close. An
unaccepted proposal remains pending after its transport is closed at the work
deadline. Unknown cleanup, a missing witness, or an unfinished role cannot
authorize a new conversation or a fresh budget. Restart uses Core's exact
closed predecessor and private FD4 resume grant; it never infers a native
session from directory contents.

## Discovery

Authenticated `GET /api/v2/conversations/{id}/intelligence` returns
`IntelligenceCapabilities`: `schema_version`, `conversation_id`, and `deep`,
`fast`, `worker` entries. Each entry contains `configured`, `available`, `stop`,
`steer`, `accept`, and `max_parallel`.

`configured` describes trusted server configuration. `available` indicates a
current role handle; for Worker it specifically requires a registered scheduler
under the current Running Deep parent. Operation flags describe supported
operations, including while the role is temporarily unavailable. Deep and Fast
have `max_parallel: 1`; Worker has `max_parallel: 4`. Unconfigured entries have
all flags false and `max_parallel: 0`.

These fields are observations, not grants. Clients must still use the existing
exact-run status, proposal, control, and task routes. An active handle does not
override a window deadline or make an operation eligible. Fast is a companion
presentation, and Worker is a task action; neither is another chat mode.
