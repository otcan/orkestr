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
when the store has none. Stop and steer capabilities remain false, and no control
success route is registered by this checkpoint.

The owned-server regression covers cookie authentication, empty and queued states,
restart/revision retention, unchanged intake rows, and auth/scope/Host/Origin
refusals. Ordinary provider transitions are tested separately by the runtime pump.
