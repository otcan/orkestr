# Conversation tracker persistence and API

The tracker records structured job evidence with scoped rows, immutable event
history and idempotent batch receipts. Schema74 is reserved for this stage;
provider-handoff schema73 must be integrated before a production train that
includes it. No operational migration is part of this change.

The authenticated owner can enable a tracker, edit rows with an exact revision,
merge rows, read the timeline and export CSV. An explicitly issued and revocable
tracker grant can read or record evidence only for its bound conversation. Grant
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
1000 pending events per conversation are allowed. Capacity refusal rolls back
the transaction rather than advancing a cursor over lost evidence. Unknown
thread evidence needs a stable message reference to enter this queue.

Only pending evidence from the current source revision is eligible. Source
replacement quarantines prior pending evidence and increments its revision.
An in-flight scan must present the exact revision before cursor and evidence
can commit. Successfully recorded messages and terminal drops remain idempotent;
they are not reclassified by this pending-evidence mechanism. Row status and
manual-edit precedence still apply when evidence arrives late.

This stage provides Store methods and the structured API. Source selection,
mail reading, recipe installation, unattended scheduling, notifications and the
Tracker UI are later stages. Issuing a grant creates no provider input, process,
mailbox access or delivery authority. No grant is injected into model prompts
or a shared environment by this change.
