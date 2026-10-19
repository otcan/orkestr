# Held-input web consumer

Core contract `1e9d6d5addf00cad270154dfdc60efd3fcedd375` supplies the typed
held page. Core read-route decision `473cdd207` selects browser-only
`GET /api/v2/conversations/{id}/held-inputs?after_sequence=0&limit=50`.
Subsequent pages use the exact exclusive `next_after_sequence`, an inbox
sequence rather than the SSE journal cursor. Each page is a fresh authenticated
read, not a stable export. Server registration remains the factory owner's work.

The conversation surface shows exact saved message/source event, Stop boundary
run/event, held-through sequence and reason. A fresh eligible input is described
as queued separately, never as proof of native cleanup, restart readiness or
permission to release old input. The UI does not delete, resume or batch replay
held input. Resume and Cancel controls remain disabled with visible reasons:
no canonical mutation DTO, transaction or HTTP route has been published.

Polling uses relative URLs and same-origin browser cookies, bounded response
bodies, serialized fetches and disposal aborts. Owner/logout changes clear the
projection. Read generations and conversation/cursor validation fence late
responses; invalid pages preserve prior evidence. Identical replay retains the
original monotonic freshness anchor. Page navigation hides the previous page
while the next bounded page loads. The composer and drafts are independent.

Consumer tests cover fresh-input independence, immutable Stop provenance,
owner/pagination fences, malformed boundary/cursor refusal, backwards revisions
and identical replay staleness. Bridge tests cover the selected read path and
reject negative, repeated or authority-bearing query variants. These are not
mounted browser or native lifecycle acceptance. The coordinator must pair this
source with reviewed read-route registration before browser qualification.

Held-message previews use only the already-loaded bounded conversation window,
matched by conversation and exact message identity, truncated to 180 Unicode
characters. Missing text and missing saved time are disclosed; viewing a held
page never expands the history fetch. Provenance remains under optional details.
