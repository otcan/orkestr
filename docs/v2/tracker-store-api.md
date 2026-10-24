# Conversation tracker persistence and API

The tracker records structured job evidence with scoped rows, immutable event
history and idempotent batch receipts. Schema74 is reserved for this stage;
provider-handoff schema73 must be integrated before a production train that
includes it. No operational migration is part of this change.

The authenticated owner can enable a tracker, edit rows with an exact revision,
merge rows, read the timeline and export CSV. An explicitly issued and revocable
tracker grant can read and add `assistant` notes to existing rows in its bound
conversation. Grant notes append immutable events with annotation digests, clamp future
timestamps to now and leave all row fields/revisions untouched; timeline counts
are derived from immutable history. Grants cannot change status, create rows, claim mail provenance
(`message_ref`, `thread_refs`, `requires_thread`, sender or evidence), or call scan
intake. Classified mail intake requires owner authority in this stage; a separate
trusted scan-action capability is deferred to the scan-action stage. Grant
requests cannot also carry browser cookies, Authorization or Origin. Browser
mutations retain the ordinary same-origin and CSRF boundary.

| Conversation route suffix | Action |
| --- | --- |
| `GET /tracker` | Bounded row page |
| `PUT /tracker` | Enable the configured recipe vocabulary |
| `POST /tracker/events` | Apply an idempotent bounded evidence batch |
| `GET /tracker/rows/{row}/events` | Read the original event timeline |
| `POST /tracker/rows/{row}` | Revision-checked owner edit |
| `POST /tracker/merge` | Logical merge with a repeatable receipt |
| `GET /tracker/export.csv` | UTF-8 CSV with formula-cell protection |
| `POST` or `DELETE /tracker/grant` | Explicit owner issue or revoke |

Every row reference carries the same owner and conversation through composite
foreign keys. A merge redirects active lookups and archives the absorbed row;
it preserves every original event ID and row ID. The combined timeline follows
immutable merge links. Repeating the same merge returns its stored receipt;
changing the target of an already absorbed row refuses.

Untrusted extracted evidence that requires a known application thread can wait
for later Sent-mail evidence. The Store retains only a bounded extracted event,
source revision and hashed message references, never raw mail bodies. Up to128
pending events are reconsidered per transaction using a monotonically increasing
attempt order so an unmatched first page cannot starve later evidence. At most
1000 pending events per conversation are allowed. Pending evidence older than
30 days expires in bounded batches of128. At capacity the oldest pending item
is evicted from reconsideration; its immutable minimized evidence and a separate
append-only reason audit remain. A full5000-row tracker records a `row_limit`
hash audit instead of creating a row. Both paths commit ledger and cursor
progress atomically, expose `backlog_full` changes and page counters, and never
pretend overflow evidence became a row. Unknown thread evidence needs a stable
message reference and records the reason `missing_known_thread`.

Only pending evidence from the current source revision is eligible. Source
replacement quarantines prior pending evidence and increments its revision.
An in-flight scan must present the exact revision before cursor and evidence
can commit. Successfully recorded messages and terminal drops remain idempotent;
they are not reclassified by this pending-evidence mechanism. Row status and
manual-edit precedence still apply when evidence arrives late. Ordinary event
intake rejects `manual` labels and owner-only event kinds; only the authenticated
owner row-edit API can override status. Every changed company, role, link, notes,
archive/review flag or next step creates an immutable `edited` event (field names
and before/after hashes); status changes have their own event, including
`no_response`. Merge keeps the status with the latest status-event time, with
ties retaining the requested keep row. Every lookup excludes absorbed rows as destinations while resolving their retained
company/role keys through immutable merge links to the surviving row, including
multi-hop merges.

Mail evidence snippets are transient: event evidence and pending JSON retain
only SHA-256 evidence hashes and extracted structured fields. Owner notes stay
in the editable row; their text is not copied into audit events.

This stage provides Store methods and the structured API. Source selection,
mail reading, recipe installation, unattended scheduling, notifications and the
Tracker UI are later stages. Issuing a grant creates no provider input, process,
mailbox access or delivery authority. No grant is injected into model prompts
or a shared environment by this change.
