# Stop holds prior owner input

Schema 25 records `production_stop_boundaries` and `production_held_inputs`.
A fresh Deep cancellation transaction records the canonical cancellation EventId
and its preceding conversation sequence as the boundary. All unconsumed inbox
rows through that cut become held, including already leased claims. Original
inbox rows/messages/events are retained unchanged. Repeated cancellation returns
its original receipt without extending the cut. Worker/Fast cancellation does
not hold the independent Deep inbox.

Claim and admission exclude held rows. An old leased claim cannot bypass the
hold. New owner input beyond the cut may be claimed in ordinary sequence after
all other readiness/lease/Stop fences permit it. It does not release prior input.
Fresh Fast admission also refuses a held source; historical replay remains
historical. No implicit resume/delete operation is implemented.

The browser `GET /api/v2/conversations/{id}/held-inputs` uses the unbound
`Store::held_owner_inputs_for_browser` projection. Its read transaction derives
the owner from the current, unexpired browser session and checks conversation
ownership. It remains readable after the original window/supervisor retires and
after a fresh server process opens the same ledger. It creates no execution
context, grant, window or hold-release authority. Cookie namespace and Host
checks remain in the browser controller; Bearer credentials are refused there.

`Store::held_owner_inputs_authenticated(credential, conversation, after_sequence,
limit)` remains the separate machine-context eligibility read. It requires both
current session auth and the bound supervisor's existing generation/lease fences.
Both paths share the immutable `HeldOwnerInputPage` projection.
Limit is 1..100 and sequence is an exclusive
inbox cursor, not a journal cursor. Rows identify exact message/source event,
reason `stop_boundary`, boundary run/event and through-sequence. The page's
`eligible_input_available` means unheld unconsumed input exists, not native
readiness, safe restart or dispatch authority. Server composition may wait on it
before spending a one-use stopped metadata reservation. Queue age excludes held
input. Auth/revocation and selection-generation fencing remain mandatory.

Upgrade applies historical Deep Stop boundaries to still-unconsumed rows only;
no completed history is undone. Independent process/upgrade qualification is
separate from authored transaction tests. Schema 26 is reserved for the delegated
Worker task ledger and schema 27 for dormant timers.
