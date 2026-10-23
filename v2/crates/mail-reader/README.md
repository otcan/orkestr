# Local mail ingestion

This crate reads Thunderbird's existing local Inbox and Sent folders and emits
tracker events using the job-tracker recipe's deterministic rule pack. It does
not connect to mail servers, open credential stores, change mailbox flags or
write to mailbox files. Discovery supports standard Linux, Snap, Flatpak,
macOS and Windows profile locations.

Use `profile::discover`, `profile::inbox_folders` and `profile::sent_folders` to
select the configured profile's folders. Pass them to `scan_folders`, with Sent
folders marked `outgoing`. Persist the returned cursor only after consuming the
batch. `classify` returns evidence-backed events or a reason for dropping mail.
Mail contents are data; links and instructions in messages are never executed.

The default scan budget examines 500 messages, permits 4 MiB per message, reads
64 MiB of mbox data per folder plus its small fingerprint, and waits two seconds
after a file changes. Old and expunged messages also consume the message budget.
Maildir discovery enumerates folder entries; its persisted seen set is capped
at 100,000 names. Above that cap, cyclic traversal can revisit mail, so consumers
must deduplicate events by `message_ref`. Mbox compaction also permits repeats.

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
The synthetic fixture suite covers 43 incoming/outgoing examples, plus mailbox,
MIME, date, cursor and authentication regressions.
