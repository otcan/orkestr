# Proposed Memory UI boundary

Contract reviewed for this proposal: `5d8f40104`,
[Memory service API](memory-service-api.md). HTTP leaf: `895b43def`, [wire contract](memory-http.md). Client state and raw-JSON
transport helpers are implemented and unmounted; the screen and shared server
registration remain separate work. Memory remains off by default.

UI ownership is limited to new `memory_state`, `memory_request` and
`memory_view` modules and their focused tests. Core owns contracts, Store and
consent validation. Isolation owns the server leaf; the coordinator owns shared registration. The
client uses only the exact pinned wire routes.

The screen starts with unknown server state, not a locally remembered opt-in.
An authenticated current-owner settings read is needed to distinguish disabled,
enabled and unavailable after reload. Login and visiting the screen never enable
Memory. Enabling storage requires a separate explicit owner action. Disabling
must not be described as deleting saved records; Forget is a separate action.

For each save, show the normalized structured proposal, scope and source before
a separate Remember or Approve action. A changed draft invalidates the reviewed
proposal and requires a new proposal/key. Only the exact returned proposal digest
may accompany the matching decision. Neither a digest nor an enabled service is
consent to save. Source labels do not confer trust or execution authority.
Correction and Forget bind the selected record ID and expected revision; stale
conflicts require refreshing and explicit review, never automatic resubmission
with a newer revision. Render remembered text as escaped data.

An uncertain write keeps the exact proposal, action, digest and key in volatile
owner/session-scoped state for explicit retry. A historical receipt is not a
current record: refresh after success, and do not restore forgotten content from
a receipt. Auth loss clears record/proposal content and invalidates callbacks.
Scope changes invalidate pending view generations; no foreign project results
may land in the new selection. No browser persistence of Memory content or
credentials is proposed.

Reads use one selected owned project and a bounded query (256 UTF8 bytes,
1..100 records). Show query-result limits honestly; no invented pagination or
corpus-wide count. Export is explicit and must refuse rather than silently
truncate beyond the canonical limit. No provider-context injection, automatic
capture, import, timer or send controls belong to this slice.

Core `160e9cf1b` supplies authenticated settings. The frozen HTTP query/export
response caps are 4 MiB/8 MiB including envelopes, with 422 instead of truncation.
Revisions remain raw JSON text in JavaScript and typed u64 in Rust. No integer
CAS value passes through JavaScript Number. Export download presentation is not
yet implemented. Do not infer enabled state from an empty result. Review
must cover normalized proposal confirmation, uncertain retry, stale correction,
forget/retry nonresurrection, owner/logout and project-generation fencing.

## Mounted Memory screen successor

The authenticated Memory tab now provides settings read/explicit enable-disable,
owner or selected-project retrieval (50 records), owner-authored fact proposals,
normalized per-record correction/forget review and explicit decisions. An
uncertain decision retains its exact typed tuple; a definitive conflict requires
fresh review. Navigation drops the view, cancels its owned request and clears
consent. Session generation checks discard callbacks after logout/owner change.
The selected project is part of the keyed view lifetime. Disabled observations
advance the consent generation and retain the disabled setting.

Export is a separate user action: the complete bounded response is typed and
owner-checked in Rust, then its original JSON text is offered as
`memory-export.json`. No JavaScript JSON-number conversion is used. Offering a
file does not prove it was saved. Query/export bounds remain 4/8 MiB; transport
also bounds read iterations, duration and cancellation. No browser acceptance
is claimed while the desktop lease service hold remains in force.

Memory export uses a tracked Eval and a synchronous WASM callback checking the
mounted view, authenticated session generation, and consent/scope generation.
The bridge announces readiness before Rust transfers bounded raw JSON; Rust
rechecks authority at that transfer. The browser checks the same live callback
before Blob allocation and immediately before the file offer. Retirement makes
the callback refuse, and dropping the export future removes its registered guard.
Synthetic delayed logout/drop and final-action refusal tests establish this
local action boundary; they do not establish downloaded or saved filesystem bytes.
