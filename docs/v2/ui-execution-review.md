# Web execution review candidate

The web UI reads removable provider output through the reviewed owner-scoped
`GET /api/v2/conversations/:id/payloads/:payload_id` route. It checks the
conversation, run and payload identities, renders text as plain text, and treats
`text: null` as removed. Explicit removal uses the same path with DELETE and
CSRF. A failed removal never claims success.

Acceptance is an explicit owner action. The exact completion event and run come
from a validated production completion proposal or the canonical optional
`ExecutionStatus.acceptance_candidate` read projection. Fresh matching
AwaitingAcceptance status supplies the expected durable revision. Progress is
never completion, and provider completion is never automatic acceptance.
Reload discovery uses the same canonical status projection; no guessed latest
event or text-derived identifier is sent.

The selected Runtime route is POST `/api/v2/conversations/:id/accept` with only
`run_id`, `completion_event_id`, `expected_revision` and `request_key`.
Browser cookies and in-memory CSRF authenticate the request; the browser supplies
Origin. No owner identity, credential or provider authority is placed in JSON.
Server composition must recheck the exact current browser credential inside the
acceptance transaction, including receipt retries.

An uncertain reply retains the exact original request. This also permits receipt
recovery after status advances to Completed. A definitive conflict shows a
refresh/review notice. Reviewing a newer revision is a separate explicit action
before a new acceptance request can be generated. Navigation preserves correctly
scoped pending requests; logout/owner changes clear them and fence callbacks.
These actions do not mutate composer drafts or infer acceptance from errors.

The default web build keeps Stop and acceptance disabled. A matching, reviewed
server candidate can be bundled with `UI_EXECUTION_CONTROLS=1` and its exact
40-character `UI_SERVER_CANDIDATE` SHA through `scripts/bundle.sh`; this enables
the dependency-free `execution-controls` crate feature. The coordinator must
register the matching server composition before building/serving that candidate.
The opt-in is not a server capability grant: canonical run/capability/state and
server authentication/conflict checks still apply. Steering remains unavailable.

Contract discovery provenance: ec38c13b962bccbd7c3a64e5d32a2c27e33fc83e.
Acceptance input/receipt provenance: 58e8074099e12d8a2b62a864fc8f400e8d28f367.
Session-bound Store composition provenance: f6a211fbbd4316fd648455b68927abf4721e81c0.

Fresh browser scenarios for the combined candidate must cover provider output
loading/removal, exact Stop retry through uncertain failure, explicit completion
acceptance with stale-conflict/retry, authenticated-owner changes and editable
composer drafts. The earlier browser evidence for the read-only candidate does
not validate this bundle or its controls.
