# Proposed Memory UI boundary

Contract reviewed for this proposal: `5d8f40104`,
[Memory service API](memory-service-api.md). This is a consumer design, not a
registered HTTP contract or implemented UI. Memory remains off by default.

UI ownership is limited to new `memory_state`, `memory_request` and
`memory_view` modules and their focused tests. Core owns contracts, Store and
consent validation. The server leaf and eventual shared registration need an
explicit owner before transport implementation; this document selects no routes.

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

Before wiring, agree the server leaf owner and exact settings-read, enable,
proposal, decision, query and export responses/errors. In particular, do not
infer enabled state from an empty result or invent a settings endpoint. Review
must cover normalized proposal confirmation, uncertain retry, stale correction,
forget/retry nonresurrection, owner/logout and project-generation fencing.
