# Beta UI checkpoint

The beta shell exposes Assistant, History, Host resources and Settings for one
configured Codex Deep conversation. Native setup/sign-in, editable page-scoped
drafts, reconnect, canonical history, held inputs, saved thread files, progress,
owner acceptance, Stop and capability-gated steering reuse the existing flows.
Fast, Worker, Memory, timers, external reply controls and project provisioning
are not mounted in this shell. Deferred source remains in the repository.

After native sign-in or session resume, the shell requires authenticated beta
discovery before mounting chat or history. The browser session's global
conversation is not used as a configured-conversation fallback. Core owns window DTOs and Runtime owns GET
`/api/v2/beta` and GET/POST `/api/v2/conversations/:id/window`.

Message intake and window admission are distinct. A durable message receipt does
not prove that execution was admitted or started. A failed or uncertain window
request must keep that input visibly queued and retain its immutable retry tuple.
Opening is not active; reconciliation is not permission to restart. No credential,
account, native path or provisioning authority comes from this UI.

This is a source checkpoint. No native/WASM build, browser run or paired-candidate
acceptance is attributed to it. Installation owns the frozen matching build.

The unmounted beta request helper uses only the selected relative capability and
window routes, browser cookies and CSRF for writes. It preserves serialized
request integers verbatim, bounds response bytes and read iterations, and aborts
on caller cancellation. Its six Node transport tests do not validate the pending
Core window DTO or prove server integration. Typed decoding and mounting await
that exact source checkpoint; no admission is inferred from a transport result.

Discovery consumes exact Runtime `1b2dc432b` types through the bounded raw-text
bridge. Scope generation and component disposal fence late responses. Unknown
schema, nil conversation, unexpected limits or foreign window scope refuse
mounting. This does not activate window admission; sampled controls grant no
authority. Core `c8beddef8` generation validation is consumed unchanged.

Explicit admission is now mounted separately from Send. The page retains at most
128 durable intake receipts across tab/reconnect remounts; it refuses further
Send actions at capacity without dropping older entries. Owner/session changes
clear this private page state. Reload recovery of a lost page's unadmitted
receipts is not provided by this slice; durable server history remains intact.

Start work uses a new window request; Add to current work binds the active
window without changing its generation or budget. Uncertain replies retain the
entire original tuple. Definitive refusals require review; a verified admission
receipt removes only its matching saved input and triggers current-status reads.
No historical receipt sets active state. Opening, retiring and reconciliation
block fresh admission. The consumer expects GET window 204 for absence, 200 for
a canonical status and POST 200/201 for canonical admission; Runtime composition
must confirm these response statuses before matching candidate acceptance.

Focused wrapper-locked/offline checks pass: six Rust state/receipt cases and UI
binary check; six Node transport cases pass. These are source/model checks, not
mounted browser, Store composition, provider or cleanup acceptance. A first
binary check exposed a temporary borrow error; the request clone now releases
the immutable borrow before preparing intent, and the subsequent check passes.

Independent source review found the initial mounted admission intent was not
conversation-keyed: the App retained one intent, so a pending request from A
could be sent to current route B and success could remove the rendered row.
This finding was source-derived; no independent failing executable oracle was
retained or run.
The successor retains independent bounded per-conversation intents. Every write
captures a route/owner-epoch/intent-generation ticket; cross-route or superseded
callbacks cannot review or complete an intent. Successful receipt handling removes
only the saved input matching the pending message/event/client-key tuple, never
the currently rendered first row. Selection preserves other conversations'
uncertain requests. Explicit review advances that intent's generation; owner
change invalidates all tickets. Two author-written deterministic route/navigation cases
plus the six prior author-focused cases pass. They are new regressions, not an
unchanged independent oracle. Independent source review of the repair is pending;
a reviewer may add independent tests. This is not mounted browser verification.
