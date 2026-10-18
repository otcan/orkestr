# Timer web controls

The Timers navigation item opens a saved timer by its import-receipt ID. There
is no guessed list endpoint. Schedule, next due time and timezone labels come
from server metadata; displayed times use explicit UTC. No client clock,
generation, due claim, imported instruction or native authority is submitted.

The strict browser adapter follows server DTOs at
`1a92f5450cac9a3d896e242cbe38d7d3469aec34` and
the migration timer contract at `docs/v2/migration-audit/timer-http-contract.md`
in that checkpoint. GET polls the
exact namespace. Enable uses fresh editable owner text and the selected
conversation; disable, schedule stop and rollback use the sampled revision.
Only the `execution-controls` build exposes enabled mutation buttons. This
feature flag does not establish server availability or permission.

Uncertain retries preserve the original operation, body, revision and key even
when the draft changes. Conflict requires explicit review and a new request;
refusals preserve the draft. A success is current metadata, not an immutable
execution receipt. Edits made during the request survive confirmation. Timer
stop is not a claim that already admitted work was interrupted.

Polling and mutation callbacks are fenced by authenticated session generation
and mounted timer/conversation identity. Disposal aborts owned requests. Refresh
invalidates old read callbacks while retaining the editable draft. Fresh reads
are required before new mutations. Auth refusal invokes the shared expiry path.

Enabled and locally armed are distinct. Restart or expired grants require
explicit owner rearm; the UI discloses the one-hour grant limit. Dormant reasons
remain held, and unsupported or unavailable details never imply readiness.
Identity and source digest are in optional provenance details.

This source checkpoint does not qualify server registration, actual timer
delivery, long-lived unattended execution, or managed-browser behavior. The
server owner must register the reviewed leaf with shared auth and lifecycle;
the coordinator owns the matching artifact pair and subsequent browser gate.
