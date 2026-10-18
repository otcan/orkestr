# Execution read route

`GET /api/v2/conversations/:id/execution` uses the existing server authentication
and Host/Origin guards. Browser clients use the current same-origin cookie.
Owner identity comes from authentication, never the URL or request body.

- `200`: canonical validated `ExecutionStatus` for that conversation.
- `204`: no execution or queued input; clear client execution/control authority.
- `400`: malformed conversation identifier.
- `404`: conversation unavailable to the authenticated owner.
- `503`: storage or projection unavailable; no fabricated status.

Responses retain `Cache-Control: no-store`. The read does not advance revision
or alter admission. Revision is per conversation; read-time sampling follows
`ExecutionStatus::same_revision_state`. Optional resources/progress remain absent
when the store has none. Stop is true only when the ordinary factory has the
exact running transport registered; steer remains unavailable.

An optional `?run_id=<uuid>` selects one exact run, including an independent
Worker. This form requires a current browser cookie and the configured bound
supervisor. Core authenticates the browser credential, owner, conversation, run
and supervisor in the same read snapshot. No machine credential or native
authority is accepted through the query. Missing runs return 404; malformed,
nil, duplicate or unknown query parameters return structured 400. An inactive
factory returns 503. Default conversation projection continues to select Deep.

`control_revision` is the exact run's positive control-state revision. Progress
and sibling runs still advance the conversation `revision`, without invalidating
the sampled control precondition. Neither value grants authority by itself.

The owned-server regression covers cookie authentication, empty and queued states,
restart/revision retention, unchanged intake rows, and auth/scope/Host/Origin
refusals. Ordinary provider transitions are tested separately by the runtime pump.
