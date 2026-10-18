# Worker task web surface

The execution panel exposes task creation and history for its selected parent.
The UI consumes the published task DTO from `3a762eda0302c68464766cd2fe120c0bde902742`.
It reads the exact parent execution status and the bounded task list through
cookie-authenticated relative routes. New creation requires a sampled positive
parent control revision and the list's `can_create` observation. Server-side
rechecks remain authoritative.

Independent title/instructions stay editable during requests. An uncertain
create retries the original parent, control revision, instructions and key;
a conflict requires explicit review before preparing a different request.
A receipt clears only the matching draft revision. Claimed means issued intent,
not a confirmed running worker. Completed is rendered as owner-accepted work.

Queued or claimed tasks can be held. Removing payload retains task history,
and cannot retract instructions already delivered. A successful removal masks
late list responses so removed titles do not reappear. Linked runs open the
existing exact-run execution surface for status, Stop and owner acceptance;
there is no parent-status fallback. Lineage appears under optional details.
The list does not expose instruction text, and no additional payload read route
is invented.

Each keyed parent owns its read channels and drafts. Serialized polling is
bounded to 64 KiB responses, aborts on drop, and checks owner generation before
writes. Refresh retires old read callbacks while preserving the task draft.
Authentication refusal expires the current session. Failed reads disable new
creation and disclose unavailable information; prior history remains labeled
by the current connection status.

This source checkpoint does not qualify server registration, a bundled candidate,
or actual browser behavior. Those require the coordinator's matching server/UI
pair and the independent managed-browser acceptance gate.
