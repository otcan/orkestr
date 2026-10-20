# Beta UI checkpoint

The beta shell lists many conversations, each with a read-only status badge
(Working, Starting, Stopping, Reply ready, Failed, Needs attention, Queued #N)
and an owner-wide work-slot summary. The badges come from each listed
conversation's `GET …/execution` and `GET …/window/queue`, read once every
10 seconds while the list is mounted. Per conversation the tabs are Chat, Work
(configured provider and role, Stop/Steer availability, Deep run with worker
tasks, window and queue state, independent Workers), History, Projects (list,
create, open project conversation), Timers, Memory, Live map, Host resources
and Settings.
Native setup/sign-in, editable drafts, reconnect, canonical and archived
history, held inputs, saved thread files, progress, Fast replies, owner
acceptance, Stop and capability-gated steering reuse the existing flows.
Model and reasoning effort are fixed by server configuration; no
per-conversation selection is offered until the server exposes one. External
reply controls stay unmounted. Below 52rem the conversation list is a drawer
with a scrim, and the tabs scroll horizontally.

Live map is owner-wide and read-only. It polls `GET /api/v2/live-map` every
10 seconds and shows a tree: view (WhatsApp group) → V1 thread and, when the
view is delegated to V2, its native conversation with window, Fast, Deep and
Worker states → attached sessions (Claude Code, Codex; live or idle, last
activity) → their agents (running or finished). "Active only" (default) hides
idle views, idle sessions and finished agents; "All" shows everything. Native
conversations no view links to are listed separately. The view data comes from
an operator-configured external JSON file named by the server's
`ORKESTR_V2_LIVE_MAP` environment key (service plan key `live_map`). Unset, the
endpoint answers 404 `live_map_unconfigured` and the page says so. The server
opens the file read-only, refuses anything over 4 MiB or outside the schema
bounds, and never forwards the generator's `transcript` paths.

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
clear this private page state. Reload recovery: unsent drafts, the
pending send's original client key, retained intake receipts and the exact
uncertain window request are kept in tab-scoped `sessionStorage` under the
owner's namespace (`orkestr.v2.page.<global conversation>`), bounded to 2 MiB
and 64 drafts. After a full reload they are re-validated and restored without
overwriting newer page memory; continuing still needs an explicit Retry send,
which resends the original tuple. Sign-out removes the stored state; session
expiry keeps it for the same owner.

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

Accepted reply history consumes the exact `a38f55d98` read-only contract. Conversation
and History mount separate accepted-reply sections, with ascending 20-row pages,
explicit refresh and continuation. These records retain run/completion/acceptance
provenance; they are not fabricated assistant messages. Protected payload reads
must match conversation, run and payload reference. Missing output and removed
output are distinct. Visible payloads revalidate every five seconds; a confirmed
tombstone cannot be replaced by delayed text. Internal IDs are optional details.
Owner/session generation and component retirement fence callbacks and abort the
owned request. Pagination cursors retain full i64 precision as decimal URL text.
At most 20 payload readers are mounted per section, each with finite byte/read/time
bounds. No historical result grants execution or acceptance authority.

Author validation: three focused Rust accepted-result cases, nine Node transport
cases, and wrapper locked/offline UI binary check pass. Initial checks found a
wrong delay-helper argument and a test-only unavailable uuid import; both were
corrected before these passing checks. No accepted-results Store query execution,
HTTP integration, reload/browser rendering, paired build or provider acceptance
is claimed by this consumer checkpoint. Runtime owns the read route and Core owns
the query; matching integration and independent browser proof remain required.
