# Held input and run discovery: UI handoff

Proposal for Core's canonical additive read contract, not an implemented endpoint
or a browser acceptance claim. Core owns durable Stop boundaries and eligibility;
the server lifecycle owner owns retirement and restart. The UI does not release
input or reconstruct authority from these read fields.

Use a versioned owner/conversation-scoped activity projection with separately
paged run discovery and held inputs. The route owner must publish the exact
relative path and authenticated response before UI mounting. Do not change the
existing conversation snapshot or overload its journal cursor with inbox order.

The minimal held-input record is:

- `message_id`: canonical accepted message identity, used to find transcript text.
- `scope_sequence`: positive canonical reasoning-inbox sequence, not journal order.
- `reason`: the typed value `stop_boundary`.
- `stop_boundary`: exact `run_id`, committed cancellation-request `event_id`, and
  `through_scope_sequence` captured atomically by Core at the Stop boundary.

Records must belong to the selected authenticated conversation, have distinct
message identities and positive sequences no greater than their boundary, and
reference a committed boundary in that same scope. Pagination must be bounded
and stable under new admissions. No provider text, native locator, lease, fence,
credential or execution grant belongs in this projection. If Core cannot expose
an existing committed cancellation EventId, it must choose one canonical typed
boundary identity; the UI will not synthesize one from timestamps or revisions.

An absent hold record is not proof of dispatch eligibility. Input accepted after
the boundary is fresh owner intent, but native reap and Core eligibility still
govern admission. Native termination, restart, polling, progress or a new owner
message never implicitly release older held records. Repeated Stop boundaries
must preserve each input's actual provenance rather than assigning the latest
Stop to every row.

Run discovery needs only `run_id`, canonical role (`fast`, `deep`, `worker`), and
an optional typed parent run identity when Core has that relationship. Read
status through the registered exact-run execution query. Neither a run ID nor a
Deep registry entry supplies Worker Stop capability. Per-run progress is the
existing removable payload reference; no inferred shared progress is displayed.

Recovery is a distinct typed read state: unavailable, blocked, or eligible only
when Core has durable evidence. Native process exit is not eligibility. The
minimal UI can show recovery unavailable until that canonical field exists;
absence must not be mapped to resumable. No automatic resume or cancellation
control is added by this proposal. Explicit owner resume/cancel needs separately
reviewed request/receipt contracts and exact current capability.

The product displays “Held after Stop” with the original message and boundary
provenance, separate from running work and fresh queued input. It keeps the draft
editable. Until explicit hold actions exist, it says “This input is held” and
does not offer a button that drops, releases or batches it. Owner/logout and
selection generations fence every response; cached projections clear on owner
change. Local monotonic freshness and stale labels apply independently of any
server wall-clock time.

Acceptance for the later mounted consumer must cover pre-boundary input remaining
held through confirmed Stop, reap and restart; post-boundary input starting alone
only after eligibility; no duplicate or implicit batch; multiple Stop provenance;
exact-run Worker isolation; paging and stale/owner-switch responses. Synthetic
fixtures do not establish real-provider Stop or recovery acceptance.
