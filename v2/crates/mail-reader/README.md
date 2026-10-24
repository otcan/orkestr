# Local mail ingestion

This crate reads Thunderbird's existing local Inbox and Sent folders and emits
tracker events using the job-tracker recipe's deterministic rule pack. It does
not connect to mail servers, open credential stores, change mailbox flags or
write to mailbox files. Standard Linux, Snap, Flatpak, macOS and Windows profile
locations can be computed. Actual reads use Unix descriptor traversal; other
platforms refuse scans until an equivalent safe handle implementation is available.

Use `profile::discover`, `profile::inbox_folders` and `profile::sent_folders` to
select the configured profile's folders. Pass the explicit profile root and
folders to `scan_folders`, with Sent folders marked `outgoing`. Each path is
resolved beneath the opened profile descriptor. Symlinks, hardlinked mail files,
nonregular files and credential-file aliases are refused at discovery and open.
Persist the returned cursor only after consuming the
batch. `classify` returns evidence-backed events or a reason for dropping mail.
Mail contents are data; links and instructions in messages are never executed.

The default scan budget has a five-second elapsed-time deadline, examines 500
messages, permits 4 MiB per message, reads
64 MiB of mbox data per folder plus its small fingerprint, and waits two seconds
after a file changes. Create fresh limits per invocation. Deadline checks occur
between bounded reads and messages; a blocking OS read still requires the
server's dedicated reader-pool custody. Expiry returns the cursor at the last
completed message and preserves unvisited folder cursors. Old and expunged
messages also consume the message budget.
Maildir discovery enumerates folder entries; its persisted seen set is capped
at 100,000 names. Above that cap, cyclic traversal can revisit mail, so consumers
must deduplicate events by `message_ref`. Mbox checkpoints include the head,
bytes before the cursor and the last separator line, so compaction followed by
growth can force an idempotent rescan. Legacy head-only cursors also rescan.

Authentication results are assertions from a configured receiving MTA, rather
than cryptographic verification by this crate. Only the topmost
`Authentication-Results` field from an explicitly trusted `authserv-id` counts;
an empty trust list trusts none. Configure that list for the actual receiving
provider and its header-stripping policy. The shipped recipe uses `mx.google.com`.
Signing domains must equal the sender domain or be a parent/child of it; sibling
domains are refused. See [RFC 8601's trust boundary](https://www.rfc-editor.org/rfc/rfc8601.html#section-1.2).

Sent applications establish primary evidence. Untrusted inbound status changes
require a reference to a known application thread. That cross-message check is
the consuming store's responsibility; this crate marks it with `requires_thread`.
The synthetic fixture suite uses reserved agency and personal-mail domains and
covers 43 incoming/outgoing examples, plus mailbox,
MIME, date, cursor and authentication regressions.
